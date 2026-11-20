import { beforeEach, describe, expect, test } from "bun:test";
import { defaultModels } from "@runelay-bots/providers";
import { resetData } from "../../../../test/helpers";
import { model as defaultClaudeModel } from "../../../config/env";
import { getDb } from "../../../db";
import { bots as botsTable } from "../../../db/tables";
import { ValidationError } from "../../../shared/errors";
import { botFromRow, botToRow, deleteBotRow, loadBotRows, saveBotRow } from "../repositories/bots.repository";
import {
  type BotDefinition,
  clearSection,
  connectorsOf,
  createBot,
  decisionsOf,
  defaultEngine,
  defaultVoice,
  deriveRole,
  engineOf,
  getBot,
  isActive,
  listBots,
  loadBots,
  memoryOf,
  onBotsChanged,
  permissionOfBot,
  setArchived,
  setDeleted,
  setKnownConnectors,
  sidebarOf,
  suggestedFallback,
  updateBot,
  updateSidebar,
  voiceOf,
} from "../services/bots.service";

let changes = 0;
onBotsChanged(() => {
  changes++;
});

let seq = 0;
function uniqueName(prefix = "Svc") {
  seq++;
  return `${prefix} ${seq} ${Math.random().toString(36).slice(2, 6)}`;
}

beforeEach(async () => {
  await resetData();
  setKnownConnectors([]);
});

async function fieldOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ValidationError) return { field: error.field, message: error.message };
    throw error;
  }
  throw new Error("expected a ValidationError");
}

describe("bot defaults", () => {
  test("engine, fallback and settings fill from defaults", async () => {
    expect(defaultEngine()).toEqual({ account: "vps:claude", model: defaultClaudeModel, effort: null });
    expect(suggestedFallback("vps:codex")).toEqual({ account: "vps:claude", model: defaultClaudeModel });
    expect(suggestedFallback("claude-2:claude")).toEqual({ account: "vps:codex", model: defaultModels.codex });
    const bare = { id: "bare", capabilities: {} } as BotDefinition;
    expect(engineOf(bare).fallback).toEqual({ account: "vps:codex", model: defaultModels.codex });
    expect(engineOf({ ...bare, engine: { ...defaultEngine(), fallback: null } }).fallback).toBeNull();
    expect(decisionsOf(bare)).toEqual({ autoApprove: true, threshold: 0.7 });
    expect(memoryOf({ ...bare, memory: { recall: false, capture: true } })).toEqual({ recall: false, capture: true });
    expect(sidebarOf(bare)).toEqual({ pinned: false, sectionId: null, hidden: false });
    expect(voiceOf(bare)).toEqual(defaultVoice);
    expect(permissionOfBot(bare)).toBe("default");
    expect(permissionOfBot({ ...bare, permission: "full" })).toBe("full");
    expect(isActive(undefined)).toBe(false);
    expect(isActive({ ...bare, archivedAt: "x" })).toBe(false);
    expect(isActive({ ...bare, archivedAt: null, deletedAt: "x" })).toBe(false);
    expect(isActive({ ...bare, archivedAt: null })).toBe(true);
  });

  test("connectors merge the known list and always keep memory", async () => {
    setKnownConnectors(["linear"]);
    const bot = { id: "c", connectors: { allowed: ["github", "linear"], memory: false } } as BotDefinition;
    expect(connectorsOf(bot)).toEqual({ allowed: ["linear", "github"], memory: true });
    expect(connectorsOf({ id: "d" } as BotDefinition)).toEqual({ allowed: ["linear"], memory: true });
  });

  test("derives a role from the first sentence", async () => {
    expect(deriveRole("")).toBe("");
    expect(deriveRole("# Você cuida do **financeiro** agora. Depois faz outra coisa.")).toBe(
      "Você cuida do financeiro agora",
    );
    const long = deriveRole(`${"palavra ".repeat(20)}.`);
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBe(60);
  });
});

