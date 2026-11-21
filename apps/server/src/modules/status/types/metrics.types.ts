import type { EnvironmentInfo } from "@runelay-bots/protocol";

export type MetricType = "gauge" | "histogram";

export type MetricLabels = Record<string, string>;

export interface MetricSample {
  suffix?: string;
  labels: MetricLabels;
  value: number;
}

export interface MetricFamily {
  name: string;
  help: string;
  type: MetricType;
  samples: MetricSample[];
}

export interface TurnCounts {
  running: number;
  queued: number;
}

export interface HistogramSeries {
  buckets: number[];
  count: number;
  sum: number;
}

export type EnvironmentSource = () => EnvironmentInfo[];
