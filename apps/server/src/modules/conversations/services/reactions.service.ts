import { ValidationError } from "../../../shared/errors";
import { findAccount } from "../../accounts/services/accounts.service";
import { getBot, memoryOf } from "../../bots/services/bots.service";
import { queueCapture } from "../../memory/services/capture-jobs.service";
import {
  deleteReactions,
  findMessageEvent,
  insertReaction,
  latestReactions,
  type ReactionAuthorKind,
  type ReactionRow,
  reactionsOfTargets,
  userReactionsSince,
  userTextBefore,
} from "../repositories/reactions.repository";
import type { StoredSession } from "./sessions.service";

export interface ReactionAuthor {
  kind: ReactionAuthorKind;
  id: string;
}

export interface PublicReaction {
  target: string;
  emoji: string;
  author: ReactionAuthor;
  at: string;
}

export interface ReactionTarget {
  target: string;
  seq: number;
  role: "user" | "bot";
  botId: string | null;
  text: string;
}

export class ReactionTargetMissing extends Error {}

export const feedbackEmojis = new Set(["👍", "👎"]);
const maxEmojiLength = 32;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const pictographic = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

type FactLike = { type?: string; data?: Record<string, unknown> };

export function normalizeEmoji(raw: unknown) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (
    !value ||
    value.length > maxEmojiLength ||
    !pictographic.test(value) ||
    [...segmenter.segment(value)].length !== 1
  )
    throw new ValidationError("Use um emoji só.", "emoji");
  return value;
}

export function normalizeTarget(raw: unknown) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > 200) throw new ValidationError("target inválido.", "target");
  return value;
}

export function publicReaction(row: ReactionRow): PublicReaction {
  return {
    target: row.target,
    emoji: row.emoji,
    author: { kind: row.authorKind, id: row.authorId },
    at: row.createdAt,
  };
}

