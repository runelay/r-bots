import type {
  BlockAction,
  BlockAuthor,
  BlockChange,
  BlockEventData,
  BlockKind,
  BlockPreview,
  Page,
} from "@runelay-bots/protocol";
import { ulid } from "ulid";
import { readSetting, writeSetting } from "../../../db/settings";
import { getStoredSession } from "../../conversations/services/sessions.service";
import { ensureThread } from "../../conversations/services/threads.service";

export const userMergeWindowMs = 120_000;

export class BlockError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function newId(prefix: string) {
  return `${prefix}_${ulid().toLowerCase()}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function pageArgs(cursor: unknown, limit: unknown, fallback = 50) {
  const parsed = Number(limit);
  const size = Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 200) : fallback;
  let offset = 0;
  if (typeof cursor === "string" && cursor) {
    const decoded = Number(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Number.isInteger(decoded) || decoded < 0) throw new BlockError("Cursor inválido.");
    offset = decoded;
  }
  return { limit: size, offset };
}

export function pageOf<Item>(items: Item[], total: number, offset: number, limit: number): Page<Item> {
  const next = offset + items.length;
  return {
    items,
    total,
    nextCursor: next < total && items.length === limit ? Buffer.from(String(next)).toString("base64url") : null,
  };
}

export function changedLines(before: string, after: string): Array<[number, number]> {
  if (before === after) return [];
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  if (endB < start) return [[Math.max(0, Math.min(start, b.length - 1)), Math.max(0, Math.min(start, b.length - 1))]];
  return [[start, endB]];
}

export function mergeRanges(ranges: Array<[number, number]>) {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged.slice(0, 20);
}

export function staleCheck(current: { version: number; updatedBy: string }, baseVersion: unknown, author: BlockAuthor) {
  if (typeof baseVersion !== "number") return;
  if (baseVersion < current.version && current.updatedBy !== author)
    throw new BlockError("Mudou enquanto você editava. Recarregue para ver a versão nova.", 409, "stale", {
      version: current.version,
    });
}

export function shouldMerge(
  current: { version: number; updatedBy: string; seenVersion: number; updatedAt: string },
  author: BlockAuthor,
) {
  return (
    author === "user" &&
    current.updatedBy === "user" &&
    current.version > current.seenVersion &&
    Date.now() - Date.parse(current.updatedAt) < userMergeWindowMs
  );
}

export interface BlockEvent {
  type: "block.created" | "block.updated" | "block.deleted";
  data: Omit<BlockEventData, "botId" | "callId">;
}

export function blockEvent(
  kind: BlockKind,
  id: string,
  title: string,
  version: number,
  author: BlockAuthor,
  action: BlockAction,
  preview: BlockPreview | null,
  changed?: BlockChange,
): BlockEvent {
  const type = action === "created" ? "block.created" : action === "deleted" ? "block.deleted" : "block.updated";
  return {
    type,
    data: {
      kind,
      id,
      title,
      version,
      author,
      action,
      preview: action === "deleted" ? null : preview,
      ...(changed && action !== "deleted" ? { changed } : {}),
    },
  };
}

export function blockEventOf(output: unknown): BlockEvent | null {
  if (!output || typeof output !== "object" || !("blockEvent" in output)) return null;
  return (output as { blockEvent: BlockEvent | null }).blockEvent ?? null;
}

export async function mainThreadLog(botId: string) {
  const thread = await ensureThread(botId).catch(() => null);
  return thread ? (getStoredSession(thread.sessionId)?.log ?? null) : null;
}

export async function emitUserBlockEvent(botId: string, event: BlockEvent | null) {
  if (!event) return;
  const log = await mainThreadLog(botId);
  log?.emit({ type: event.type, data: { ...event.data, botId } });
}

export function agendaVersion(botId: string) {
  return readSetting<number>(`blocks.agenda.${botId}.version`, 0);
}

export function bumpAgendaVersion(botId: string) {
  const next = agendaVersion(botId) + 1;
  writeSetting(`blocks.agenda.${botId}.version`, next);
  return next;
}

export function plainText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, target: string, alias?: string) => alias ?? target)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]\s+\[[ xX]\]|[-*+]|\d+\.)\s*/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function normalizeTitle(value: string) {
  return value.normalize("NFC").trim().toLocaleLowerCase("pt-BR");
}
