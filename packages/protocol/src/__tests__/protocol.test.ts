import { describe, expect, test } from "bun:test";
import { emptyUsage, providerLabels, providers } from "../index";

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
});
