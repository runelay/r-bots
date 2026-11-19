import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { factsOfType, makeBot } from "../../../../test/engine-helpers";
import { getStoredSession } from "../../conversations/services/sessions.service";
import * as threads from "../../conversations/services/threads.service";
import {
  agendaVersion,
  BlockError,
  blockEvent,
  blockEventOf,
  bumpAgendaVersion,
  changedLines,
  clip,
  emitUserBlockEvent,
  mainThreadLog,
  mergeRanges,
  newId,
  normalizeTitle,
  nowIso,
  pageArgs,
  pageOf,
  plainText,
  shouldMerge,
  staleCheck,
  userMergeWindowMs,
} from "../services/blocks.shared";

const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function cursorOf(offset: number) {
  return Buffer.from(String(offset)).toString("base64url");
}

describe("ids, time and errors", () => {
  test("newId prefixes a lowercase ulid and nowIso is ISO", () => {
    const first = newId("note");
    expect(first).toMatch(/^note_[0-9a-z]{26}$/);
    expect(newId("note")).not.toBe(first);
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("BlockError defaults to 400 without code or extra", () => {
    const plain = new BlockError("ruim");
    expect([plain.message, plain.status, plain.code, plain.extra]).toEqual(["ruim", 400, undefined, {}]);
    const full = new BlockError("conflito", 409, "stale", { version: 3 });
    expect([full.status, full.code, full.extra]).toEqual([409, "stale", { version: 3 }]);
    expect(full).toBeInstanceOf(Error);
  });
});

describe("paging", () => {
  test("pageArgs clamps limits and decodes cursors", () => {
    expect(pageArgs(undefined, undefined)).toEqual({ limit: 50, offset: 0 });
    expect(pageArgs("", "abc", 8)).toEqual({ limit: 8, offset: 0 });
    expect(pageArgs(null, "-3")).toEqual({ limit: 50, offset: 0 });
    expect(pageArgs(cursorOf(40), "12.9")).toEqual({ limit: 12, offset: 40 });
    expect(pageArgs(cursorOf(0), 999)).toEqual({ limit: 200, offset: 0 });
    expect(() => pageArgs(cursorOf(-1), 10)).toThrow("Cursor inválido.");
    expect(() => pageArgs("bm9wZQ", 10)).toThrow(BlockError);
  });

  test("pageOf only returns a cursor when a full page leaves more behind", () => {
    expect(pageOf([1, 2], 5, 0, 2)).toEqual({ items: [1, 2], total: 5, nextCursor: cursorOf(2) });
    expect(pageOf([3, 4], 5, 2, 3)).toEqual({ items: [3, 4], total: 5, nextCursor: null });
    expect(pageOf([5], 5, 4, 1)).toEqual({ items: [5], total: 5, nextCursor: null });
  });
});

describe("line changes", () => {
  test("changedLines finds the edited window", () => {
    expect(changedLines("a\nb", "a\nb")).toEqual([]);
    expect(changedLines("a\nb\nc", "a\nX\nc")).toEqual([[1, 1]]);
    expect(changedLines("a\nb\nc", "a\nX\nY\nc")).toEqual([[1, 2]]);
    expect(changedLines("a\nb\nc", "a\nc")).toEqual([[1, 1]]);
    expect(changedLines("a\nb", "a")).toEqual([[0, 0]]);
    expect(changedLines("a", "a\nb")).toEqual([[1, 1]]);
  });

  test("mergeRanges sorts, joins touching ranges and keeps 20", () => {
    expect(
      mergeRanges([
        [5, 6],
        [0, 1],
        [2, 3],
        [10, 12],
        [11, 11],
      ]),
    ).toEqual([
      [0, 3],
      [5, 6],
      [10, 12],
    ]);
    const many = Array.from({ length: 25 }, (_, index) => [index * 3, index * 3] as [number, number]);
    expect(mergeRanges(many)).toHaveLength(20);
  });
});

describe("versions", () => {
  test("staleCheck only blocks someone else's newer version", () => {
    const current = { version: 3, updatedBy: "bot" };
    expect(() => staleCheck(current, undefined, "user")).not.toThrow();
    expect(() => staleCheck(current, 3, "user")).not.toThrow();
    expect(() => staleCheck({ version: 3, updatedBy: "user" }, 1, "user")).not.toThrow();
    try {
      staleCheck(current, 2, "user");
      throw new Error("expected a failure");
    } catch (error) {
      const stale = error as BlockError;
      expect([stale.status, stale.code, stale.extra]).toEqual([409, "stale", { version: 3 }]);
      expect(stale.message).toBe("Mudou enquanto você editava. Recarregue para ver a versão nova.");
    }
  });

  test("shouldMerge joins quick unseen edits by the person", () => {
    const fresh = { version: 4, updatedBy: "user", seenVersion: 2, updatedAt: new Date().toISOString() };
    expect(shouldMerge(fresh, "user")).toBe(true);
    expect(shouldMerge(fresh, "bot")).toBe(false);
    expect(shouldMerge({ ...fresh, updatedBy: "bot" }, "user")).toBe(false);
    expect(shouldMerge({ ...fresh, seenVersion: 4 }, "user")).toBe(false);
    const old = new Date(Date.now() - userMergeWindowMs - 1000).toISOString();
    expect(shouldMerge({ ...fresh, updatedAt: old }, "user")).toBe(false);
  });

  test("agenda version starts at zero and bumps per bot", () => {
    const bot = `agenda-${Math.random().toString(36).slice(2, 8)}`;
    expect(agendaVersion(bot)).toBe(0);
    expect(bumpAgendaVersion(bot)).toBe(1);
    expect(bumpAgendaVersion(bot)).toBe(2);
    expect(agendaVersion(bot)).toBe(2);
    expect(agendaVersion(`${bot}-other`)).toBe(0);
  });
});

describe("block events", () => {
  const preview = { kind: "note", folder: "", excerpt: "oi", lines: [] } as never;

  test("blockEvent maps actions to event types and drops preview on delete", () => {
    expect(blockEvent("note", "n1", "Nota", 1, "bot", "created", preview)).toEqual({
      type: "block.created",
      data: { kind: "note", id: "n1", title: "Nota", version: 1, author: "bot", action: "created", preview },
    });
    expect(blockEvent("note", "n1", "Nota", 2, "user", "edited", preview, { lines: [[0, 1]] })).toEqual({
      type: "block.updated",
      data: {
        kind: "note",
        id: "n1",
        title: "Nota",
        version: 2,
        author: "user",
        action: "edited",
        preview,
        changed: { lines: [[0, 1]] },
      },
    });
    expect(blockEvent("note", "n1", "Nota", 3, "user", "deleted", preview, { lines: [[0, 1]] })).toEqual({
      type: "block.deleted",
      data: { kind: "note", id: "n1", title: "Nota", version: 3, author: "user", action: "deleted", preview: null },
    });
  });

  test("blockEventOf reads the event a tool returned", () => {
    const event = blockEvent("sheet", "s1", "Planilha", 1, "bot", "created", null);
    expect(blockEventOf({ ok: true, blockEvent: event })).toBe(event);
    expect(blockEventOf({ blockEvent: undefined })).toBeNull();
    expect(blockEventOf({ ok: true })).toBeNull();
    expect(blockEventOf("text")).toBeNull();
    expect(blockEventOf(null)).toBeNull();
  });

  test("emitUserBlockEvent writes to the bot's main thread", async () => {
    const bot = await makeBot();
    const log = await mainThreadLog(bot.id);
    expect(log).not.toBeNull();
    const thread = await threads.ensureThread(bot.id);
    const session = getStoredSession(thread.sessionId);
    if (!session) throw new Error("thread session missing");
    await emitUserBlockEvent(bot.id, null);
    expect(factsOfType(session, "block.created")).toEqual([]);
    await emitUserBlockEvent(bot.id, blockEvent("note", "n9", "Diário", 1, "user", "created", preview));
    const facts = factsOfType(session, "block.created");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ data: { botId: bot.id, id: "n9", title: "Diário", author: "user" } });
  });

  test("mainThreadLog is null when the thread cannot start", async () => {
    spies.push(spyOn(threads, "ensureThread").mockRejectedValueOnce(new Error("disco cheio")));
    expect(await mainThreadLog("bot-sem-thread")).toBeNull();
    spies.push(spyOn(threads, "ensureThread").mockRejectedValueOnce(new Error("disco cheio")));
    await expect(
      emitUserBlockEvent("bot-sem-thread", blockEvent("note", "x", "X", 1, "user", "created", null)),
    ).resolves.toBeUndefined();
  });
});

describe("text helpers", () => {
  test("plainText strips markdown down to words", () => {
    const markdown = [
      "# Título",
      "> citação com **negrito** e _itálico_",
      "- [x] tarefa feita",
      "* item",
      "1. primeiro",
      "Veja [[Plano Q1#metas|o plano]] e [[Ideias]] e [site](https://x.com) ![img](a.png)",
      "```js",
      "const x = 1;",
      "```",
      "~~riscado~~ `code`",
    ].join("\n");
    expect(plainText(markdown)).toBe(
      "Título citação com negrito e itálico tarefa feita item primeiro Veja o plano e Ideias e site riscado code",
    );
  });

  test("clip cuts with an ellipsis and normalizeTitle folds case", () => {
    expect(clip("abcdef", 10)).toBe("abcdef");
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(normalizeTitle("  ÁRVORE  ")).toBe("árvore");
    expect(normalizeTitle("Café")).toBe(normalizeTitle("café"));
  });
});
