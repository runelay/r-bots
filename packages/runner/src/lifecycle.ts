import type { BoxSpec, BoxState, BoxStatus } from "@runelay-bots/protocol";
import { busyErrorCode, capacityErrorCode } from "./constants";
import { specKey } from "./mounts";
import type { BoxCounts, LifecycleOptions, TimerHandle } from "./types";

export class BoxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Tracked {
  state: BoxState;
  lastUsedAt: number;
  busy: number;
  key: string | null;
  timer: TimerHandle | null;
}

export class BoxLifecycle {
  private readonly boxes = new Map<string, Tracked>();

  constructor(private readonly options: LifecycleOptions) {}

  async init() {
    const found = await this.options.provider.list();
    for (const { botId, state, lastUsedAt } of found) {
      const parsed = Date.parse(lastUsedAt);
      this.boxes.set(botId, {
        state,
        lastUsedAt: Number.isFinite(parsed) ? parsed : Date.now(),
        busy: 0,
        key: null,
        timer: null,
      });
      this.schedule(botId);
    }
  }

  counts(): BoxCounts {
    const states = [...this.boxes.values()].map(({ state }) => state);
    return {
      running: states.filter((state) => state === "running").length,
      paused: states.filter((state) => state === "paused").length,
    };
  }

  private entry(botId: string) {
    const existing = this.boxes.get(botId);
    if (existing) return existing;
    const created: Tracked = { state: "stopped", lastUsedAt: Date.now(), busy: 0, key: null, timer: null };
    this.boxes.set(botId, created);
    return created;
  }

  private oldestPaused(skip: Set<string>) {
    const candidates = [...this.boxes.entries()]
      .filter(([botId, { state, busy }]) => !skip.has(botId) && state === "paused" && busy === 0)
      .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt);
    return candidates[0]?.[0] ?? null;
  }

  private async admit(botId: string, memMb: number) {
    const { memory, reserveMb } = this.options;
    const skip = new Set([botId]);
    let { availableMb } = await memory();
    while (availableMb - memMb < reserveMb) {
      const victim = this.oldestPaused(skip);
      if (!victim)
        throw new BoxError(
          capacityErrorCode,
          `Sem memória para a caixa (${memMb} MB pedidos, ${availableMb} MB livres, ${reserveMb} MB de reserva).`,
        );
      skip.add(victim);
      await this.stopBox(victim);
      ({ availableMb } = await memory());
    }
  }

  async acquire(botId: string, spec: BoxSpec): Promise<BoxStatus> {
    const key = specKey(spec);
    const box = this.entry(botId);
    if (box.busy > 0 && box.key !== key)
      throw new BoxError(busyErrorCode, "A caixa deste bot está ocupada com outras montagens.");
    box.timer?.cancel();
    box.timer = null;
    box.busy += 1;
    try {
      const warm = box.key === key && box.state !== "stopped";
      if (!warm) await this.admit(botId, spec.memMb);
      const status = await this.options.provider.ensure(botId, spec, { idle: box.busy === 1 });
      Object.assign(box, { state: "running", key, lastUsedAt: Date.now() });
      this.publish();
      return status;
    } catch (error) {
      this.release(botId);
      throw error;
    }
  }

  isBusy(botId: string) {
    return (this.boxes.get(botId)?.busy ?? 0) > 0;
  }

  release(botId: string) {
    const box = this.boxes.get(botId);
    if (!box) return;
    box.busy = Math.max(0, box.busy - 1);
    box.lastUsedAt = Date.now();
    this.schedule(botId);
  }

  private schedule(botId: string) {
    const box = this.boxes.get(botId);
    if (!box || box.busy > 0) return;
    box.timer?.cancel();
    box.timer = null;
    const { clock, pauseAfterMs, stopAfterMs } = this.options;
    if (box.state === "running") box.timer = clock.after(pauseAfterMs, () => void this.pauseBox(botId));
    if (box.state === "paused") box.timer = clock.after(stopAfterMs, () => void this.stopBox(botId));
  }

  private async pauseBox(botId: string) {
    const box = this.boxes.get(botId);
    if (!box || box.busy > 0 || box.state !== "running") return;
    box.timer = null;
    try {
      await this.options.provider.pause(botId);
      box.state = "paused";
      this.schedule(botId);
      this.publish();
    } catch {}
  }

  private async stopBox(botId: string) {
    const box = this.boxes.get(botId);
    if (!box || box.busy > 0) return;
    box.timer?.cancel();
    box.timer = null;
    try {
      await this.options.provider.stop(botId);
      box.state = "stopped";
      this.publish();
    } catch {}
  }

  private publish() {
    void this.options.provider
      .list()
      .then((boxes) =>
        this.options.onChange(
          boxes.map((status) => {
            const tracked = this.boxes.get(status.botId);
            return tracked ? { ...status, lastUsedAt: new Date(tracked.lastUsedAt).toISOString() } : status;
          }),
        ),
      )
      .catch(() => undefined);
  }

  dispose() {
    for (const box of this.boxes.values()) {
      box.timer?.cancel();
      box.timer = null;
    }
  }
}
