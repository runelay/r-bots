import type { EnvironmentInfo } from "@runelay-bots/protocol";
import { turnStats } from "../../engine/services/turn-queue.service";
import { boxStates, localEnvironment, turnDurationBuckets } from "../constants/metrics.constants";
import type {
  EnvironmentSource,
  HistogramSeries,
  MetricFamily,
  MetricLabels,
  MetricSample,
  TurnCounts,
} from "../types/metrics.types";

const defaultSource: EnvironmentSource = () => [localEnvironment];

let environmentSource: EnvironmentSource = defaultSource;
const turnDurations = new Map<string, HistogramSeries>();

export function setEnvironmentSource(source: EnvironmentSource | null) {
  environmentSource = source ?? defaultSource;
}

export function observeTurnDuration(provider: string, seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  const series = turnDurations.get(provider) ?? { buckets: turnDurationBuckets.map(() => 0), count: 0, sum: 0 };
  turnDurationBuckets.forEach((bound, index) => {
    if (seconds <= bound) series.buckets[index] += 1;
  });
  series.count += 1;
  series.sum += seconds;
  turnDurations.set(provider, series);
}

export function resetTurnDurations() {
  turnDurations.clear();
}

export function escapeLabelValue(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export function escapeHelp(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

export function formatValue(value: number) {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

function formatLabels(labels: MetricLabels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

export function formatFamily({ name, help, type, samples }: MetricFamily) {
  const lines = [`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} ${type}`];
  for (const { suffix = "", labels, value } of samples)
    lines.push(`${name}${suffix}${formatLabels(labels)} ${formatValue(value)}`);
  return lines.join("\n");
}

function histogramSamples(): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const [provider, { buckets, count, sum }] of [...turnDurations.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    turnDurationBuckets.forEach((bound, index) => {
      samples.push({ suffix: "_bucket", labels: { provider, le: String(bound) }, value: buckets[index] });
    });
    samples.push({ suffix: "_bucket", labels: { provider, le: "+Inf" }, value: count });
    samples.push({ suffix: "_sum", labels: { provider }, value: sum });
    samples.push({ suffix: "_count", labels: { provider }, value: count });
  }
  return samples;
}

function environmentFamilies(environments: EnvironmentInfo[]): MetricFamily[] {
  const memFree: MetricSample[] = [];
  const boxes: MetricSample[] = [];
  const boxMem: MetricSample[] = [];
  for (const { id, capacity, boxes: list } of environments) {
    if (capacity) memFree.push({ labels: { env: id }, value: capacity.memFreeMb });
    for (const state of boxStates)
      boxes.push({ labels: { env: id, state }, value: list.filter((box) => box.state === state).length });
    for (const { botId, memMb } of list) boxMem.push({ labels: { env: id, bot: botId }, value: memMb });
  }
  return [
    {
      name: "rbots_environment_mem_free_mb",
      help: "Free memory reported by the environment, in megabytes.",
      type: "gauge",
      samples: memFree,
    },
    { name: "rbots_environment_boxes", help: "Boxes in the environment by state.", type: "gauge", samples: boxes },
    { name: "rbots_box_mem_mb", help: "Memory used by each bot box, in megabytes.", type: "gauge", samples: boxMem },
  ];
}

export function renderMetrics({ running, queued }: TurnCounts) {
  const families: MetricFamily[] = [
    {
      name: "rbots_turns_running",
      help: "Turns running now.",
      type: "gauge",
      samples: [{ labels: {}, value: running }],
    },
    {
      name: "rbots_turns_queued",
      help: "Turns waiting for a slot.",
      type: "gauge",
      samples: [{ labels: {}, value: queued }],
    },
    ...environmentFamilies(environmentSource()),
    {
      name: "rbots_turn_duration_seconds",
      help: "Duration of provider turns, in seconds.",
      type: "histogram",
      samples: histogramSamples(),
    },
  ];
  return `${families.map(formatFamily).join("\n")}\n`;
}

export async function metricsText() {
  const { running, queued } = await turnStats();
  return renderMetrics({ running, queued });
}
