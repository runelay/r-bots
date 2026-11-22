import { describe, expect, test } from "bun:test";
import { emptyUsage, environmentIds, environmentLabels, hostCapability, providerLabels, providers } from "../index";

describe("protocol", () => {
  test("lists every provider with a label", () => {
    expect([...providers]).toEqual(["claude", "codex", "grok", "cursor"]);
    for (const provider of providers) expect(providerLabels[provider]).toBeString();
    expect(providerLabels.codex).toBe("ChatGPT · Codex");
  });

  test("emptyUsage returns a fresh zeroed object each call", () => {
    const first = emptyUsage();
    expect(first).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    first.inputTokens = 5;
    expect(emptyUsage().inputTokens).toBe(0);
  });

  test("names the host runner capability and the environments a turn can run in", () => {
    expect(hostCapability).toBe("host");
    expect([...environmentIds]).toEqual(["vps", "mac"]);
    expect(environmentLabels).toEqual({ vps: "VPS", mac: "Pessoal" });
  });
});
