import type { BoxSpec, NativeToolGate, ProviderEvent, TurnRequest } from "@runelay-bots/protocol";
import { providers } from "@runelay-bots/protocol";
import { isRecord } from "./json";
import type { BoxMount } from "./types";

const eventTypes = ["session", "text.delta", "text", "usage", "warning", "image", "tool", "done"];

export function isTurnRequest(value: unknown): value is TurnRequest {
  if (!isRecord(value)) return false;
  const { turnId, provider, model, prompt, systemPrompt, workKey } = value;
  return (
    typeof turnId === "string" &&
    providers.some((name) => name === provider) &&
    typeof model === "string" &&
    typeof prompt === "string" &&
    typeof systemPrompt === "string" &&
    typeof workKey === "string"
  );
}

function isMount(value: unknown): value is BoxMount {
  if (!isRecord(value)) return false;
  const { host, box, readOnly, optional } = value;
  return (
    typeof host === "string" &&
    typeof box === "string" &&
    typeof readOnly === "boolean" &&
    (optional === undefined || typeof optional === "boolean")
  );
}

export function isBoxSpec(value: unknown): value is BoxSpec {
  if (!isRecord(value)) return false;
  const { memMb, cpus, mounts } = value;
  return (
    typeof memMb === "number" &&
    memMb > 0 &&
    typeof cpus === "number" &&
    cpus > 0 &&
    Array.isArray(mounts) &&
    mounts.every(isMount)
  );
}

export function isProviderEvent(value: unknown): value is ProviderEvent {
  return isRecord(value) && typeof value.type === "string" && eventTypes.includes(value.type);
}

export function isToolGate(value: unknown): value is NativeToolGate {
  return isRecord(value) && typeof value.allow === "boolean";
}
