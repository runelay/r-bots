import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { BotTool } from "../../engine/services/bot-tools.service";
import { blobText, putBlob } from "../../storage/services/storage.service";
import {
  artifactContentKey,
  hasArtifactVersion,
  listArtifactRows,
  readArtifactRow,
  saveArtifactRow,
} from "../repositories/artifacts.repository";

export type ArtifactKind = "slides" | "dashboard" | "page" | "canvas";

export interface ArtifactVersion {
  n: number;
  createdAt: string;
  size: number;
  author?: "bot" | "user";
}

export interface ArtifactMeta {
  id: string;
  botId: string;
  title: string;
  kind: ArtifactKind;
  createdAt: string;
  updatedAt: string;
  versions: ArtifactVersion[];
  canvas?: { seen: number; notified: number };
}

export interface ArtifactEvent {
  type: "artifact.created" | "artifact.updated";
  data: { artifactId: string; title: string; kind: ArtifactKind; version: number; author?: "bot" | "user" };
}

const kinds = ["slides", "dashboard", "page"] as const;
const maxHtml = 600_000;
const idPattern = /^art_[A-Za-z0-9_-]{6,40}$/;

export const artifactCsp = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "font-src https://fonts.gstatic.com data:",
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const kindLabel: Record<ArtifactKind, string> = {
  slides: "apresentação",
  dashboard: "dashboard",
  page: "página",
  canvas: "canvas",
};

export function isArtifactId(value: string) {
  return idPattern.test(value);
}

export async function writeArtifactContent(
  meta: Pick<ArtifactMeta, "botId" | "id" | "kind">,
  version: number,
  content: string,
) {
  await putBlob(artifactContentKey(meta.botId, meta.id, version, meta.kind), content, {
    mime: meta.kind === "canvas" ? "application/json" : "text/html; charset=utf-8",
    botId: meta.botId,
  });
}

export async function readArtifactContent(meta: Pick<ArtifactMeta, "botId" | "id" | "kind">, version: number) {
  if (!Number.isInteger(version) || version < 1 || !hasArtifactVersion(meta.id, version)) return null;
  return blobText(artifactContentKey(meta.botId, meta.id, version, meta.kind));
}

export async function saveArtifactMeta(meta: ArtifactMeta) {
  saveArtifactRow(meta);
}

export async function readArtifact(botId: string, artifactId: string): Promise<ArtifactMeta | null> {
  if (!isArtifactId(artifactId)) return null;
  return readArtifactRow(botId, artifactId);
}

export async function listArtifacts(botId: string): Promise<ArtifactMeta[]> {
  return listArtifactRows(botId);
}

export async function readArtifactHtml(botId: string, artifactId: string, version: number) {
  if (!isArtifactId(artifactId)) return null;
  const meta = readArtifactRow(botId, artifactId);
  if (!meta) return null;
  return readArtifactContent(meta, version);
}

export function publicArtifact(meta: ArtifactMeta) {
  const latest = meta.versions[meta.versions.length - 1]?.n ?? 1;
  const base = `/bots/${meta.botId}/artifacts/${meta.id}`;
  const ext = meta.kind === "canvas" ? "json" : "html";
  return {
    id: meta.id,
    title: meta.title,
    kind: meta.kind,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    version: latest,
    url: `${base}/v/${latest}.${ext}`,
    versions: meta.versions.map((item) => ({
      ...item,
      author: item.author ?? "bot",
      url: `${base}/v/${item.n}.${ext}`,
    })),
  };
}

function checkHtml(html: string) {
  if (html.length > maxHtml) throw new Error(`HTML grande demais (${html.length} caracteres, máximo ${maxHtml}).`);
  if (!/<html[\s>]|<body[\s>]|<!doctype html>/i.test(html))
    throw new Error("Mande um documento HTML completo, com <!doctype html>, <head> e <body>.");
}

export async function createArtifact(botId: string, title: string, kind: ArtifactKind, html: string) {
  checkHtml(html);
  const id = `art_${randomBytes(9).toString("base64url")}`;
  const now = new Date().toISOString();
  const meta: ArtifactMeta = {
    id,
    botId,
    title,
    kind,
    createdAt: now,
    updatedAt: now,
    versions: [{ n: 1, createdAt: now, size: Buffer.byteLength(html) }],
  };
  await writeArtifactContent(meta, 1, html);
  await saveArtifactMeta(meta);
  return meta;
}

export async function updateArtifact(
  botId: string,
  artifactId: string,
  change: { html?: string; edits?: { old: string; new: string }[]; title?: string },
) {
  const meta = await readArtifact(botId, artifactId);
  if (!meta) throw new Error(`Não existe artefato ${artifactId}. Use artifact_create.`);
  if (meta.kind === "canvas") throw new Error("Esse artefato é um canvas. Use canvas_read e canvas_update.");
  const latest = meta.versions[meta.versions.length - 1].n;
  let html = change.html;
  if (html === undefined) {
    if (!change.edits?.length) throw new Error("Mande html ou edits.");
    html = (await readArtifactHtml(botId, artifactId, latest)) ?? "";
    for (const [index, edit] of change.edits.entries()) {
      const at = html.indexOf(edit.old);
      if (at < 0) throw new Error(`Edição ${index + 1}: o trecho "old" não foi encontrado na versão ${latest}.`);
      if (html.indexOf(edit.old, at + edit.old.length) >= 0)
        throw new Error(`Edição ${index + 1}: o trecho "old" aparece mais de uma vez; mande um trecho maior.`);
      html = html.slice(0, at) + edit.new + html.slice(at + edit.old.length);
    }
  }
  checkHtml(html);
  const n = latest + 1;
  const now = new Date().toISOString();
  await writeArtifactContent(meta, n, html);
  const next: ArtifactMeta = {
    ...meta,
    title: change.title?.trim() || meta.title,
    updatedAt: now,
    versions: [...meta.versions, { n, createdAt: now, size: Buffer.byteLength(html) }],
  };
  await saveArtifactMeta(next);
  return next;
}

