import type { Account } from "../../accounts/services/accounts.service";
import { activeWorkspace, changedFiles } from "../../code/services/workspace.service";
import { summarizeForReset } from "../../memory/services/memory.service";
import type { Fact, StoredSession } from "./sessions.service";

export type ItemKind =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "code_edit"
  | "approval"
  | "artifact"
  | "file"
  | "delegation"
  | "workspace"
  | "turn_error"
  | "account";

export interface ThreadItem {
  id: string;
  kind: ItemKind;
  role: "user" | "assistant" | "system";
  turnId: string;
  at: string;
  text: string;
  brief: string;
  pending?: boolean;
  meta?: Record<string, unknown>;
}

export interface HandoffState {
  summary: string;
  lastItemId: string;
  updatedAt: string;
}

const budgetChars = Number(process.env.BOTS_HANDOFF_CHARS ?? 40_000);
const timelineChars = 6_000;
const maxOmittedIds = 60;
const readChunk = 4_000;
const keepRecent = 24;
const summaryBatch = 12;
const summaryInputChars = 30_000;

export function turnNumber(turnId: string) {
  if (!turnId) return -1;
  const value = Number(turnId.replace(/^turn_/, ""));
  return Number.isFinite(value) ? value : -1;
}

function oneLine(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function clipBlock(text: string, max: number) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n… (${text.length - max} caracteres omitidos; íntegra no thread_read) …\n${text.slice(-tail)}`;
}

function asText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { stdout?: unknown }).stdout === "string"
  ) {
    const shell = value as { stdout: string; stderr?: string; exitCode?: number; code?: number };
    const exit = shell.exitCode ?? shell.code;
    return [
      shell.stdout,
      shell.stderr ? `stderr:\n${shell.stderr}` : "",
      exit !== undefined ? `Exit code: ${exit}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (Array.isArray(value) && value.every((part) => part && typeof part === "object" && "text" in part)) {
    return value.map((part) => String((part as { text: unknown }).text ?? "")).join("\n");
  }
  try {
    return JSON.stringify(value, null, 1);
  } catch {
    return String(value);
  }
}

function hunkText(hunks: unknown) {
  if (!Array.isArray(hunks)) return "";
  return hunks
    .map((hunk) => {
      const value = hunk as {
        oldStart?: number;
        oldLines?: number;
        newStart?: number;
        newLines?: number;
        lines?: string[];
      };
      return [
        `@@ -${value.oldStart ?? 0},${value.oldLines ?? 0} +${value.newStart ?? 0},${value.newLines ?? 0} @@`,
        ...(value.lines ?? []),
      ].join("\n");
    })
    .join("\n");
}

interface CallStart {
  name: string;
  label: string;
  input: unknown;
}

