import { runelayApi } from "../../connectors/services/runelay.service";

export interface SkillSummary {
  slug: string;
  name: string;
  description: string;
}

export interface LoadedSkill {
  slug: string;
  name: string;
  body: string;
  files: string[];
}

interface RawSkill {
  slug: string;
  name?: string;
  description?: string;
  enabled?: boolean;
}

interface RawPage {
  items: RawSkill[];
  nextCursor: number | string | null;
}

interface RawDetail extends RawSkill {
  body?: string;
  files?: Array<{ path: string }>;
}

export const skillSlugPattern = /^[a-z0-9][a-z0-9_.-]{0,119}$/;

function readableName(raw: RawSkill) {
  const name = (raw.name ?? "").trim();
  if (name && name !== raw.slug) return name;
  const words = raw.slug.replace(/[-_.]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function shortDescription(text: string) {
  const line = text.replace(/\s+/g, " ").trim();
  const sentence = line.split(/(?<=[.!?])\s/)[0] ?? line;
  return sentence.length > 140 ? `${sentence.slice(0, 139).trimEnd()}…` : sentence;
}

function summaryOf(raw: RawSkill): SkillSummary {
  return { slug: raw.slug, name: readableName(raw), description: shortDescription(raw.description ?? "") };
}

const listTtl = 60_000;
const searchTtl = 30_000;
let allCache: { at: number; list: SkillSummary[] } | null = null;
const searchCache = new Map<string, { at: number; list: SkillSummary[] }>();

async function fetchPages(query: string) {
  const found: SkillSummary[] = [];
  let cursor: number | string | null = null;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ limit: "100" });
    if (query) params.set("query", query);
    if (cursor !== null) params.set("cursor", String(cursor));
    const data: RawPage = await runelayApi<RawPage>("GET", `/skills?${params}`);
    for (const item of data?.items ?? []) if (item.enabled !== false) found.push(summaryOf(item));
    cursor = data?.nextCursor ?? null;
    if (cursor === null || query) break;
  }
  return found;
}

export async function listSkills(query: string, refresh = false): Promise<SkillSummary[]> {
  const term = query.trim().toLowerCase().slice(0, 100);
  if (!term) {
    if (!refresh && allCache && Date.now() - allCache.at < listTtl) return allCache.list;
    const list = (await fetchPages("")).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    allCache = { at: Date.now(), list };
    return list;
  }
  const hit = searchCache.get(term);
  if (!refresh && hit && Date.now() - hit.at < searchTtl) return hit.list;
  const list = await fetchPages(term);
  if (searchCache.size > 200) searchCache.clear();
  searchCache.set(term, { at: Date.now(), list });
  return list;
}

const detailCache = new Map<string, { at: number; skill: LoadedSkill }>();

export async function loadSkill(slug: string): Promise<LoadedSkill> {
  const hit = detailCache.get(slug);
  if (hit && Date.now() - hit.at < listTtl) return hit.skill;
  const raw = await runelayApi<RawDetail>("GET", `/skills/${encodeURIComponent(slug)}`);
  const skill = {
    slug: raw.slug,
    name: readableName(raw),
    body: raw.body ?? "",
    files: (raw.files ?? []).map((file) => file.path),
  };
  detailCache.set(slug, { at: Date.now(), skill });
  return skill;
}

const maxBody = 40_000;
const indexLimit = 200;

export async function skillsIndex(timeoutMs = 3000) {
  const list = await Promise.race([
    listSkills(""),
    new Promise<SkillSummary[]>((resolve) => setTimeout(() => resolve([]), timeoutMs)),
  ]).catch(() => []);
  if (list.length === 0) return "";
  const lines = list
    .slice(0, indexLimit)
    .map((skill) => `- \`${skill.slug}\`${skill.description ? `: ${skill.description}` : ""}`);
  const more =
    list.length > indexLimit ? `\n- e mais ${list.length - indexLimit}; ache com memory_search (kind skill).` : "";
  return `## Skills da pessoa\nSlug e para que serve. Quando a tarefa bater com uma delas, leia inteira com \`skill_read(slug)\` antes de começar e siga passo a passo.\n${lines.join("\n")}${more}`;
}

export function skillsBlock(skills: LoadedSkill[], canReadFiles: boolean) {
  return skills
    .map((skill) => {
      const body =
        skill.body.length > maxBody
          ? `${skill.body.slice(0, maxBody)}\n\n[cortado; leia o resto com skill_read(slug: "${skill.slug}") antes de seguir]`
          : skill.body;
      const files =
        skill.files.length === 0
          ? ""
          : canReadFiles
            ? `\n\nArquivos da skill: ${skill.files.slice(0, 60).join(", ")}${skill.files.length > 60 ? ", …" : ""}.\nQuando um passo citar um arquivo (scripts/, references/, templates), leia com skill_read(slug: "${skill.slug}", path) antes de executar o passo e use o que ele traz; não improvise no lugar de um script ou modelo da skill.`
            : "";
      return `## Siga a skill ${skill.name} (\`${skill.slug}\`)\nA pessoa anexou esta skill à mensagem. Siga as instruções dela até concluir o pedido, inclusive nas próximas mensagens sobre a mesma tarefa.\n\n${body}${files}`;
    })
    .join("\n\n");
}