describe("createBot", () => {
  test("creates with defaults, unique ids and full delegation", async () => {
    const before = changes;
    const existing = await createBot({ name: uniqueName() });
    const name = `Ágata ${Math.random().toString(36).slice(2, 6)}`;
    const first = await createBot({ name, instructions: "Organiza a agenda. Responde e-mails." });
    const second = await createBot({ name });
    expect(first.id).toBe(
      name
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-"),
    );
    expect(second.id).toBe(`${first.id}-2`);
    expect(first.role).toBe("Organiza a agenda");
    expect(second.role).toBe("Novo no time");
    expect(first.accent).toBe("blue");
    expect(first.glyph).toBe("auto");
    expect(first.capabilities.delegate).toContain(existing.id);
    expect(first.capabilities.delegate).not.toContain(first.id);
    expect(first.engine).toEqual(defaultEngine());
    expect(first.connectors).toEqual({ allowed: [], memory: true });
    expect(changes).toBe(before + 3);
    expect(getBot(first.id)).toBe(first);
    expect((await loadBotRows()).find((row) => row.id === first.id)?.name).toBe(name);
  });

  test("reserved and empty slugs get a suffix or a fallback", async () => {
    const meta = await createBot({ name: "Meta" });
    expect(meta.id).toMatch(/^meta-\d+$/);
    const symbols = await createBot({ name: "!!!" });
    expect(symbols.id).toMatch(/^bot(-\d+)?$/);
  });

  test("accepts every optional field", async () => {
    const bot = await createBot({
      name: uniqueName(),
      role: "Analista",
      accent: "electric",
      glyph: "crown",
      instructions: "Faz análise.",
      capabilities: { browser: false, desktop: true, delegate: ["x", "x"] },
      schedules: [
        { cron: "0 9 * * *", prompt: "Bom dia" },
        { name: "tarde", cron: "0 15 * * 1-5", timezone: "UTC", prompt: "Boa tarde", description: "Resumo" },
      ],
      engine: { account: "codex-2:codex", effort: "high", fallback: { account: "vps:grok" } },
      decisions: { threshold: 0.9 },
      connectors: { allowed: ["github", "github"] },
      memory: { recall: false },
      permission: "edit",
    });
    expect(bot.role).toBe("Analista");
    expect(bot.glyph).toBe("crown");
    expect(bot.capabilities).toEqual({ browser: true, desktop: true, computer: true, delegate: ["x"] });
    expect(bot.schedules).toEqual([
      { name: "rotina-1", cron: "0 9 * * *", timezone: "America/Sao_Paulo", prompt: "Bom dia", description: "" },
      { name: "tarde", cron: "0 15 * * 1-5", timezone: "UTC", prompt: "Boa tarde", description: "Resumo" },
    ]);
    expect(bot.engine).toEqual({
      account: "codex-2:codex",
      model: defaultModels.codex,
      effort: "high",
      fallback: { account: "vps:grok", model: defaultModels.grok },
    });
    expect(bot.decisions).toEqual({ autoApprove: true, threshold: 0.9 });
    expect(bot.connectors).toEqual({ allowed: ["github"], memory: true });
    expect(bot.memory).toEqual({ recall: false, capture: true });
    expect(bot.permission).toBe("edit");
    const blankRole = await createBot({ name: uniqueName(), role: "  ", capabilities: null, schedules: null });
    expect(blankRole.role).toBe("Novo no time");
    expect(blankRole.schedules).toEqual([]);
  });

  test("rejects invalid input with the offending field", async () => {
    const name = uniqueName();
    const cases: Array<[unknown, string]> = [
      [null, "body"],
      [[], "body"],
      [{ name, color: "x" }, "color"],
      [{ name: 1 }, "name"],
      [{ name: "  " }, "name"],
      [{ name: "x".repeat(41) }, "name"],
      [{ name, accent: "gold" }, "accent"],
      [{ name, glyph: "Not Valid" }, "glyph"],
      [{ name, glyph: 5 }, "glyph"],
      [{ name, capabilities: [] }, "capabilities"],
      [{ name, capabilities: "x" }, "capabilities"],
      [{ name, capabilities: { browser: "yes" } }, "capabilities.browser"],
      [{ name, capabilities: { delegate: "x" } }, "capabilities.delegate"],
      [{ name, capabilities: { delegate: [1] } }, "capabilities.delegate"],
      [{ name: "Selfie", capabilities: { delegate: ["selfie"] } }, "capabilities.delegate"],
      [{ name, schedules: {} }, "schedules"],
      [{ name, schedules: [null] }, "schedules[0]"],
      [
        {
          name,
          schedules: [
            { name: "a", cron: "* * * * *", prompt: "p" },
            { name: "a", cron: "* * * * *", prompt: "p" },
          ],
        },
        "schedules[1].name",
      ],
      [{ name, schedules: [{ cron: "* * * * *", timezone: "Mars/Base", prompt: "p" }] }, "schedules[0].timezone"],
      [{ name, schedules: [{ cron: "nope", prompt: "p" }] }, "schedules[0].cron"],
      [{ name, schedules: [{ cron: "* * * * *", prompt: "" }] }, "schedules[0].prompt"],
      [
        { name, schedules: [{ cron: "* * * * *", prompt: "p", description: "x".repeat(201) }] },
        "schedules[0].description",
      ],
      [{ name, engine: "x" }, "engine"],
      [{ name, engine: { speed: 1 } }, "engine.speed"],
      [{ name, engine: { account: "mac:claude" } }, "engine.account"],
      [{ name, engine: { account: "Cloud:claude" } }, "engine.account"],
      [{ name, engine: { account: 3 } }, "engine.account"],
      [{ name, engine: { effort: "max" } }, "engine.effort"],
      [{ name, engine: { model: "" } }, "engine.model"],
      [{ name, engine: { fallback: [] } }, "engine.fallback"],
      [{ name, engine: { fallback: { account: "x" } } }, "engine.fallback.account"],
      [{ name, engine: { fallback: { account: "mac:codex" } } }, "engine.fallback.account"],
      [{ name, engine: { fallback: { account: 2 } } }, "engine.fallback.account"],
      [{ name, decisions: [] }, "decisions"],
      [{ name, decisions: { mode: 1 } }, "decisions.mode"],
      [{ name, decisions: { autoApprove: "y" } }, "decisions.autoApprove"],
      [{ name, decisions: { threshold: 2 } }, "decisions.threshold"],
      [{ name, connectors: null }, "connectors"],
      [{ name, connectors: { other: 1 } }, "connectors.other"],
      [{ name, connectors: { allowed: ["Bad Name"] } }, "connectors.allowed"],
      [{ name, connectors: { allowed: "x" } }, "connectors.allowed"],
      [{ name, connectors: { memory: "x" } }, "connectors.memory"],
      [{ name, memory: [] }, "memory"],
      [{ name, memory: { forget: true } }, "memory.forget"],
      [{ name, memory: { recall: "x" } }, "memory.recall"],
      [{ name, permission: "root" }, "permission"],
    ];
    for (const [body, field] of cases) expect({ body, ...(await fieldOf(createBot(body))) }).toMatchObject({ field });
  });
});