export async function threadItems(session: StoredSession): Promise<ThreadItem[]> {
  const reverted = new Set(session.meta.revertedTurns ?? []);
  const items: ThreadItem[] = [];
  const byId = new Map<string, ThreadItem>();
  const calls = new Map<string, CallStart>();
  let lastTurn = "";
  const put = (item: ThreadItem) => {
    const existing = byId.get(item.id);
    if (existing) {
      Object.assign(existing, item);
      return;
    }
    byId.set(item.id, item);
    items.push(item);
  };
  for (const line of await session.log.lines()) {
    let parsed: { at?: string; facts?: Fact[] };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const at = parsed.at ?? "";
    for (const fact of parsed.facts ?? []) {
      const data = fact.data ?? {};
      const turnId = String(fact.scope?.turnId ?? data.turnId ?? "") || lastTurn;
      lastTurn = turnId;
      if (turnId && reverted.has(turnId)) continue;
      switch (fact.type) {
        case "delivery.consumed": {
          if (data.source === "schedule") break;
          const parts = (data.parts as Array<{ text?: string }> | undefined) ?? [];
          const from = (data.from as { name?: string } | undefined)?.name;
          const skills = ((data.skills as Array<{ name?: string }> | undefined) ?? [])
            .map((skill) => skill.name)
            .filter(Boolean);
          const attachments = (
            (data.attachments as Array<{ name?: string; kind?: string; uploadId?: string }> | undefined) ?? []
          ).map((item) => `${item.name} (${item.kind}, ${item.uploadId})`);
          const body = parts
            .map((part) => part.text ?? "")
            .join("\n")
            .trim();
          const text = [
            from ? `${from} (bot do time) pediu:` : "",
            body,
            skills.length ? `Skills anexadas: ${skills.join(", ")}.` : "",
            attachments.length ? `Anexos: ${attachments.join("; ")}.` : "",
          ]
            .filter(Boolean)
            .join("\n");
          put({
            id: `u_${turnId}`,
            kind: "user_message",
            role: "user",
            turnId,
            at,
            text,
            brief: oneLine(text, 400),
            meta: { attachments: data.attachments ?? [], skills },
          });
          break;
        }
        case "content.completed": {
          if (data.kind !== "text") break;
          const value = String(data.value ?? "");
          if (!value.trim()) break;
          const narration = data.phase !== "reply";
          put({
            id: `a_${data.partId}`,
            kind: "assistant_message",
            role: "assistant",
            turnId,
            at,
            text: value,
            brief: `${narration ? "(narração) " : ""}${oneLine(value, 400)}`,
          });
          break;
        }
        case "call.requested": {
          const capability = (data.capability as { name?: string; label?: string } | undefined) ?? {};
          calls.set(String(data.callId), {
            name: String(capability.name ?? "ferramenta"),
            label: String(capability.label ?? ""),
            input: data.input ?? {},
          });
          break;
        }
        case "call.settled": {
          const callId = String(data.callId);
          const start = calls.get(callId);
          if (!start) break;
          const outcome = String(data.outcome ?? "completed");
          const error = (data.error as { message?: string } | undefined)?.message;
          const input = start.input as Record<string, unknown>;
          const output = asText(data.output);
          const command = typeof input?.command === "string" ? input.command : null;
          const head = command
            ? `Comando: ${command}`
            : `Ferramenta: ${start.name}${start.label ? ` (${start.label})` : ""}\nEntrada: ${asText(input)}`;
          const result =
            outcome === "completed"
              ? `Resultado:\n${output || "(vazio)"}`
              : `Resultado (${outcome}): ${error ?? (output || "sem detalhe")}`;
          put({
            id: `t_${callId}`,
            kind: "tool_call",
            role: "assistant",
            turnId,
            at,
            text: `${head}\n${result}`,
            brief: `${start.label || start.name} → ${outcome === "completed" ? oneLine(output || "ok", 300) : `${outcome}: ${oneLine(error ?? output, 200)}`}`,
            meta: {
              name: start.name,
              label: start.label,
              input: oneLine(command ?? asText(input), 600),
              output,
              outcome,
              error,
            },
          });
          break;
        }
        case "code.edit": {
          const path = String(data.path ?? "");
          const added = Number(data.added ?? 0);
          const removed = Number(data.removed ?? 0);
          const flag = data.created ? " (novo)" : data.deleted ? " (apagado)" : "";
          const brief = `${path} +${added} −${removed}${flag}`;
          put({
            id: `e_${turnId}:${path}`,
            kind: "code_edit",
            role: "assistant",
            turnId,
            at,
            text: `Arquivo ${brief}\n${hunkText(data.hunks)}`,
            brief,
          });
          break;
        }
        case "interaction.opened": {
          const request = (data.request as { prompt?: string; kind?: string } | undefined) ?? {};
          const prompt =
            request.kind === "secret" ? "Pedido de segredo pelo formulário seguro." : String(request.prompt ?? "");
          put({
            id: `p_${data.interactionId}`,
            kind: "approval",
            role: "system",
            turnId,
            at,
            text: `Aprovação pedida: ${prompt}`,
            brief: `Aprovação pedida: ${oneLine(prompt, 240)} (pendente)`,
            pending: true,
          });
          break;
        }
        case "interaction.settled": {
          const existing = byId.get(`p_${data.interactionId}`);
          if (!existing) break;
          const outcome =
            { accepted: "aprovada", declined: "negada", withdrawn: "retirada" }[String(data.outcome)] ??
            String(data.outcome);
          existing.pending = false;
          existing.text = `${existing.text}\nResposta: ${outcome}.`;
          existing.brief = existing.brief.replace("(pendente)", `(${outcome})`);
          break;
        }
        case "artifact.created":
        case "artifact.updated": {
          const text = `Artefato “${data.title}” (${data.kind}) versão ${data.version}, id ${data.artifactId}.`;
          put({
            id: `r_${data.artifactId}_v${data.version}`,
            kind: "artifact",
            role: "assistant",
            turnId,
            at,
            text,
            brief: text,
            meta: { artifactId: data.artifactId, title: data.title, kind: data.kind, version: data.version },
          });
          break;
        }
        case "file.sent": {
          const attachment =
            (data.attachment as
              | { uploadId?: string; name?: string; mime?: string; kind?: string; url?: string }
              | undefined) ?? {};
          const text = `Arquivo enviado à pessoa: ${attachment.name} (${attachment.mime}, ${attachment.uploadId}).`;
          put({
            id: `f_${attachment.uploadId}`,
            kind: "file",
            role: "assistant",
            turnId,
            at,
            text,
            brief: text,
            meta: { ...attachment },
          });
          break;
        }
        case "delegation.updated": {
          const status = String(data.status);
          if (!["completed", "failed", "cancelled"].includes(status)) break;
          const detail = String(data.summary ?? data.error ?? "");
          const text = `Delegação para ${data.botId}: ${status}${detail ? `. ${detail}` : "."}`;
          put({
            id: `d_${data.callId}`,
            kind: "delegation",
            role: "assistant",
            turnId,
            at,
            text,
            brief: oneLine(text, 300),
          });
          break;
        }
        case "code.workspace": {
          if (!data.action || data.action === "failed") break;
          const text = `Repositório ${data.repoName ?? data.repo}: ${data.action}${data.branch ? `, branch ${data.branch}` : ""}${data.path ? `, worktree ${data.path}` : ""}.`;
          put({
            id: `w_${turnId || at}_${data.action}`,
            kind: "workspace",
            role: "system",
            turnId,
            at,
            text,
            brief: text,
          });
          break;
        }
        case "code.delivered": {
          const text = `Entrega do código: ${data.action}${data.commit ? `, commit ${data.commit}` : ""}${data.prUrl ? `, PR ${data.prUrl}` : ""}, ${data.files} arquivos na branch ${data.branch}.`;
          put({
            id: `w_${data.commit ?? at}_delivered`,
            kind: "workspace",
            role: "system",
            turnId,
            at,
            text,
            brief: text,
          });
          break;
        }
        case "account.failover": {
          const text = String(data.line ?? "Troca de conta.");
          put({ id: `x_${turnId}_failover`, kind: "account", role: "system", turnId, at, text, brief: text });
          break;
        }
        case "turn.settled": {
          if (data.outcome !== "failed" && data.outcome !== "cancelled") break;
          const message =
            (data.error as { message?: string } | undefined)?.message ?? (data.reason as string | undefined) ?? "";
          const text =
            data.outcome === "failed"
              ? `O turno falhou: ${message || "sem detalhe"}`
              : `Turno interrompido${message ? `: ${message}` : ""}.`;
          put({ id: `x_${turnId}`, kind: "turn_error", role: "system", turnId, at, text, brief: oneLine(text, 300) });
          break;
        }
      }
    }
  }
  return items;
}

