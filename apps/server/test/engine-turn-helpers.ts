import { spyOn } from "bun:test";
import { emptyUsage, type ProviderEvent, type Usage } from "@runelay-bots/protocol";
import * as handoff from "../src/modules/conversations/services/handoff.service";
import type { StoredSession } from "../src/modules/conversations/services/sessions.service";
import { type Delivery, deliver, isBusy } from "../src/modules/engine/services/engine.service";
import { findToolContext } from "../src/modules/engine/services/mcp-gateway.service";
import * as memory from "../src/modules/memory/services/memory.service";
import { factsOfType, waitFor } from "./engine-helpers";
import { type FakeTurn, fakeProviders, type TurnScript } from "./fake-providers";

type Restorable = { mockRestore(): void };

const restores: Restorable[] = [];

export function track<T extends Restorable>(spy: T) {
  restores.push(spy);
  return spy;
}

export function restoreTracked() {
  for (const spy of restores.splice(0).reverse()) spy.mockRestore();
}

export function quietEngine() {
  return {
    summary: track(spyOn(handoff, "refreshSummary").mockResolvedValue(undefined as never)),
    capture: track(spyOn(memory, "capture").mockResolvedValue(undefined as never)),
    recall: track(spyOn(memory, "recall").mockResolvedValue([])),
    team: track(spyOn(memory, "teamLogBlock").mockResolvedValue("")),
  };
}

export function contextOf(turn: FakeTurn) {
  const context = findToolContext(turn.request.mcp?.token ?? "");
  if (!context) throw new Error("tool context not registered");
  return context;
}

export function botOfTurn(turn: FakeTurn) {
  return new URL(turn.request.mcp?.url ?? "http://x/mcp/none/none").pathname.split("/")[2];
}

export function byBot(scripts: Record<string, TurnScript>): TurnScript {
  return (turn) => {
    const script = scripts[botOfTurn(turn)];
    if (!script) throw new Error(`no script for ${botOfTurn(turn)}`);
    return script(turn);
  };
}

export function sequence(...scripts: TurnScript[]): TurnScript {
  let index = 0;
  return (turn) => scripts[Math.min(index++, scripts.length - 1)](turn);
}

export function aborted(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

export function hold(events: ProviderEvent[] = []) {
  let release = () => undefined as undefined;
  const started = Promise.withResolvers<FakeTurn>();
  const script: TurnScript = (turn) =>
    new Promise<void>((resolve) => {
      release = () => {
        for (const event of events) turn.emit(event);
        turn.emit({ type: "done", ok: true });
        resolve();
      };
      turn.signal.addEventListener("abort", () => release(), { once: true });
      started.resolve(turn);
    });
  return { script, started: started.promise, release: () => release() };
}

export function usageOf(partial: Partial<Usage> = {}): Usage {
  return { ...emptyUsage(), ...partial };
}

export async function idle(session: StoredSession) {
  await waitFor(() => !isBusy(session.meta.sessionId), 8000);
}

let deliveries = 0;

export function send(session: StoredSession, delivery: Partial<Delivery> = {}) {
  const full: Delivery = { deliveryId: `dlv_${++deliveries}`, text: "oi", source: "chat", ...delivery };
  deliver(session, full);
  return full;
}

export async function run(session: StoredSession, delivery: Partial<Delivery> = {}) {
  const sent = send(session, delivery);
  await idle(session);
  return sent;
}

export async function settledOf(session: StoredSession) {
  return (await factsOfType(session, "turn.settled")).at(-1)?.data as Record<string, unknown> & {
    outcome: string;
    error?: { code: string; message: string; suggest?: Record<string, unknown>; until?: string | null };
    reason?: string;
  };
}

export async function repliesOf(session: StoredSession, phase: "reply" | "narration" = "reply") {
  return (await factsOfType(session, "content.completed"))
    .filter((fact) => fact.data.phase === phase)
    .map((fact) => String(fact.data.value));
}

export function lastRequest() {
  const turn = fakeProviders.turns.at(-1);
  if (!turn) throw new Error("no provider turn");
  return turn.request;
}