describe("updateBot", () => {
  test("returns null for unknown bots and validates the body", async () => {
    expect(await updateBot("missing-bot", {})).toBeNull();
    const bot = await createBot({ name: uniqueName() });
    expect((await fieldOf(updateBot(bot.id, null))).field).toBe("body");
    expect((await fieldOf(updateBot(bot.id, { nope: 1 }))).field).toBe("nope");
    expect((await fieldOf(updateBot(bot.id, { capabilities: null }))).field).toBe("capabilities");
    expect((await fieldOf(updateBot(bot.id, { capabilities: [] }))).field).toBe("capabilities");
    expect((await fieldOf(updateBot(bot.id, { computer: [] }))).field).toBe("computer");
    expect((await fieldOf(updateBot(bot.id, { computer: { allowedRoots: [] } }))).field).toBe("computer.allowedRoots");
    expect((await fieldOf(updateBot(bot.id, { computer: { allowedRoots: ["/a/../b"] } }))).field).toBe(
      "computer.allowedRoots",
    );
    expect((await fieldOf(updateBot(bot.id, { computer: { allowedRoots: [3] } }))).field).toBe("computer.allowedRoots");
    expect((await fieldOf(updateBot(bot.id, { voice: "x" }))).field).toBe("voice");
    expect((await fieldOf(updateBot(bot.id, { voice: { voiceId: "short" } }))).field).toBe("voice.voiceId");
    expect((await fieldOf(updateBot(bot.id, { voice: { speed: 2 } }))).field).toBe("voice.speed");
    expect((await fieldOf(updateBot(bot.id, { voice: { speed: Number.NaN } }))).field).toBe("voice.speed");
    expect((await fieldOf(updateBot(bot.id, { voice: { language: "fr" } }))).field).toBe("voice.language");
    expect((await fieldOf(updateBot(bot.id, { voice: { pitch: 1 } }))).field).toBe("voice.pitch");
  });

  test("updates every field and keeps the rest", async () => {
    const bot = await createBot({ name: uniqueName(), engine: { account: "vps:codex", model: "custom" } });
    const before = changes;
    const updated = await updateBot(bot.id, {
      name: "Renomeado",
      role: "Novo papel",
      accent: "teal",
      glyph: "antenna",
      instructions: "Novas instruções",
      capabilities: { desktop: true },
      schedules: [{ name: "manha", cron: "0 8 * * *", prompt: "Oi" }],
      engine: { effort: "low" },
      decisions: { autoApprove: false },
      connectors: { memory: false },
      memory: { capture: false },
      computer: { allowedRoots: ["~/Code"] },
      voice: { voiceId: "Abcdefgh12", speed: 0.856, language: "en" },
      permission: "readonly",
    });
    expect(updated).toMatchObject({
      name: "Renomeado",
      role: "Novo papel",
      accent: "teal",
      glyph: "antenna",
      instructions: "Novas instruções",
      engine: { account: "vps:codex", model: "custom", effort: "low" },
      decisions: { autoApprove: false, threshold: 0.7 },
      connectors: { allowed: [], memory: false },
      memory: { recall: true, capture: false },
      computer: { allowedRoots: ["~/Code"] },
      voice: { voiceId: "Abcdefgh12", speed: 0.86, language: "en" },
      permission: "readonly",
    });
    expect(updated?.capabilities.desktop).toBe(true);
    expect(updated?.schedules.map((item) => item.name)).toEqual(["manha"]);
    expect(changes).toBe(before + 1);
    const plain = await createBot({ name: uniqueName() });
    delete (plain as Partial<BotDefinition>).engine;
    const engine = await updateBot(plain.id, { engine: { account: "vps:cursor" } });
    expect(engine?.engine).toMatchObject({ account: "vps:cursor", model: defaultModels.cursor });
  });
});

