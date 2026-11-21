import { describe, expect, test } from "bun:test";
import { builtInPresets, composeMessage, presetOf } from "../services/review.service";

describe("review presets", () => {
  test("ships the built-in presets", () => {
    expect(builtInPresets().map((preset) => preset.id)).toEqual(["daily", "week", "pulls"]);
  });

  test("validates a preset", () => {
    expect(presetOf({ id: "a", name: " Daily ", prompt: "Resuma", scope: "custom", days: 3 }, 0)).toEqual({
      id: "a",
      name: "Daily",
      prompt: "Resuma",
      scope: "custom",
      days: 3,
      linear: true,
      github: true,
      botId: null,
    });
    expect(() => presetOf({ name: "x", prompt: "y", scope: "year" }, 0)).toThrow();
    expect(() => presetOf({ name: "x", prompt: "y", scope: "custom", days: 120 }, 0)).toThrow();
    expect(() => presetOf({ name: "x", prompt: "y", scope: "today", linear: false, github: false }, 0)).toThrow();
  });

  test("composes a compact message", () => {
    const [daily] = builtInPresets();
    const message = composeMessage(daily, { since: "2026-11-20T00:00:00-03:00", day: "2026-11-20", label: "hoje" }, [
      "## Linear\n\n- ENG-1 Algo · Em progresso",
    ]);
    expect(message.startsWith(daily.prompt)).toBe(true);
    expect(message).toContain("Período: hoje (desde 2026-11-20).");
    expect(message).toContain("- ENG-1 Algo · Em progresso");
  });
});
