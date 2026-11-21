import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AccountProbe } from "@runelay-bots/protocol";
import { makeBot } from "../../../../test/engine-helpers";
import { getBot } from "../../bots/services/bots.service";
import {
  macEmailHints,
  migrateBotAccounts,
  migratedEngine,
  replacementFor,
} from "../services/account-migration.service";
import type { Account } from "../services/accounts.service";
import * as accounts from "../services/accounts.service";
import * as macRunner from "../services/mac-runner.service";

const restores: Array<{ mockRestore(): void }> = [];

function track<T extends { mockRestore(): void }>(spy: T) {
  restores.push(spy);
  return spy;
}

afterEach(() => {
  for (const spy of restores.splice(0).reverse()) spy.mockRestore();
});

function account(id: string, extra: Partial<Account> = {}): Account {
  const provider = id.split(":")[1] as Account["provider"];
  return {
    id,
    runner: "vps",
    provider,
    label: id,
    name: id,
    autoName: id,
    email: null,
    plan: null,
    configDir: null,
    isDefault: false,
    added: false,
    status: "ready",
    models: [],
    detail: "",
    checkedAt: "",
    ...extra,
  };
}

const list = [
  account("vps:claude", { email: "ferramentas@x.com", isDefault: true }),
  account("claude-2:claude", { email: "alex@x.com" }),
  account("vps:codex", { isDefault: true }),
  account("vps:cursor", { status: "missing" }),
];

function connected(probes: AccountProbe[] | Error | "hang") {
  track(spyOn(macRunner, "macRunnerConnections").mockReturnValue([{ key: "k1", name: "Mac", rank: 1 }] as never));
  track(
    spyOn(macRunner, "macAccounts").mockImplementation(() =>
      probes === "hang"
        ? new Promise<never>(() => undefined)
        : probes instanceof Error
          ? Promise.reject(probes)
          : Promise.resolve(probes),
    ),
  );
}

describe("bot migration off the Mac", () => {
  test("moves a Mac account to the server account with the same e-mail, then the default", () => {
    const hints = { claude: "alex@x.com" };
    expect(replacementFor({ account: "mac:claude", model: "m" }, list, hints)).toEqual({
      account: "claude-2:claude",
      model: "m",
    });
    expect(replacementFor({ account: "mac-ab12:claude", model: "m" }, list, {})).toEqual({
      account: "vps:claude",
      model: "m",
    });
    expect(replacementFor({ account: "mac:codex", model: "g" }, list, {})).toEqual({
      account: "vps:codex",
      model: "g",
    });
    expect(replacementFor({ account: "mac:cursor", model: "auto" }, list, {})).toMatchObject({ account: "vps:claude" });
    expect(replacementFor({ account: "mac:cursor", model: "auto" }, [], {})).toMatchObject({ account: "vps:claude" });
    expect(
      replacementFor({ account: "mac:claude", model: "m" }, [account("a:claude"), account("b:claude")], {}),
    ).toEqual({ account: "a:claude", model: "m" });
    expect(replacementFor({ account: "vps:claude", model: "m" }, list, {})).toBeNull();
  });

  test("migrates the main account and the reserve without pointing a bot at itself", () => {
    expect(migratedEngine({ account: "vps:claude", model: "m", effort: null }, list, {})).toBeNull();
    expect(
      migratedEngine({ account: "mac:cursor", model: "auto", effort: "high", fallback: null }, list, {}),
    ).toMatchObject({ account: "vps:claude", effort: null, fallback: null });
    expect(
      migratedEngine(
        { account: "mac:codex", model: "g", effort: "low", fallback: { account: "mac:claude", model: "m" } },
        list,
        {},
      ),
    ).toEqual({ account: "vps:codex", model: "g", effort: "low", fallback: { account: "vps:claude", model: "m" } });
    expect(
      migratedEngine(
        { account: "vps:claude", model: "m", effort: null, fallback: { account: "mac:claude", model: "m" } },
        list,
        {},
      ),
    ).toEqual({ account: "vps:claude", model: "m", effort: null, fallback: null });
  });

  test("reads e-mail hints from a connected Mac and gives up quietly", async () => {
    expect(await macEmailHints()).toEqual({});
    connected([
      { provider: "claude", status: "ready", detail: "Alex@x.com · max", models: [] },
      { provider: "codex", status: "ready", detail: "Logged in using ChatGPT", models: [] },
    ]);
    expect(await macEmailHints()).toEqual({ claude: "alex@x.com" });
    for (const spy of restores.splice(0)) spy.mockRestore();
    connected(new Error("caiu"));
    expect(await macEmailHints()).toEqual({});
    for (const spy of restores.splice(0)) spy.mockRestore();
    connected("hang");
    expect(await macEmailHints(5)).toEqual({});
  });

  test("rewrites the bots that still point at the Mac", async () => {
    track(spyOn(accounts, "listAccounts").mockResolvedValue(list));
    connected([{ provider: "claude", status: "ready", detail: "alex@x.com · team", models: [] }]);
    const mac = await makeBot();
    mac.engine = { account: "mac:claude", model: "claude-opus-5-5", effort: "high" };
    const reserve = await makeBot();
    reserve.engine = {
      account: "vps:codex",
      model: "g",
      effort: null,
      fallback: { account: "mac:cursor", model: "auto" },
    };
    const plain = await makeBot();
    const moved = await migrateBotAccounts();
    expect(moved).toEqual(
      expect.arrayContaining([
        { botId: mac.id, from: "mac:claude", to: "claude-2:claude" },
        { botId: reserve.id, from: "vps:codex", to: "vps:codex" },
      ]),
    );
    expect(getBot(mac.id)?.engine).toMatchObject({
      account: "claude-2:claude",
      model: "claude-opus-5-5",
      effort: "high",
    });
    expect(getBot(reserve.id)?.engine?.fallback).toMatchObject({ account: "vps:claude" });
    expect(moved.some((item) => item.botId === plain.id)).toBe(false);
    expect(await migrateBotAccounts()).toEqual([]);
  });
});