const roleLabel: Record<ThreadItem["role"], string> = { user: "pessoa", assistant: "você", system: "sistema" };

function intactText(item: ThreadItem) {
  if (item.kind === "tool_call") {
    const meta = item.meta ?? {};
    const head =
      String(meta.name) === "Bash" || /^Comando:/.test(item.text)
        ? `Comando: ${meta.input}`
        : `Ferramenta: ${meta.name}${meta.label ? ` (${meta.label})` : ""}\nEntrada: ${meta.input}`;
    const output = String(meta.output ?? "");
    const result =
      meta.outcome === "completed"
        ? `Resultado (resumido):\n${clipBlock(output || "(vazio)", 1_500)}`
        : `Resultado (${meta.outcome}): ${oneLine(String(meta.error ?? output), 400)}`;
    return `${head}\n${result}`;
  }
  if (item.kind === "code_edit") return `Arquivo ${item.brief} (diff no thread_read)`;
  return item.text;
}

function renderItem(item: ThreadItem) {
  return `[Histórico; ${roleLabel[item.role]}; ${item.kind}; item=${item.id}; ${item.turnId || "-"}]\n${intactText(item)}`;
}

function selectItems(items: ThreadItem[], budget: number) {
  const chosen = new Set<number>();
  let used = 0;
  const tryAdd = (index: number) => {
    if (index < 0 || chosen.has(index)) return;
    const cost = renderItem(items[index]).length + 2;
    if (cost > budget / 3 || used + cost > budget) return;
    chosen.add(index);
    used += cost;
  };
  const lastOf = (kind: ItemKind) => items.findLastIndex((item) => item.kind === kind);
  tryAdd(lastOf("user_message"));
  tryAdd(lastOf("assistant_message"));
  tryAdd(items.findIndex((item) => item.kind === "user_message"));
  for (let index = items.length - 1; index >= 0 && used < budget; index--) tryAdd(index);
  return [...chosen].sort((left, right) => left - right);
}

