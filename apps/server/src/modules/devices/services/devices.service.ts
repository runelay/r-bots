import { randomUUID } from "node:crypto";
import { ValidationError } from "../../../shared/errors";
import {
  disconnectMacDevice,
  macDeviceLastSeen,
  macRunnerConnections,
} from "../../accounts/services/mac-runner.service";
import type { Principal } from "../../auth";
import { authActive, currentAuthModule } from "../../auth/gate";
import { dateText, parseKeyMetadata } from "../../auth/services/auth.middleware";
import { apiKeyPrefix, ownerRole } from "../../auth/services/auth.service";

export const deviceKeyName = "device";

export interface DeviceRecord {
  id: string;
  keyId: string;
  userId: string;
  name: string;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  machineId: string | null;
  registeredAt: string;
}

export class DevicesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Where = { field: string; value: string };
type Adapter = {
  findMany: (input: { model: string; where?: Where[] }) => Promise<unknown[]>;
  delete: (input: { model: string; where: Where[] }) => Promise<unknown>;
};

function moduleOrFail() {
  const module = currentAuthModule();
  if (!module || !authActive())
    throw new DevicesError(401, "unauthorized", "Entre na sua conta para gerenciar dispositivos.");
  return module;
}

async function adapterOf(module: NonNullable<ReturnType<typeof currentAuthModule>>) {
  const context = await module.auth.$context;
  return context.adapter as unknown as Adapter;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toRecord(row: unknown): DeviceRecord | null {
  if (!row || typeof row !== "object") return null;
  const item = row as { id?: unknown; name?: unknown; referenceId?: unknown; metadata?: unknown };
  if (item.name !== deviceKeyName || typeof item.id !== "string") return null;
  const metadata = parseKeyMetadata(item.metadata);
  const id = text(metadata.deviceId);
  if (metadata.kind !== "device" || !id) return null;
  return {
    id,
    keyId: item.id,
    userId: typeof item.referenceId === "string" ? item.referenceId : "",
    name: text(metadata.name) ?? "Mac",
    model: text(metadata.model),
    osVersion: text(metadata.osVersion),
    appVersion: text(metadata.appVersion),
    machineId: text(metadata.machineId),
    registeredAt: dateText(metadata.registeredAt) || new Date(0).toISOString(),
  };
}

async function deviceRows(adapter: Adapter, userId?: string) {
  const where: Where[] = [{ field: "name", value: deviceKeyName }];
  if (userId) where.push({ field: "referenceId", value: userId });
  const rows = await adapter.findMany({ model: "apikey", where });
  return rows.map(toRecord).filter((item): item is DeviceRecord => item !== null);
}

export async function listRegisteredDevices() {
  const module = currentAuthModule();
  if (!module || !authActive()) return [];
  let records: DeviceRecord[];
  try {
    records = await deviceRows(await adapterOf(module));
  } catch {
    return [];
  }
  const unique = new Map<string, DeviceRecord>();
  for (const record of records) if (!unique.has(record.id)) unique.set(record.id, record);
  return [...unique.values()].sort((a, b) => a.registeredAt.localeCompare(b.registeredAt) || a.id.localeCompare(b.id));
}

function field(body: Record<string, unknown>, name: string, max: number, required = false) {
  const value = body[name];
  if (value === undefined || value === null || value === "") {
    if (required) throw new ValidationError(`Falta ${name}.`, name);
    return null;
  }
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new ValidationError(`${name} precisa ser um texto de até ${max} caracteres.`, name);
  return value.trim();
}

export async function registerDevice(principal: Principal, body: unknown) {
  const module = moduleOrFail();
  if (principal.method !== "session")
    throw new DevicesError(403, "forbidden", "Entre pelo app para registrar este Mac.");
  const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const name = field(input, "name", 80, true) as string;
  const model = field(input, "model", 80);
  const osVersion = field(input, "osVersion", 40);
  const appVersion = field(input, "appVersion", 40);
  const machineId = field(input, "machineId", 128);
  const adapter = await adapterOf(module);
  const previous = machineId
    ? (await deviceRows(adapter, principal.userId)).filter((item) => item.machineId === machineId)
    : [];
  const deviceId = previous[0]?.id ?? randomUUID();
  const registeredAt = previous[0]?.registeredAt ?? new Date().toISOString();
  for (const item of previous) await adapter.delete({ model: "apikey", where: [{ field: "id", value: item.keyId }] });
  const created = await module.auth.api.createApiKey({
    body: {
      name: deviceKeyName,
      userId: principal.userId,
      prefix: apiKeyPrefix,
      metadata: { kind: "device", deviceId, name, model, osVersion, appVersion, machineId, registeredAt },
    },
  });
  return {
    device: describe({
      id: deviceId,
      keyId: created.id,
      userId: principal.userId,
      name,
      model,
      osVersion,
      appVersion,
      machineId,
      registeredAt,
    }),
    token: created.key,
  };
}

function describe(record: DeviceRecord) {
  const live = macRunnerConnections().find((item) => item.key === record.id);
  return {
    id: record.id,
    name: record.name,
    model: record.model,
    osVersion: record.osVersion,
    appVersion: live?.version ?? record.appVersion,
    userId: record.userId,
    registeredAt: record.registeredAt,
    connected: live !== undefined,
    connectedAt: live?.connectedAt ?? null,
    lastSeenAt: macDeviceLastSeen(record.id),
  };
}

export async function listDevices(principal: Principal) {
  const module = moduleOrFail();
  const owner = principal.role === ownerRole;
  const records = await deviceRows(await adapterOf(module), owner ? undefined : principal.userId);
  const unique = new Map<string, DeviceRecord>();
  for (const record of records) if (!unique.has(record.id)) unique.set(record.id, record);
  return [...unique.values()]
    .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt) || a.id.localeCompare(b.id))
    .map(describe);
}

export async function revokeDevice(principal: Principal, id: string) {
  const module = moduleOrFail();
  const adapter = await adapterOf(module);
  const owner = principal.role === ownerRole;
  const matches = (await deviceRows(adapter, owner ? undefined : principal.userId)).filter((item) => item.id === id);
  if (matches.length === 0) throw new DevicesError(404, "not_found", "Dispositivo não encontrado.");
  for (const item of matches) await adapter.delete({ model: "apikey", where: [{ field: "id", value: item.keyId }] });
  const disconnected = disconnectMacDevice(id);
  return { id, revoked: true, disconnected };
}
