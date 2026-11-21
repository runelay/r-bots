import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { BoxStatus, EnvironmentInfo } from "@runelay-bots/protocol";
import { startTestServer, type TestServer } from "../../../../test/helpers";
import type { AuthModule, Principal } from "../../auth";
import { useAuthModule } from "../../auth/gate";
import * as turnQueue from "../../engine/services/turn-queue.service";
import { localEnvironment, metricsContentType, turnDurationBuckets } from "../constants/metrics.constants";
import {
  escapeHelp,
  escapeLabelValue,
  formatFamily,
  formatValue,
  observeTurnDuration,
  renderMetrics,
  resetTurnDurations,
  setEnvironmentSource,
} from "../services/metrics.service";

let server: TestServer;
const restores: Array<() => void> = [];

beforeAll(async () => {
  server = await startTestServer();
});

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  useAuthModule(null);
  setEnvironmentSource(null);
  resetTurnDurations();
});

afterAll(async () => {
  await server.close();
});

function box(botId: string, state: BoxStatus["state"], memMb: number): BoxStatus {
  return { botId, state, memMb, startedAt: "2026-11-21T10:00:00.000Z", lastUsedAt: "2026-11-21T10:05:00.000Z" };
}

const runner: EnvironmentInfo = {
  id: "vps-2",
  name: "VPS 2",
  kind: "runner",
  connected: true,
  capabilities: ["turns", "boxes", "mcp-proxy", "hooks"],
  runtime: "runsc",
  capacity: { cpus: 8, memTotalMb: 16_000, memFreeMb: 9_216, boxesRunning: 2, boxesPaused: 1, maxBoxes: 6 },
  boxes: [box("bot-a", "running", 812), box('bot "b"\\x\ny', "running", 400), box("bot-c", "paused", 256)],
};

function lines(text: string) {
  return text.split("\n");
}

describe("text format helpers", () => {
  test("escapes label values and help text the way Prometheus parses them", () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    expect(escapeLabelValue("plain")).toBe("plain");
    expect(escapeHelp('back\\slash "kept"\nnext')).toBe('back\\\\slash "kept"\\nnext');
  });

  test("formats special float values", () => {
    expect(formatValue(Number.NaN)).toBe("NaN");
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe("+Inf");
    expect(formatValue(Number.NEGATIVE_INFINITY)).toBe("-Inf");
    expect(formatValue(1.5)).toBe("1.5");
    expect(formatValue(0)).toBe("0");
  });

  test("writes HELP and TYPE before the samples, with and without labels", () => {
    expect(
      formatFamily({
        name: "x_total",
        help: "line\nbreak",
        type: "gauge",
        samples: [
          { labels: {}, value: 3 },
          { suffix: "_extra", labels: { a: "1", b: 'q"' }, value: 2 },
        ],
      }),
    ).toBe('# HELP x_total line\\nbreak\n# TYPE x_total gauge\nx_total 3\nx_total_extra{a="1",b="q\\""} 2');
  });
});