function textOf(fact: FactLike) {
  const parts = (fact.data?.parts ?? []) as { kind?: string; text?: string }[];
  return parts
    .filter((part) => part.kind === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
}

export function targetsIn(facts: unknown[]) {
  const targets: string[] = [];
  for (const fact of facts as FactLike[]) {
    if (fact?.type === "delivery.consumed" && typeof fact.data?.deliveryId === "string")
      targets.push(fact.data.deliveryId);
    if (fact?.type === "content.completed" && fact.data?.kind === "text" && typeof fact.data.partId === "string")
      targets.push(fact.data.partId);
  }
  return targets;
}

export async function resolveTarget(session: StoredSession, target: string): Promise<ReactionTarget | null> {
  await session.log.flush();
  const row = await findMessageEvent(session.meta.sessionId, target);
  if (!row) return null;
  const facts = JSON.parse(row.facts) as FactLike[];
  for (const fact of facts) {
    if (fact.type === "delivery.consumed" && fact.data?.deliveryId === target)
      return { target, seq: row.seq, role: "user", botId: null, text: textOf(fact) };
    if (fact.type === "content.completed" && fact.data?.kind === "text" && fact.data.partId === target) {
      const botId = typeof fact.data.botId === "string" ? fact.data.botId : session.meta.botId;
      return { target, seq: row.seq, role: "bot", botId, text: String(fact.data.value ?? "") };
    }
  }
  return null;
}

function emitReaction(session: StoredSession, type: "reaction.added" | "reaction.removed", row: ReactionRow) {
  session.log.emit({ type, data: { ...publicReaction(row) } });
}

async function feedbackCapture(session: StoredSession, target: ReactionTarget, emoji: string) {
  const engine = session.meta.lastEngine;
  const bot = target.botId ? getBot(target.botId) : undefined;
  if (!engine || !bot || !memoryOf(bot).capture || !target.text) return;
  const account = await findAccount(engine.account);
  if (!account) return;
  await queueCapture({
    bot,
    account,
    model: engine.model,
    userText: await userTextBefore(session.meta.sessionId, target.seq),
    replyText: target.text,
    recalled: [],
    log: session.log,
    turnId: `reaction_${target.target}`,
    sessionId: session.meta.sessionId,
    feedback: emoji,
  });
}

export async function addReaction(
  session: StoredSession,
  input: { target: string; emoji: string; author: ReactionAuthor },
) {
  const target = await resolveTarget(session, input.target);
  if (!target) throw new ReactionTargetMissing("Mensagem não encontrada.");
  if (input.author.kind === "bot") {
    const previous = await deleteReactions({
      sessionId: session.meta.sessionId,
      target: target.target,
      authorKind: "bot",
      authorId: input.author.id,
    });
    for (const row of previous.filter((item) => item.emoji !== input.emoji))
      emitReaction(session, "reaction.removed", row);
    const kept = previous.find((item) => item.emoji === input.emoji);
    if (kept) {
      await insertReaction(kept);
      return reactionsOf(session.meta.sessionId, target.target);
    }
  }
  const row: ReactionRow = {
    sessionId: session.meta.sessionId,
    target: target.target,
    targetSeq: target.seq,
    targetRole: target.role,
    targetBotId: target.botId,
    emoji: input.emoji,
    authorKind: input.author.kind,
    authorId: input.author.id,
    createdAt: new Date().toISOString(),
  };
  if (await insertReaction(row)) {
    emitReaction(session, "reaction.added", row);
    if (input.author.kind === "user" && target.role === "bot" && feedbackEmojis.has(input.emoji))
      await feedbackCapture(session, target, input.emoji).catch((error: unknown) =>
        console.warn("reaction feedback failed", error instanceof Error ? error.message : error),
      );
  }
  return reactionsOf(session.meta.sessionId, target.target);
}

export async function removeReaction(
  session: StoredSession,
  input: { target: string; emoji?: string; author: ReactionAuthor },
) {
  const removed = await deleteReactions({
    sessionId: session.meta.sessionId,
    target: input.target,
    authorKind: input.author.kind,
    authorId: input.author.id,
    ...(input.emoji ? { emoji: input.emoji } : {}),
  });
  for (const row of removed) emitReaction(session, "reaction.removed", row);
  return { removed: removed.length, reactions: await reactionsOf(session.meta.sessionId, input.target) };
}

export async function reactionsOf(sessionId: string, target: string) {
  return (await reactionsOfTargets(sessionId, [target])).map(publicReaction);
}

export async function reactionsForFacts(sessionId: string, facts: unknown[]) {
  return (await reactionsOfTargets(sessionId, [...new Set(targetsIn(facts))])).map(publicReaction);
}

export async function sessionReactions(sessionId: string, limit = 500) {
  return (await latestReactions(sessionId, limit)).map(publicReaction);
}

function clipText(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export async function reactionNote(session: StoredSession, botId: string) {
  const meta = session.meta;
  const since = meta.reactionsNoted?.[botId] ?? meta.startedAt;
  const rows = await userReactionsSince(meta.sessionId, botId, since);
  if (rows.length === 0) return "";
  meta.reactionsNoted = { ...meta.reactionsNoted, [botId]: rows.at(-1)?.createdAt ?? since };
  const lines: string[] = [];
  for (const row of rows.slice(-3)) {
    const target = await resolveTarget(session, row.target);
    const quote = target?.text ? ` (“${clipText(target.text, 80)}”)` : "";
    lines.push(`- A pessoa reagiu ${row.emoji} à sua resposta${quote}.`);
  }
  return `Reações da pessoa desde a última mensagem (sinal leve, não é pedido; não comente a reação):\n${lines.join("\n")}`;
}

export const reactionGuide = [
  "## Reações (`react`, `unreact`)",
  "Reaja com um emoji à mensagem da pessoa (ferramenta `react` do servidor `bots`), como numa conversa entre pessoas. Não é em toda mensagem, mas nestes casos reaja sempre:",
  "- A pessoa agradeceu ou elogiou: ❤️.",
  "- A pessoa comemorou algo, ou você terminou algo grande que ela pediu: 🎉.",
  "- Um pedido que vai levar várias ferramentas: 👀 logo no começo e, quando terminar, `react` com ✅ (troca a anterior).",
  '- Uma confirmação curta ("ok", "pode seguir"): 👍.',
  "A reação nunca substitui a resposta em texto quando há pergunta ou pedido. No máximo uma reação sua por mensagem: `react` de novo troca, `unreact` tira. Sem `target`, vale a mensagem que você está respondendo.",
].join("\n");