export interface HandoffOptions {
  key: string;
  currentTurnId: string;
  skills?: string[];
  reason?: string;
  full?: boolean;
}

export function handoffMode(session: StoredSession, key: string) {
  const meta = session.meta;
  if (!meta.providerSessions?.[key]) return { mode: "full" as const, since: -1 };
  const synced = meta.providerSynced?.[key];
  if (!synced) return null;
  return { mode: "delta" as const, since: turnNumber(synced) };
}

async function stateBlock(session: StoredSession, items: ThreadItem[], skills: string[], currentTurnId: string) {
  const lines: string[] = [];
  const workspace = activeWorkspace(session);
  if (workspace) {
    lines.push(
      `- Repositório aberto: ${workspace.repoName}, branch ${workspace.branch} (base ${workspace.base}), worktree ${workspace.path}.`,
    );
    const files = await changedFiles(workspace).catch(() => []);
    if (files.length > 0) {
      const added = files.reduce((sum, file) => sum + file.added, 0);
      const removed = files.reduce((sum, file) => sum + file.removed, 0);
      const shown = files.slice(0, 30).map((file) => `${file.path} +${file.added} −${file.removed}`);
      lines.push(
        `- Arquivos mudados na worktree (${files.length}, +${added} −${removed}): ${shown.join("; ")}${files.length > 30 ? `; e mais ${files.length - 30}` : ""}.`,
      );
    } else {
      lines.push("- Nenhum arquivo mudado na worktree.");
    }
  }
  const pending = items.filter((item) => item.kind === "approval" && item.pending && item.turnId === currentTurnId);
  if (pending.length > 0)
    lines.push(
      `- Aprovações pendentes: ${pending.map((item) => `${item.id} (${oneLine(item.text, 160)})`).join("; ")}.`,
    );
  const declined = items.filter((item) => item.kind === "approval" && /\(negada\)$/.test(item.brief)).slice(-3);
  if (declined.length > 0)
    lines.push(
      `- Aprovações negadas recentemente (não insista sem a pessoa pedir): ${declined.map((item) => `${item.id} (${oneLine(item.text, 140)})`).join("; ")}.`,
    );
  const artifacts = new Map<string, ThreadItem>();
  for (const item of items) if (item.kind === "artifact") artifacts.set(String(item.meta?.artifactId), item);
  const recentArtifacts = [...artifacts.values()].slice(-5);
  if (recentArtifacts.length > 0)
    lines.push(
      `- Artefatos recentes: ${recentArtifacts.map((item) => `“${item.meta?.title}” (${item.meta?.kind}, v${item.meta?.version}, ${item.meta?.artifactId})`).join("; ")}.`,
    );
  const uploads: string[] = [];
  for (const item of items) {
    if (item.kind === "user_message")
      for (const file of (item.meta?.attachments as Array<{ name?: string; kind?: string; uploadId?: string }>) ?? [])
        uploads.push(`${file.name} (da pessoa, ${file.kind}, ${file.uploadId})`);
    if (item.kind === "file") uploads.push(`${item.meta?.name} (enviado por você, ${item.meta?.uploadId})`);
  }
  if (uploads.length > 0) lines.push(`- Anexos recentes: ${uploads.slice(-5).join("; ")}.`);
  if (skills.length > 0) lines.push(`- Skills anexadas ao pedido em curso: ${skills.join(", ")}.`);
  return lines.length > 0 ? `Estado atual:\n${lines.join("\n")}` : "";
}

