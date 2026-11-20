import { randomUUID } from "node:crypto";
import { ValidationError } from "../../../shared/errors";
import {
  disconnectMacDevice,
  macDeviceLastSeen,
  macRunnerConnections,
} from "../../accounts/services/mac-runner.service";
import type { Principal } from "../../auth";
import { authActive, currentAuthModule } from "../../auth/gate";
import { apiKeyLifetimeSeconds, apiKeyPrefix, ownerRole } from "../../auth/services/auth.service";
import type { DeviceRow } from "../repositories/devices.repository";

export const deviceKeyName = "device";

export class DevicesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function moduleOrFail() {
  const module = currentAuthModule();
  if (!module || !authActive())
    throw new DevicesError(401, "unauthorized", "Entre na sua conta para gerenciar dispositivos.");
  return module;
}

export async function listRegisteredDevices() {
  const module = currentAuthModule();
  if (!module || !authActive()) return [];
  try {
    const roles = await module.devices.roles();
    return (await module.devices.list()).map((row) => ({
      id: row.id,
      keyId: row.apiKeyId,
      userId: row.userId,
      name: row.name,
      registeredAt: row.registeredAt.toISOString(),
      owner: roles.get(row.id) === ownerRole,
    }));
  } catch {
    return [];
  }
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
  const previous = machineId ? await module.devices.byMachine(principal.userId, machineId) : [];
  const deviceId = previous[0]?.id ?? randomUUID();
  const registeredAt = previous[0]?.registeredAt ?? new Date();
  await module.devices.remove(previous.map((item) => item.id));
  const created = await module.auth.api.createApiKey({
    body: {
      name: deviceKeyName,
      userId: principal.userId,
      prefix: apiKeyPrefix,
      expiresIn: apiKeyLifetimeSeconds,
      metadata: { kind: "device" },
    },
  });
  const row: DeviceRow = {
    id: deviceId,
    apiKeyId: created.id,
    userId: principal.userId,
    name,
    model,
    osVersion,
    appVersion,
    machineId,
    registeredAt,
    createdAt: new Date(),
  };
  await module.devices.insert(row);
  return { device: describe(row), token: created.key };
}

function describe(row: DeviceRow) {
  const live = macRunnerConnections().find((item) => item.key === row.id);
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    osVersion: row.osVersion,
    appVersion: live?.version ?? row.appVersion,
    userId: row.userId,
    registeredAt: row.registeredAt.toISOString(),
    connected: live !== undefined,
    connectedAt: live?.connectedAt ?? null,
    lastSeenAt: macDeviceLastSeen(row.id),
  };
}

export async function listDevices(principal: Principal) {
  const module = moduleOrFail();
  const rows = await module.devices.list(principal.role === ownerRole ? undefined : principal.userId);
  return rows.map(describe);
}

export async function revokeDevice(principal: Principal, id: string) {
  const module = moduleOrFail();
  const owner = principal.role === ownerRole;
  const matches = (await module.devices.list(owner ? undefined : principal.userId)).filter((item) => item.id === id);
  if (matches.length === 0) throw new DevicesError(404, "not_found", "Dispositivo não encontrado.");
  await module.devices.remove([id]);
  const disconnected = disconnectMacDevice(id);
  return { id, revoked: true, disconnected };
}