describe("renderMetrics", () => {
  test("shows only the local environment without boxes when nothing is registered", () => {
    const text = renderMetrics({ running: 2, queued: 5 });
    expect(text.endsWith("\n")).toBe(true);
    const output = lines(text);
    expect(output).toContain("# TYPE rbots_turns_running gauge");
    expect(output).toContain("rbots_turns_running 2");
    expect(output).toContain("rbots_turns_queued 5");
    expect(output).toContain('rbots_environment_boxes{env="local",state="running"} 0');
    expect(output).toContain('rbots_environment_boxes{env="local",state="paused"} 0');
    expect(output).toContain('rbots_environment_boxes{env="local",state="stopped"} 0');
    expect(output.filter((line) => line.startsWith("rbots_environment_mem_free_mb"))).toEqual([]);
    expect(output.filter((line) => line.startsWith("rbots_box_mem_mb"))).toEqual([]);
    expect(output).toContain("# TYPE rbots_turn_duration_seconds histogram");
    expect(output.filter((line) => line.startsWith("rbots_turn_duration_seconds"))).toEqual([]);
    for (const name of [
      "rbots_turns_running",
      "rbots_turns_queued",
      "rbots_environment_mem_free_mb",
      "rbots_environment_boxes",
      "rbots_box_mem_mb",
      "rbots_turn_duration_seconds",
    ]) {
      expect(output.filter((line) => line.startsWith(`# HELP ${name} `))).toHaveLength(1);
      expect(output.filter((line) => line.startsWith(`# TYPE ${name} `))).toHaveLength(1);
    }
  });

  test("reads the registered environment source with free memory, boxes by state and memory per box", () => {
    setEnvironmentSource(() => [localEnvironment, runner]);
    const output = lines(renderMetrics({ running: 0, queued: 0 }));
    expect(output).toContain('rbots_environment_mem_free_mb{env="vps-2"} 9216');
    expect(output).toContain('rbots_environment_boxes{env="vps-2",state="running"} 2');
    expect(output).toContain('rbots_environment_boxes{env="vps-2",state="paused"} 1');
    expect(output).toContain('rbots_environment_boxes{env="vps-2",state="stopped"} 0');
    expect(output).toContain('rbots_box_mem_mb{env="vps-2",bot="bot-a"} 812');
    expect(output).toContain('rbots_box_mem_mb{env="vps-2",bot="bot \\"b\\"\\\\x\\ny"} 400');
    expect(output).toContain('rbots_box_mem_mb{env="vps-2",bot="bot-c"} 256');
    expect(output.filter((line) => line.startsWith('rbots_environment_mem_free_mb{env="local"'))).toEqual([]);
  });

  test("goes back to the local default when the source is cleared", () => {
    setEnvironmentSource(() => [runner]);
    setEnvironmentSource(null);
    expect(renderMetrics({ running: 0, queued: 0 })).not.toContain("vps-2");
  });

  test("keeps a cumulative turn duration histogram per provider", () => {
    observeTurnDuration("codex", 0.5);
    observeTurnDuration("claude", 12);
    observeTurnDuration("claude", 4000);
    observeTurnDuration("claude", 1);
    observeTurnDuration("claude", -1);
    observeTurnDuration("claude", Number.NaN);
    observeTurnDuration("claude", Number.POSITIVE_INFINITY);
    const output = lines(renderMetrics({ running: 0, queued: 0 }));
    const claude = output.filter((line) => line.startsWith('rbots_turn_duration_seconds_bucket{provider="claude"'));
    expect(claude).toHaveLength(turnDurationBuckets.length + 1);
    expect(claude).toEqual([
      'rbots_turn_duration_seconds_bucket{provider="claude",le="1"} 1',
      'rbots_turn_duration_seconds_bucket{provider="claude",le="5"} 1',
      'rbots_turn_duration_seconds_bucket{provider="claude",le="15"} 2',
      'rbots_turn_duration_seconds_bucket{provider="claude",le="30"} 2',
      'rbots_turn_duration_seconds_bucket{provider="claude",le="60"} 2',
      'rbots_turn_duration_seconds_bucket{provider="claude",le="120"} 2',
      'rbots_turn_duration_seconds_bucket{provider="claude",le="300"} 2',
      'rbots_turn_duration_seconds_bucket{provider="claude",le="600"} 2',
      'rbots_turn_duration_seconds_bucket{provider="claude",le="1200"} 2',
      'rbots_turn_duration_seconds_bucket{provider="claude",le="1800"} 2',
      'rbots_turn_duration_seconds_bucket{provider="claude",le="3600"} 2',
      'rbots_turn_duration_seconds_bucket{provider="claude",le="+Inf"} 3',
    ]);
    expect(output).toContain('rbots_turn_duration_seconds_sum{provider="claude"} 4013');
    expect(output).toContain('rbots_turn_duration_seconds_count{provider="claude"} 3');
    expect(output).toContain('rbots_turn_duration_seconds_bucket{provider="codex",le="1"} 1');
    expect(output).toContain('rbots_turn_duration_seconds_count{provider="codex"} 1');
    const firstClaude = output.findIndex((line) => line.includes('provider="claude"'));
    const firstCodex = output.findIndex((line) => line.includes('provider="codex"'));
    expect(firstClaude).toBeLessThan(firstCodex);
  });
});

describe("GET /metrics", () => {
  test("answers the Prometheus text format with the live turn counts", async () => {
    const stats = spyOn(turnQueue, "turnStats").mockResolvedValue({ running: 1, queued: 4, failed: 0, max: 3 });
    restores.push(() => stats.mockRestore());
    observeTurnDuration("grok", 2);
    const response = await fetch(`${server.url}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(metricsContentType);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const output = lines(await response.text());
    expect(output).toContain("rbots_turns_running 1");
    expect(output).toContain("rbots_turns_queued 4");
    expect(output).toContain('rbots_turn_duration_seconds_count{provider="grok"} 1');
  });

  test("uses the same gate as /status: no principal is refused, a signed-in user is let through", async () => {
    const auth = (principal: Principal | null) =>
      useAuthModule({
        authenticate: async () => (principal ? { kind: "principal", principal } : { kind: "public" }),
        handle: async () => null,
      } as unknown as AuthModule);
    auth(null);
    const [anonymousMetrics, anonymousStatus] = await Promise.all([
      fetch(`${server.url}/metrics`),
      fetch(`${server.url}/status`),
    ]);
    expect([anonymousMetrics.status, anonymousStatus.status]).toEqual([401, 401]);
    expect(await anonymousMetrics.text()).not.toContain("rbots_");
    auth({ userId: "o", email: "o@x.co", name: "O", role: "owner", method: "session" });
    const [metrics, status] = await Promise.all([fetch(`${server.url}/metrics`), fetch(`${server.url}/status`)]);
    expect([metrics.status, status.status]).toEqual([200, 200]);
    expect(await metrics.text()).toContain("rbots_turns_running");
    auth({ userId: "o", email: "o@x.co", name: "O", role: "owner", method: "internal" });
    const scraped = await fetch(`${server.url}/metrics`);
    expect(scraped.status).toBe(200);
    expect(await scraped.text()).toContain("rbots_turns_running");
  });
});
