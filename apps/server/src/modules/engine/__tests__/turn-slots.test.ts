import { afterEach, describe, expect, test } from "bun:test";
import {
  acquireTurnSlot,
  maxTurns,
  onSuspendedChange,
  slotStats,
  suspendedSlots,
  type TurnSlot,
} from "../services/turn-slots.service";

const held: TurnSlot[] = [];

async function take(priority: Parameters<typeof acquireTurnSlot>[0] = "chat", signal = new AbortController().signal) {
  const slot = await acquireTurnSlot(priority, signal, () => undefined);
  held.push(slot);
  return slot;
}

afterEach(() => {
  for (const slot of held.splice(0)) slot.release();
  expect(slotStats()).toEqual({ running: 0, queued: 0, max: maxTurns });
});

describe("turn slots", () => {
  test("hand out slots up to the limit and queue the rest by priority", async () => {
    expect(maxTurns).toBe(3);
    for (let index = 0; index < maxTurns; index++) await take();
    const positions: Record<string, number[]> = { schedule: [], chat: [], delegate: [] };
    const order: string[] = [];
    const wait = (priority: "schedule" | "chat" | "delegate") =>
      acquireTurnSlot(priority, new AbortController().signal, (position) => positions[priority].push(position)).then(
        (slot) => {
          held.push(slot);
          order.push(priority);
          return slot;
        },
      );
    const schedule = wait("schedule");
    const chat = wait("chat");
    const delegate = wait("delegate");
    expect(slotStats()).toEqual({ running: 3, queued: 3, max: 3 });
    expect(positions.schedule).toEqual([1, 2, 3]);
    expect(positions.delegate).toEqual([1]);
    const voice = await take("voice");
    expect(slotStats().running).toBe(4);
    voice.release();
    voice.release();
    expect(slotStats().running).toBe(3);
    held[0].release();
    await delegate;
    expect(order).toEqual(["delegate"]);
    expect(positions.chat.at(-1)).toBe(1);
    held[1].release();
    held[2].release();
    await Promise.all([chat, schedule]);
    expect(order).toEqual(["delegate", "chat", "schedule"]);
  });

  test("suspend frees the slot for others and resume takes it back", async () => {
    const slot = await take();
    slot.suspend();
    expect(slotStats().running).toBe(0);
    slot.suspend();
    slot.resume();
    slot.resume();
    expect(slotStats().running).toBe(1);
    slot.suspend();
    slot.release();
    expect(slotStats().running).toBe(0);
    slot.resume();
    slot.suspend();
    expect(slotStats().running).toBe(0);
  });

  test("a queued turn that is cancelled leaves the queue", async () => {
    for (let index = 0; index < maxTurns; index++) await take();
    const controller = new AbortController();
    const positions: number[] = [];
    const first = acquireTurnSlot("chat", controller.signal, () => undefined);
    const second = acquireTurnSlot("chat", new AbortController().signal, (position) => positions.push(position));
    expect(positions).toEqual([2]);
    controller.abort();
    await expect(first).rejects.toThrow("cancelled");
    expect(positions).toEqual([2, 1]);
    expect(slotStats().queued).toBe(1);
    held[0].release();
    held.push(await second);
  });

  test("counts suspended slots and tells the listeners", async () => {
    const seen: number[] = [];
    const stop = onSuspendedChange((count) => seen.push(count));
    const first = await take();
    const second = await take();
    first.suspend();
    second.suspend();
    expect(suspendedSlots()).toBe(2);
    first.resume();
    second.release();
    expect(suspendedSlots()).toBe(0);
    stop();
    first.suspend();
    first.resume();
    expect(seen).toEqual([1, 2, 1, 0]);
  });
});
