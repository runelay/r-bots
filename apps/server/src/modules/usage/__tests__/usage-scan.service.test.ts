import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resetUsageTables } from "../../../../test/usage-helpers";
import { getDb } from "../../../db";
import { writeSetting } from "../../../db/settings";
import { usageBuckets, usageCursors, usageSeen, usageSessions } from "../../../db/tables";
import { UsageScanner } from "../services/usage-scan.service";

const root = await mkdtemp(join(tmpdir(), "rb-usage-scan-"));
let claudeRoot = "";
let codexRoot = "";
let run = 0;

const scannerFor = () =>
  new UsageScanner(() => [
    { account: "vps:claude", provider: "claude", root: claudeRoot },
    { account: "vps:codex", provider: "codex", root: codexRoot },
  ]);

const hour = (iso: string) => Math.floor(Date.parse(iso) / 3_600_000) * 3600;
const recent = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

async function put(path: string, lines: unknown[]) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`,
  );
}

function claudeRecord(
  overrides: Record<string, unknown> = {},
  usage: Record<string, unknown> = {},
  model = "claude-x",
) {
  return {
    type: "assistant",
    timestamp: recent(2),
    sessionId: "s1",
    requestId: `r-${Math.random()}`,
    message: { id: `m-${Math.random()}`, model, usage: { input_tokens: 10, output_tokens: 5, ...usage } },
    ...overrides,
  };
}

function tokenCount(timestamp: string, total: number[] | null, last?: number[]) {
  const keys = [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
  ];
  const toUsage = (values: number[]) => Object.fromEntries(keys.map((key, i) => [key, values[i]]));
  return {
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: total ? { total_token_usage: toUsage(total), ...(last ? { last_token_usage: toUsage(last) } : {}) } : null,
    },
  };
}

beforeEach(async () => {
  run += 1;
  claudeRoot = join(root, `claude-${run}`);
  codexRoot = join(root, `codex-${run}`);
  await resetUsageTables();
});

afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
});

const restores: Array<() => void> = [];

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("claude logs", () => {
  test("aggregates assistant usage per hour, model and speed, dedupes and tracks sessions", async () => {
    const at = recent(3);
    const earlier = recent(30);
    const dup = claudeRecord({ timestamp: at, requestId: "same" }, {}, "claude-a");
    (dup.message as Record<string, unknown>).id = "same-msg";
    await put(join(claudeRoot, "proj", "a.jsonl"), [
      'not json but has "usage" inside {',
      { type: "user", message: { usage: {} } },
      { type: "summary" },
      claudeRecord({ timestamp: at }, {}, "<synthetic>"),
      claudeRecord({ timestamp: at }, {}, ""),
      { type: "assistant", timestamp: at, message: { model: "claude-a" }, usage: 1 },
      claudeRecord({ timestamp: "garbage" }),
      dup,
      dup,
      claudeRecord(
        { timestamp: at, sessionId: "s2" },
        {
          input_tokens: 100,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 30,
          cache_creation: { ephemeral_1h_input_tokens: 80 },
          output_tokens: 7,
          speed: "fast",
        },
        "claude-a",
      ),
      claudeRecord(
        { timestamp: earlier, sessionId: "s2" },
        { input_tokens: -5, output_tokens: Number.NaN },
        "claude-b",
      ),
      claudeRecord({ timestamp: at, sessionId: undefined, requestId: undefined, uuid: "u1" }, {}, "claude-a"),
    ]);
    await writeFile(join(claudeRoot, "proj", "ignored.txt"), "x");
    const scanner = scannerFor();
    const snap = await scanner.snapshot();
    expect(snap.files).toBe(1);
    const rows = snap.rows.sort((a, b) => a.m.localeCompare(b.m) || a.s.localeCompare(b.s));
    expect(rows).toEqual([
      { h: hour(at), p: "claude", m: "claude-a", s: "fast", a: "vps:claude", c: [100, 50, 0, 30, 7, 0, 1] },
      { h: hour(at), p: "claude", m: "claude-a", s: "standard", a: "vps:claude", c: [20, 0, 0, 0, 10, 0, 2] },
      { h: hour(earlier), p: "claude", m: "claude-b", s: "standard", a: "vps:claude", c: [0, 0, 0, 0, 0, 0, 1] },
    ]);
    expect(snap.sessions.sort((a, b) => a.h - b.h)).toEqual([
      { p: "claude", h: hour(earlier), m: "claude-b", a: "vps:claude" },
      { p: "claude", h: hour(at), m: "claude-a", a: "vps:claude" },
    ]);
    expect((await getDb().select().from(usageCursors)).map((row) => row.path)).toEqual([
      join(claudeRoot, "proj", "a.jsonl"),
    ]);
  });

  test("reads only appended complete lines and restarts a truncated file", async () => {
    const file = join(claudeRoot, "b.jsonl");
    const first = claudeRecord({}, { input_tokens: 1, output_tokens: 1 });
    await put(file, [first]);
    const partial = JSON.stringify(claudeRecord({}, { input_tokens: 2, output_tokens: 0 }));
    await appendFile(file, partial.slice(0, 20));
    const scanner = scannerFor();
    expect((await scanner.snapshot()).rows[0].c[0]).toBe(1);
    await appendFile(file, `${partial.slice(20)}\n`);
    expect((await scanner.snapshot(0)).rows[0].c[0]).toBe(3);
    expect((await scanner.snapshot(0)).rows[0].c[0]).toBe(3);
    await writeFile(file, `${JSON.stringify(claudeRecord({}, { input_tokens: 4, output_tokens: 0 }))}\n`);
    expect((await scanner.snapshot(0)).rows[0].c[0]).toBe(7);
  });

  test("handles lines larger than a stream chunk", async () => {
    const file = join(claudeRoot, "big.jsonl");
    const padded = { ...claudeRecord({}, { input_tokens: 9 }), pad: "x".repeat(200_000) };
    await put(file, [padded, claudeRecord({}, { input_tokens: 1 })]);
    const snap = await scannerFor().snapshot();
    expect(snap.rows[0].c[0]).toBe(10);
  });
});

describe("codex logs", () => {
  test("turns cumulative token counts into deltas with model, speed and session", async () => {
    const start = recent(5);
    const t1 = recent(4);
    const t2 = recent(3);
    await put(join(codexRoot, "2026", "11", "rollout.jsonl"), [
      "{broken",
      { type: "session_meta", payload: { id: "c1", timestamp: start } },
      { type: "session_meta", payload: { id: "other", timestamp: recent(1) } },
      { type: "turn_context", payload: { model: "gpt-x", service_tier: "priority" } },
      { type: "event_msg", payload: { type: "agent_message" } },
      tokenCount(t1, null),
      tokenCount(recent(50), [1, 1, 1, 1, 1]),
      tokenCount(t1, [101, 1, 1, 1, 1]),
      tokenCount(t1, [101, 1, 1, 1, 1]),
      {
        type: "response_item",
        payload: { type: "thread_settings_applied", thread_settings: { service_tier: "flex" } },
      },
      { type: "response_item", payload: { type: "thread_settings_applied", thread_settings: {} } },
      { type: "turn_context", payload: { service_tier: "default", model: 3 } },
      tokenCount(t2, [151, 11, 1, 6, 2]),
      tokenCount(t2, [10, 0, 0, 0, 0], [40, 30, 20, 4, 0]),
      tokenCount("bad", [20, 0, 0, 1, 0]),
    ]);
    const snap = await scannerFor().snapshot();
    const rows = snap.rows.sort((a, b) => a.h - b.h || a.s.localeCompare(b.s));
    expect(rows).toEqual([
      { h: hour(t1), p: "codex", m: "gpt-x", s: "fast", a: "vps:codex", c: [100, 0, 0, 0, 0, 0, 1] },
      { h: hour(t2), p: "codex", m: "gpt-x", s: "standard", a: "vps:codex", c: [40, 40, 20, 0, 9, 1, 2] },
    ]);
    expect(snap.sessions).toEqual([{ p: "codex", h: hour(t1), m: "gpt-x", a: "vps:codex" }]);
  });

  test("falls back to the codex model name and to the record timestamp, and resets state on truncation", async () => {
    const file = join(codexRoot, "r.jsonl");
    const at = recent(2);
    await put(file, [
      { type: "session_meta", timestamp: recent(3), payload: { session_id: "c2" } },
      { type: "session_meta", payload: {} },
      tokenCount(at, [5, 0, 0, 2, 0]),
    ]);
    const scanner = scannerFor();
    expect((await scanner.snapshot()).rows).toEqual([
      { h: hour(at), p: "codex", m: "codex", s: "standard", a: "vps:codex", c: [5, 0, 0, 0, 2, 0, 1] },
    ]);
    await writeFile(file, `${JSON.stringify(tokenCount(at, [1, 0, 0, 0, 0]))}\n`);
    expect((await scanner.snapshot(0)).rows[0].c).toEqual([6, 0, 0, 0, 2, 0, 2]);
    await put(join(codexRoot, "empty-meta.jsonl"), [{ type: "session_meta" }, tokenCount(at, [3, 0, 0, 0, 0])]);
    expect((await scanner.snapshot(0)).rows[0].c[0]).toBe(9);
  });
});

describe("index", () => {
  test("persists cursors, reloads them and prunes data older than 100 days", async () => {
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
    await put(join(claudeRoot, "a.jsonl"), [claudeRecord({ timestamp: old, sessionId: "old" }), claudeRecord()]);
    await scannerFor().snapshot();
    expect(await getDb().select().from(usageBuckets)).toHaveLength(1);
    expect((await getDb().select().from(usageSessions)).map((row) => row.key)).toEqual(["claude:s1"]);
    expect(await getDb().select().from(usageSeen)).toHaveLength(1);
    const reloaded = scannerFor();
    const snap = await reloaded.snapshot();
    expect(snap.rows).toHaveLength(1);
    expect(snap.rows[0].c[6]).toBe(1);
  });

  test("ignores a stored index of another version", async () => {
    await put(join(claudeRoot, "a.jsonl"), [claudeRecord()]);
    await scannerFor().snapshot();
    await writeSetting("usage.index.version", 99);
    const snap = await scannerFor().snapshot();
    expect(snap.rows).toHaveLength(1);
    expect(snap.rows[0].c[6]).toBe(1);
  });

  test("skips directories deeper than six levels and files that vanish before stat", async () => {
    const deep = join(claudeRoot, "1", "2", "3", "4", "5", "6", "7");
    await put(join(deep, "deep.jsonl"), [claudeRecord()]);
    await put(join(claudeRoot, "gone.jsonl"), [claudeRecord()]);
    const realStat = fsPromises.stat;
    const spy = spyOn(fsPromises, "stat").mockImplementation(((path: string) =>
      path.endsWith("gone.jsonl")
        ? Promise.reject(new Error("ENOENT"))
        : realStat(path)) as unknown as typeof fsPromises.stat);
    restores.push(() => spy.mockRestore());
    const snap = await scannerFor().snapshot();
    expect(snap.files).toBe(1);
    expect(snap.rows).toEqual([]);
  });
});

describe("snapshot cache", () => {
  test("reuses a fresh snapshot and shares a scan in flight", async () => {
    await put(join(claudeRoot, "a.jsonl"), [claudeRecord()]);
    const scanner = scannerFor();
    const [a, b] = await Promise.all([scanner.snapshot(), scanner.snapshot()]);
    expect(a).toBe(b);
    await put(join(claudeRoot, "b.jsonl"), [claudeRecord()]);
    expect(await scanner.snapshot()).toBe(a);
    expect((await scanner.snapshot(0)).files).toBe(2);
  });

  test("keeps each account apart and reads rows saved before accounts existed", async () => {
    const second = join(root, `claude2-${run}`);
    await put(join(claudeRoot, "a.jsonl"), [claudeRecord({}, {}, "claude-a")]);
    await put(join(second, "b.jsonl"), [claudeRecord({ sessionId: "s9" }, {}, "claude-a")]);
    await getDb()
      .insert(usageBuckets)
      .values({
        hour: hour(recent(2)),
        provider: "codex",
        model: "gpt",
        tier: "standard",
        counters: [1, 0, 0, 0, 0, 0, 1],
      });
    await getDb()
      .insert(usageSessions)
      .values({ key: "codex:velha", hour: hour(recent(2)), model: "gpt" });
    const snap = await new UsageScanner(async () => [
      { account: "vps:claude", provider: "claude", root: claudeRoot },
      { account: "claude-2:claude", provider: "claude", root: second },
    ]).snapshot();
    expect(snap.files).toBe(2);
    expect(snap.rows.map((row) => row.a).sort()).toEqual(["claude-2:claude", "vps:claude", "vps:codex"]);
    expect(snap.sessions.map((row) => row.a).sort()).toEqual(["claude-2:claude", "vps:claude", "vps:codex"]);
    const stored = await getDb().select().from(usageBuckets);
    expect(stored.map((row) => row.account).sort()).toEqual(["", "claude-2:claude", "vps:claude"]);
  });
});