export function eventOf(type: ArtifactEvent["type"], meta: ArtifactMeta): ArtifactEvent {
  const last = meta.versions[meta.versions.length - 1];
  return {
    type,
    data: { artifactId: meta.id, title: meta.title, kind: meta.kind, version: last.n, author: last.author ?? "bot" },
  };
}

export function artifactEventOf(output: unknown): ArtifactEvent | null {
  if (!output || typeof output !== "object" || !("artifactEvent" in output)) return null;
  return (output as { artifactEvent: ArtifactEvent }).artifactEvent;
}

export function artifactTools(botId: string): BotTool[] {
  return [
    {
      name: "artifact_create",
      description:
        "Cria um artefato visual (apresentação, dashboard ou página) que a pessoa vê renderizado no app. html é um documento HTML único e autocontido. Devolve o id para atualizar depois com artifact_update.",
      shape: {
        title: z.string().min(1).max(120),
        kind: z.enum(kinds),
        html: z.string().min(20).max(maxHtml),
      },
      approval: null,
      label: (input) =>
        `Criar ${kindLabel[(input.kind as ArtifactKind) ?? "page"] ?? "página"}: ${String(input.title ?? "")}`,
      run: async (input) => {
        const meta = await createArtifact(
          botId,
          String(input.title).trim(),
          input.kind as ArtifactKind,
          String(input.html),
        );
        return {
          artifactId: meta.id,
          title: meta.title,
          kind: meta.kind,
          version: 1,
          artifactEvent: eventOf("artifact.created", meta),
        };
      },
    },
    {
      name: "artifact_update",
      description:
        "Cria uma nova versão de um artefato. Mande html (documento inteiro) ou edits [{old, new}] com trechos exatos e únicos da última versão. Para mudanças pequenas prefira edits.",
      shape: {
        id: z.string().min(1),
        html: z.string().min(20).max(maxHtml).optional(),
        edits: z
          .array(z.object({ old: z.string().min(1), new: z.string() }))
          .min(1)
          .max(40)
          .optional(),
        title: z.string().min(1).max(120).optional(),
      },
      approval: null,
      label: () => "Atualizar artefato",
      run: async (input) => {
        const meta = await updateArtifact(botId, String(input.id), {
          ...(typeof input.html === "string" ? { html: input.html } : {}),
          ...(Array.isArray(input.edits) ? { edits: input.edits as { old: string; new: string }[] } : {}),
          ...(typeof input.title === "string" ? { title: input.title } : {}),
        });
        const version = meta.versions[meta.versions.length - 1].n;
        return {
          artifactId: meta.id,
          title: meta.title,
          kind: meta.kind,
          version,
          artifactEvent: eventOf("artifact.updated", meta),
        };
      },
    },
  ];
}

export const artifactGuide = [
  "## Artefatos visuais",
  "Quando a resposta fica melhor vista do que lida (apresentação, dashboard, relatório visual), monte um artefato com `artifact_create` e ajuste com `artifact_update`. A pessoa vê o resultado renderizado no app; na conversa, diga em uma frase o que montou, sem colar o HTML.",
  "- HTML único e autocontido: CSS e JS inline. Scripts só de cdnjs.cloudflare.com ou cdn.jsdelivr.net, com versão exata (ex.: https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js). Fontes só do Google Fonts. Nada de fetch, imagens externas ou iframes: a página roda bloqueada para fora. Imagem só como SVG inline ou data: URI.",
  "- Tema escuro elegante: fundo quase preto (#0b0d10), texto #e8eaed, texto secundário #9aa0a6, uma cor de destaque só. Fonte Inter (Google Fonts) ou system-ui. Responsivo do celular a 1920px.",
  '- slides: cada slide é um `<section class="slide">` de 16:9 que ocupa a tela inteira, um slide por seção do conteúdo, só um visível por vez. Navegação por setas ←/→ (e espaço, PageUp/PageDown), contador discreto "2 / 6" num canto. Exponha `window.slideCount` (número de slides) e `window.goToSlide(i)` (índice a partir de 0): o app usa isso para exportar um PDF com uma página por slide. Nada de animação longa.',
  "- dashboard: números-chave grandes no topo (KPI com rótulo curto), gráficos com Chart.js abaixo, legenda só quando houver mais de uma série. Grade que vira uma coluna no estreito.",
  "- page: relatório em uma coluna de leitura (até ~720px), títulos claros, tabelas limpas.",
  "- Nada inventado: só dado que veio das suas ferramentas ou da conversa. Se faltar dado, diga no próprio artefato o que faltou, sem preencher com exemplo.",
  "- Para corrigir, use `artifact_update` com edits pequenos; cada chamada vira uma versão nova que a pessoa pode comparar.",
  "",
  "### Guia de design",
  "- Hierarquia: um título por tela, uma ideia por slide, o número mais importante maior que tudo.",
  "- Poucas cores: neutros + um destaque; vermelho/verde só para sinal (piorou/melhorou).",
  "- Números grandes e tabulares (font-variant-numeric: tabular-nums), com unidade e período ao lado.",
  "- Espaço generoso, alinhamento a uma grade, cantos e espaçamentos consistentes.",
  '- Sem slop: nada de emoji decorativo, gradiente arco-íris, ícone genérico, card dentro de card, frase de efeito, "insights" vagos ou texto de enchimento. Cada elemento precisa dizer algo.',
].join("\n");
