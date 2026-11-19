import { env } from "../../../config/env";

export const maxTurns = Math.max(1, env.BOTS_MAX_TURNS);

export type SlotPriority = "voice" | "delegate" | "chat" | "schedule";

const rank: Record<SlotPriority, number> = { voice: 0, delegate: 1, chat: 2, schedule: 3 };

interface Waiter {
  priority: number;
  seq: number;
  grant: () => void;
  onPosition: (position: number) => void;
}

export interface TurnSlot {
  release: () => void;
  suspend: () => void;
  resume: () => void;
}

let running = 0;
let seq = 0;
const waiters: Waiter[] = [];

function notifyPositions() {
  waiters.forEach((waiter, index) => {
    waiter.onPosition(index + 1);
  });
}

function pump() {
  let granted = false;
  while (running < maxTurns && waiters.length > 0) {
    const next = waiters.shift()!;
    running++;
    granted = true;
    next.grant();
  }
  if (granted) notifyPositions();
}

function makeSlot(): TurnSlot {
  let holding = true;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      if (holding) {
        holding = false;
        running--;
        pump();
      }
    },
    suspend: () => {
      if (released || !holding) return;
      holding = false;
      running--;
      pump();
    },
    resume: () => {
      if (released || holding) return;
      holding = true;
      running++;
    },
  };
}

export function acquireTurnSlot(
  priority: SlotPriority,
  signal: AbortSignal,
  onQueued: (position: number) => void,
): Promise<TurnSlot> {
  if (priority === "voice" || running < maxTurns) {
    running++;
    return Promise.resolve(makeSlot());
  }
  return new Promise<TurnSlot>((resolve, reject) => {
    const waiter: Waiter = {
      priority: rank[priority],
      seq: seq++,
      grant: () => {
        signal.removeEventListener("abort", onAbort);
        resolve(makeSlot());
      },
      onPosition: onQueued,
    };
    const onAbort = () => {
      const index = waiters.indexOf(waiter);
      if (index !== -1) waiters.splice(index, 1);
      notifyPositions();
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const index = waiters.findIndex((other) => other.priority > waiter.priority);
    if (index === -1) waiters.push(waiter);
    else waiters.splice(index, 0, waiter);
    notifyPositions();
  });
}

export function slotStats() {
  return { running, queued: waiters.length, max: maxTurns };
}
