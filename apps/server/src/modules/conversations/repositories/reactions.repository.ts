import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { type Db, getDb, queryRows } from "../../../db";
import { messageReactions } from "../../../db/tables";

export type ReactionAuthorKind = "user" | "bot";

export interface ReactionRow {
  sessionId: string;
  target: string;
  targetSeq: number;
  targetRole: "user" | "bot";
  targetBotId: string | null;
  emoji: string;
  authorKind: ReactionAuthorKind;
  authorId: string;
  createdAt: string;
}

export interface MessageEventRow {
  seq: number;
  facts: string;
}

type Row = typeof messageReactions.$inferSelect;

function reactionOf(row: Row): ReactionRow {
  return {
    sessionId: row.sessionId,
    target: row.target,
    targetSeq: row.targetSeq,
    targetRole: row.targetRole === "bot" ? "bot" : "user",
    targetBotId: row.targetBotId,
    emoji: row.emoji,
    authorKind: row.authorKind === "bot" ? "bot" : "user",
    authorId: row.authorId,
    createdAt: row.createdAt,
  };
}

export async function insertReaction(row: ReactionRow, db: Db = getDb()) {
  const inserted = await db.insert(messageReactions).values(row).onConflictDoNothing().returning();
  return inserted.length > 0;
}

export async function deleteReactions(
  input: { sessionId: string; target: string; authorKind: ReactionAuthorKind; authorId: string; emoji?: string },
  db: Db = getDb(),
) {
  const removed = await db
    .delete(messageReactions)
    .where(
      and(
        eq(messageReactions.sessionId, input.sessionId),
        eq(messageReactions.target, input.target),
        eq(messageReactions.authorKind, input.authorKind),
        eq(messageReactions.authorId, input.authorId),
        ...(input.emoji ? [eq(messageReactions.emoji, input.emoji)] : []),
      ),
    )
    .returning();
  return removed.map(reactionOf);
}

export async function reactionsOfTargets(sessionId: string, targets: string[], db: Db = getDb()) {
  if (targets.length === 0) return [];
  const rows = await db
    .select()
    .from(messageReactions)
    .where(and(eq(messageReactions.sessionId, sessionId), inArray(messageReactions.target, targets)))
    .orderBy(asc(messageReactions.createdAt), asc(messageReactions.id));
  return rows.map(reactionOf);
}

export async function latestReactions(sessionId: string, limit: number, db: Db = getDb()) {
  const rows = await db
    .select()
    .from(messageReactions)
    .where(eq(messageReactions.sessionId, sessionId))
    .orderBy(desc(messageReactions.createdAt), desc(messageReactions.id))
    .limit(limit);
  return rows.map(reactionOf).reverse();
}

export async function userReactionsSince(sessionId: string, botId: string, since: string, db: Db = getDb()) {
  const rows = await db
    .select()
    .from(messageReactions)
    .where(
      and(
        eq(messageReactions.sessionId, sessionId),
        eq(messageReactions.authorKind, "user"),
        eq(messageReactions.targetRole, "bot"),
        eq(messageReactions.targetBotId, botId),
        gt(messageReactions.createdAt, since),
      ),
    )
    .orderBy(asc(messageReactions.createdAt), asc(messageReactions.id));
  return rows.map(reactionOf);
}

export async function findMessageEvent(sessionId: string, target: string, db: Db = getDb()) {
  const needle = JSON.stringify(target);
  const [row] = await queryRows<MessageEventRow>(
    sql`select seq, facts::text as facts from conversation_events
        where session_id = ${sessionId}
          and (types like '%delivery.consumed%' or types like '%content.completed%')
          and position(${needle} in facts::text) > 0
        order by seq desc limit 1`,
    db,
  );
  return row ? { seq: Number(row.seq), facts: row.facts } : null;
}

export async function userTextBefore(sessionId: string, seq: number, db: Db = getDb()) {
  const [row] = await queryRows<{ text: string | null }>(
    sql`select text from conversation_events
        where session_id = ${sessionId} and seq < ${seq} and role = 'user' and text is not null
        order by seq desc limit 1`,
    db,
  );
  return row?.text ?? "";
}
