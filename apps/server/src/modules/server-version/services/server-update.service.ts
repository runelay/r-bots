import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../../../config/env";
import { readJson, writeJson } from "../../../shared/json-file";
import { turnStats } from "../../engine/services/turn-queue.service";
import {
  updateAgentFile,
  updateDirName,
  updatePickupMs,
  updateRequestFile,
  updateStaleMs,
  updateStates,
  updateStatusFile,
} from "../constants/server-version.constants";
import type {
  ServerUpdate,
  ServerUpdateDeps,
  ServerUpdateState,
  UpdateRequest,
  UpdateRequestResult,
} from "../types/server-version.types";

interface UpdateStatusFile {
  id: string | null;
  state: ServerUpdateState;
  step?: string;
  message?: string;
  from?: string;
  to?: string;
  finishedAt?: string;
  updatedAt: number | null;
}

const defaults: ServerUpdateDeps = {
  dir: () => join(dataDir, updateDirName),
  runningTurns: async () => (await turnStats()).running,
  now: () => Date.now(),
  newId: () => randomUUID(),
};

let deps = defaults;
let queue: Promise<unknown> = Promise.resolve();

export function useServerUpdateDeps(overrides: Partial<ServerUpdateDeps> | null) {
  deps = overrides ? { ...defaults, ...overrides } : defaults;
}

function pathOf(file: string) {
  return join(deps.dir(), file);
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isState(value: unknown): value is ServerUpdateState {
  return typeof value === "string" && (updateStates as readonly string[]).includes(value);
}

export function parseUpdateStatus(value: unknown): UpdateStatusFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!isState(item.state)) return null;
  const updatedAt = Date.parse(text(item.updatedAt) ?? "");
  const status: UpdateStatusFile = {
    id: text(item.id) ?? null,
    state: item.state,
    updatedAt: Number.isNaN(updatedAt) ? null : updatedAt,
  };
  for (const key of ["step", "message", "from", "to", "finishedAt"] as const) {
    const field = text(item[key]);
    if (field) status[key] = field.slice(0, 500);
  }
  return status;
}

function isStale(status: UpdateStatusFile) {
  return status.updatedAt === null || deps.now() - status.updatedAt > updateStaleMs;
}

function publicOf(available: boolean, status: UpdateStatusFile): ServerUpdate {
  const { id: _id, updatedAt: _updatedAt, ...rest } = status;
  return { available, ...rest };
}

export async function readServerUpdate(): Promise<ServerUpdate> {
  const available = await exists(pathOf(updateAgentFile));
  const status = parseUpdateStatus(await readJson<unknown>(pathOf(updateStatusFile), null));
  const request = await readJson<Partial<UpdateRequest> | null>(pathOf(updateRequestFile), null);
  if (request && typeof request === "object") {
    const claimed = Boolean(status?.id) && status?.id === text(request.id);
    if (!claimed || (status?.state !== "running" && status?.state !== "queued")) {
      const requestedAt = Date.parse(text(request.requestedAt) ?? "");
      if (!Number.isNaN(requestedAt) && deps.now() - requestedAt > updatePickupMs) {
        return {
          available,
          state: "failed",
          message: "O vigia não pegou o pedido. Rode rbots update no servidor.",
        };
      }
      return { available, state: "queued" };
    }
  }
  if (!status) return { available, state: "idle" };
  if (status.state === "running" && isStale(status)) {
    return {
      ...publicOf(available, status),
      state: "failed",
      message: status.message ?? "O vigia parou de dar notícia no meio da atualização. Veja rbots logs no servidor.",
    };
  }
  return publicOf(available, status);
}

function inProgress(update: ServerUpdate) {
  return update.state === "queued" || update.state === "running";
}

async function writeRequest(force: boolean): Promise<UpdateRequestResult> {
  const current = await readServerUpdate();
  if (!current.available) return { ok: false, status: 422, code: "agent_missing" };
  if (inProgress(current)) return { ok: false, status: 409, code: "update_in_progress" };
  if (!force) {
    const running = await deps.runningTurns();
    if (running > 0) return { ok: false, status: 409, code: "turns_running", running };
  }
  const request: UpdateRequest = {
    id: deps.newId(),
    requestedAt: new Date(deps.now()).toISOString(),
    force,
  };
  await writeJson(pathOf(updateRequestFile), request);
  return { ok: true, update: { available: true, state: "queued" } };
}

export function requestServerUpdate(force: boolean) {
  const next = queue.then(() => writeRequest(force));
  queue = next.catch(() => undefined);
  return next;
}
