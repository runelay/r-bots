import type { CliSpawn } from "../../providers/types/providers.types";
import type { toolNames } from "../constants/tools.constants";

export type ToolName = (typeof toolNames)[number];

export type ToolSource = "managed" | "image" | "system" | "override";

export interface ToolState {
  tool: ToolName;
  installed: boolean;
  source: ToolSource | null;
  version: string | null;
  path: string | null;
  sizeBytes: number | null;
  downloadMb: number;
  installing: boolean;
  lastError: string | null;
}

export type ToolDownload = (url: string, file: string, timeoutMs: number) => Promise<void>;

export interface ToolDeps {
  root: () => string;
  arch: () => string;
  spawn: CliSpawn;
  download: ToolDownload;
  hash: (file: string) => Promise<string>;
  which: (names: string[]) => string | null;
  chromeOverride: () => string | null;
  images: Record<ToolName, string>;
  log: (message: string) => void;
}