export async function handoffBlock(session: StoredSession, options: HandoffOptions) {
  const mode = options.full ? { mode: "full" as const, since: -1 } : handoffMode(session, options.key);
  if (!mode) return "";
  const all = await threadItems(session);
  const visible = all.filter(
    (item) => item.id !== `u_${options.currentTurnId}` && turnNumber(item.turnId) > mode.since,
  );
  const state = await stateBlock(session, all, options.skills ?? [], options.currentTurnId);
  if (visible.length === 0) {
    if (mode.mode === "delta") return "";
    return state ? `## Contexto da conversa (handoff)\n${state}` : "";
  }
  const summaryState = session.meta.handoff;
  const summaryIndex =
    mode.mode === "full" && summaryState ? visible.findIndex((item) => item.id === summaryState.lastItemId) : -1;
  const summary = mode.mode === "full" && summaryState?.summary ? summaryState.summary : "";
  const reserve = summary.length + state.length + 2_000;
  const chosen = selectItems(visible, Math.max(8_000, budgetChars - reserve - timelineChars));
  const chosenSet = new Set(chosen);
  const omitted = visible.filter((_, index) => !chosenSet.has(index));
  const firstChosen = chosen[0] ?? visible.length;
  const gap = visible.filter((_, index) => index > summaryIndex && index < firstChosen && !chosenSet.has(index));
  const timeline: string[] = [];
  let timelineUsed = 0;
  for (let index = gap.length - 1; index >= 0; index--) {
    const line = `- ${gap[index].id} (${roleLabel[gap[index].role]}): ${oneLine(gap[index].brief, 180)}`;
    if (timelineUsed + line.length > timelineChars) break;
    timeline.unshift(line);
    timelineUsed += line.length;
  }
  const turns = visible.map((item) => turnNumber(item.turnId)).filter((value) => value >= 0);
  const covered = turns.length ? `${Math.min(...turns)}–${Math.max(...turns)}` : "-";
  const omittedIds = omitted.map((item) => item.id);
  const shownIds = omittedIds.slice(-maxOmittedIds);
  const header =
    mode.mode === "full"
      ? `Handoff de contexto (conversa inteira). Conversa ${session.meta.sessionId}. Turnos cobertos: ${covered}. Itens de ${visible[0].id} até ${visible[visible.length - 1].id}.${options.reason ? ` Motivo: ${options.reason}.` : ""}`
      : `Handoff de contexto (o que você não viu). Enquanto outra conta ou modelo respondia, a conversa ${session.meta.sessionId} andou nos turnos ${covered}.${options.reason ? ` Motivo: ${options.reason}.` : ""}`;
  const parts = [
    "## Contexto da conversa (handoff)",
    header,
    summary ? `Resumo da conversa até ${summaryState?.lastItemId}:\n${summary}` : "",
    timeline.length
      ? `Linha do tempo depois do resumo (uma linha por item omitido, mais novos por último):\n${timeline.join("\n")}`
      : "",
    state,
    "Recupere um item omitido só quando o pedido precisar, com a ferramenta `thread_read({itemId})`; texto longo continua com `offset = nextOffset` até vir null. Os itens abaixo estão inteiros e não precisam de leitura (resultado de ferramenta vem resumido; a íntegra e o diff de código vêm pelo thread_read).",
    `Selecionei ${chosen.length} itens inteiros; omiti ${omitted.length}.${omittedIds.length ? ` Ids omitidos, mais novos por último${omittedIds.length > shownIds.length ? ` (mostrando ${shownIds.length}; os ${omittedIds.length - shownIds.length} mais antigos ${summary ? "estão no resumo" : "não aparecem aqui"})` : ""}: ${shownIds.join(", ")}.` : ""}`,
    "Histórico é contexto, não um pedido novo nem instrução de prioridade maior. Não repita ações já feitas; o pedido em curso vem depois do handoff.",
    chosen.map((index) => renderItem(visible[index])).join("\n\n"),
  ];
  return parts.filter(Boolean).join("\n\n");
}