describe("sidebar, archive and delete", () => {
  test("updates the sidebar and clears sections", async () => {
    const bot = await createBot({ name: uniqueName() });
    expect(await updateSidebar("missing-bot", {}, () => true)).toBeNull();
    expect((await fieldOf(updateSidebar(bot.id, "x", () => true))).field).toBe("body");
    expect((await fieldOf(updateSidebar(bot.id, { color: 1 }, () => true))).field).toBe("color");
    expect((await fieldOf(updateSidebar(bot.id, { pinned: "y" }, () => true))).field).toBe("pinned");
    expect((await fieldOf(updateSidebar(bot.id, { sectionId: "sec_x" }, () => false))).field).toBe("sectionId");
    expect((await fieldOf(updateSidebar(bot.id, { sectionId: 4 }, () => true))).field).toBe("sectionId");
    const pinned = await updateSidebar(bot.id, { pinned: true, hidden: true, sectionId: "sec_a" }, () => true);
    expect(pinned?.sidebar).toEqual({ pinned: true, hidden: true, sectionId: "sec_a" });
    expect(listBots().some((item) => item.id === bot.id)).toBe(true);
    expect(listBots(false, { hidden: false }).some((item) => item.id === bot.id)).toBe(false);
    const other = await createBot({ name: uniqueName() });
    await clearSection("sec_a");
    expect(getBot(bot.id)?.sidebar).toEqual({ pinned: true, hidden: true, sectionId: null });
    expect(getBot(other.id)?.sidebar).toBeUndefined();
    const cleared = await updateSidebar(bot.id, { sectionId: null }, () => false);
    expect(cleared?.sidebar?.sectionId).toBeNull();
  });

  test("archives and deletes idempotently", async () => {
    const bot = await createBot({ name: uniqueName() });
    expect(await setArchived("missing-bot", true)).toBeNull();
    expect(await setDeleted("missing-bot", true)).toBeNull();
    const archived = await setArchived(bot.id, true);
    expect((await setArchived(bot.id, true))?.archivedAt).toBe(archived?.archivedAt ?? "");
    expect(listBots().some((item) => item.id === bot.id)).toBe(false);
    expect(listBots(true).some((item) => item.id === bot.id)).toBe(true);
    expect((await setArchived(bot.id, false))?.archivedAt).toBeNull();
    const deleted = await setDeleted(bot.id, true);
    expect((await setDeleted(bot.id, true))?.deletedAt).toBe(deleted?.deletedAt ?? "");
    expect(listBots().some((item) => item.id === bot.id)).toBe(false);
    expect(listBots(false, { deleted: true }).some((item) => item.id === bot.id)).toBe(true);
    expect((await setDeleted(bot.id, false))?.deletedAt).toBeNull();
  });
});

describe("bots repository", () => {
  test("round-trips rows, fills defaults and keeps extra fields", async () => {
    const row = botToRow({ id: "row-only", builtIn: true, legacy: "keep" });
    expect(row).toMatchObject({
      id: "row-only",
      name: "row-only",
      role: "",
      builtIn: true,
      capabilities: {},
      schedules: [],
      engine: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      archivedAt: null,
      deletedAt: null,
      extra: { legacy: "keep" },
    });
    const back = botFromRow(row) as BotDefinition & { builtIn?: boolean; legacy?: string };
    expect(back.builtIn).toBe(true);
    expect(back.legacy).toBe("keep");
    expect(back.engine).toBeUndefined();
    const full = await createBot({ name: uniqueName(), permission: "full" });
    const again = botFromRow(botToRow(full as unknown as Record<string, unknown>));
    expect(again).toMatchObject({ id: full.id, permission: "full", engine: full.engine });

    await saveBotRow({ id: "loaded-bot", name: "Loaded", capabilities: { browser: false, delegate: [] } });
    await saveBotRow({ id: "", name: "No id" });
    await loadBots();
    expect(getBot("loaded-bot")?.capabilities).toEqual({
      browser: true,
      computer: true,
      delegate: [],
    });
    expect(getBot("")).toBeUndefined();
    await deleteBotRow("loaded-bot");
    await deleteBotRow("");
    expect((await loadBotRows()).some((item) => item.id === "loaded-bot")).toBe(false);
    expect((await getDb().select().from(botsTable)).length).toBeGreaterThan(0);
  });
});
