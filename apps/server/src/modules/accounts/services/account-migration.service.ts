import type { Provider } from "@runelay-bots/protocol";
import { model as defaultClaudeModel } from "../../../config/env";
import { type BotEngine, listBots, updateBot } from "../../bots/services/bots.service";
import { type Account, defaultAccount, isLegacyMacAccount, listAccounts } from "./accounts.service";
import { macAccounts, macRunnerConnections } from "./mac-runner.service";

export type EmailHints = Partial<Record<Provider, string>>;

export async function macEmailHints(timeoutMs = 5000): Promise<EmailHints> {
  const live = macRunnerConnections()[0];
  if (!live) return {};
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), timeoutMs).unref(),
    );
    const probes = await Promise.race([macAccounts(live.key), timeout]);
    const hints: EmailHints = {};
    for (const item of probes) {
      const email = item.detail.split(" · ")[0]?.trim().toLowerCase();
      if (email?.includes("@")) hints[item.provider] = email;
    }
    return hints;
  } catch {
    return {};
  }
}

export function replacementFor(
  target: { account: string; model: string },
  accounts: Account[],
  hints: EmailHints,
): { account: string; model: string } | null {
  if (!isLegacyMacAccount(target.account)) return null;
  const provider = target.account.split(":")[1] as Provider;
  const ready = accounts.filter((account) => account.provider === provider && account.status === "ready");
  const hint = hints[provider];
  const same =
    (hint ? ready.find((account) => account.email?.toLowerCase() === hint) : undefined) ??
    ready.find((account) => account.isDefault) ??
    ready[0];
  if (same) return { account: same.id, model: target.model };
  const claude = defaultAccount(accounts, "claude");
  return { account: claude?.id ?? "vps:claude", model: defaultClaudeModel };
}

export function migratedEngine(engine: BotEngine, accounts: Account[], hints: EmailHints): BotEngine | null {
  const main = replacementFor(engine, accounts, hints);
  const fallback = engine.fallback ? replacementFor(engine.fallback, accounts, hints) : null;
  if (!main && !fallback) return null;
  const next: BotEngine = { ...engine, ...(main ?? {}) };
  if (main && main.account.split(":")[1] !== engine.account.split(":")[1]) next.effort = null;
  if (fallback) next.fallback = fallback.account === next.account ? null : fallback;
  return next;
}

export async function migrateBotAccounts() {
  const legacy = listBots(true, { deleted: true }).filter(
    (bot) =>
      bot.engine &&
      (isLegacyMacAccount(bot.engine.account) ||
        (bot.engine.fallback && isLegacyMacAccount(bot.engine.fallback.account))),
  );
  if (legacy.length === 0) return [];
  const [accounts, hints] = await Promise.all([listAccounts(), macEmailHints()]);
  const moved: Array<{ botId: string; from: string; to: string }> = [];
  for (const bot of legacy) {
    const engine = bot.engine as BotEngine;
    const next = migratedEngine(engine, accounts, hints);
    if (!next) continue;
    await updateBot(bot.id, { engine: next });
    moved.push({ botId: bot.id, from: engine.account, to: next.account });
  }
  return moved;
}