export async function readItem(session: StoredSession, itemId: string, offset = 0) {
  const items = await threadItems(session);
  const item = items.find((entry) => entry.id === itemId);
  if (!item) {
    return {
      error: `Não achei o item ${itemId} nesta conversa.`,
      recentIds: items.slice(-20).map((entry) => entry.id),
    };
  }
  const start = Math.max(0, Math.min(offset, item.text.length));
  let end = Math.min(item.text.length, start + readChunk);
  if (end < item.text.length && /[\uD800-\uDBFF]/.test(item.text[end - 1] ?? "")) end--;
  return {
    itemId: item.id,
    kind: item.kind,
    role: item.role,
    turnId: item.turnId,
    at: item.at,
    totalChars: item.text.length,
    offset: start,
    text: item.text.slice(start, end),
    nextOffset: end < item.text.length ? end : null,
  };
}

const summarizing = new Set<string>();

export async function refreshSummary(
  session: StoredSession,
  account: Account,
  model: string,
  botName: string,
  force = false,
) {
  const sessionId = session.meta.sessionId;
  if (summarizing.has(sessionId)) return;
  const items = await threadItems(session);
  const end = items.length - (force ? 4 : keepRecent);
  const previous = session.meta.handoff;
  const found = previous ? items.findIndex((item) => item.id === previous.lastItemId) : -1;
  const start = found + 1;
  if (end - start < (force ? 1 : summaryBatch)) return;
  const lines: string[] = [];
  let used = 0;
  let last = start - 1;
  for (let index = start; index < end; index++) {
    const item = items[index];
    const line = `[${item.id}; ${roleLabel[item.role]}; ${item.kind}] ${oneLine(item.kind === "tool_call" ? item.brief : item.text, 600)}`;
    if (used + line.length > summaryInputChars && lines.length > 0) break;
    lines.push(line);
    used += line.length;
    last = index;
  }
  if (last < start) return;
  summarizing.add(sessionId);
  try {
    const summary = await summarizeForReset(
      account,
      model,
      botName,
      found >= 0 ? (previous?.summary ?? "") : "",
      lines.join("\n"),
    );
    if (!summary) return;
    session.meta.handoff = { summary, lastItemId: items[last].id, updatedAt: new Date().toISOString() };
    await session.save();
  } finally {
    summarizing.delete(sessionId);
  }
}
