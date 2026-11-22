import { randomUUID } from "node:crypto";
import type { BoxSpec, BoxStatus } from "@runelay-bots/protocol";
import {
  boxAgentArgv,
  boxAgentCwd,
  cancelKillAfterMs,
  capacityErrorCode,
  mountErrorCode,
  startErrorCode,
} from "./constants";
import { isBoxSpec, isProviderEvent, isTurnRequest } from "./guards";
import { isRecord, line, parseRecord, readLines, stringMap, stringOf } from "./json";
import { rejectedMount, usableMounts } from "./mounts";
import type { BoxExecHandle, BoxProvider, Clock, JsonRecord, Send, TimerHandle } from "./types";

export interface TurnDeps {
  lifecycle: {
    acquire(botId: string, spec: BoxSpec): Promise<BoxStatus>;
    release(botId: string): void;
  };
  provider: Pick<BoxProvider, "exec">;
  send: Send;
  clock: Clock;
  workspaceRoots: string[];
  accountRoots: string[];
  forbiddenMounts: string[];
  log: (line: string) => void;
}

interface ActiveTurn {
  turnId: string;
  botId: string;
  handle: BoxExecHandle;
  cancelled: boolean;
  ended: boolean;
  killTimer: TimerHandle | null;
}

interface Route {
  turnId: string;
  agentId: string;
}

function codeOf(error: unknown) {
  return isRecord(error) && typeof error.code === "string" ? error.code : startErrorCode;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class TurnManager {
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly routes = new Map<string, Route>();
  private readonly waiting = new Set<string>();
  private readonly dropped = new Set<string>();

  constructor(private readonly deps: TurnDeps) {}

  get active() {
    return this.turns.size;
  }

  handle(frame: JsonRecord) {
    const { type, op } = frame;
    if (type === "request" && op === "turn.start") {
      void this.start(frame);
      return true;
    }
    if (type === "turn.cancel") {
      this.cancel(stringOf(frame.id));
      return true;
    }
    if (type === "hook.response" || type === "mcp.response") {
      this.reply(frame);
      return true;
    }
    return false;
  }

  private fail(id: string, code: string, message: string) {
    this.deps.send({ type: "response", id, ok: false, code, error: code === capacityErrorCode ? code : message });
  }

  async start(frame: JsonRecord) {
    const { workspaceRoots, accountRoots, forbiddenMounts, lifecycle, provider } = this.deps;
    const id = stringOf(frame.id);
    const { turnId, botId, request, box, hooks } = frame;
    if (typeof turnId !== "string" || typeof botId !== "string" || !isTurnRequest(request) || !isBoxSpec(box)) {
      this.fail(id, "turn.invalid", "Pedido de turno inválido.");
      return;
    }
    if (this.turns.has(turnId)) {
      this.fail(id, "turn.duplicate", "Esse turno já está rodando.");
      return;
    }
    const roots = [...workspaceRoots, ...accountRoots];
    const spec = { ...box, mounts: usableMounts(box.mounts, roots, forbiddenMounts) };
    const rejected = rejectedMount(spec.mounts, roots, forbiddenMounts);
    if (rejected) {
      this.fail(id, mountErrorCode, `O caminho ${rejected} fica fora das pastas liberadas neste runner.`);
      return;
    }
    this.waiting.add(turnId);
    try {
      await lifecycle.acquire(botId, spec);
    } catch (error) {
      this.fail(id, codeOf(error), messageOf(error));
      return;
    } finally {
      this.waiting.delete(turnId);
    }
    if (this.dropped.delete(turnId)) {
      lifecycle.release(botId);
      this.fail(id, "turn.cancelled", "cancelled");
      return;
    }
    const controller = new AbortController();
    const handle = provider.exec(botId, boxAgentArgv, { cwd: boxAgentCwd, env: {}, signal: controller.signal });
    const turn: ActiveTurn = { turnId, botId, handle, cancelled: false, ended: false, killTimer: null };
    this.turns.set(turnId, turn);
    handle.write(line({ type: "start", request, hooks: hooks === true }));
    const logs = this.drainLogs(turn);
    for await (const raw of readLines(handle.stdout)) this.onAgent(turn, raw);
    await Promise.all([handle.exited, logs]);
    this.finish(turn);
  }

  private async drainLogs({ botId, handle }: ActiveTurn) {
    for await (const raw of readLines(handle.stderr)) this.deps.log(`caixa ${botId}: ${raw}`);
  }

  private finish(turn: ActiveTurn) {
    const { turnId, botId, ended, cancelled, killTimer } = turn;
    const { send, lifecycle } = this.deps;
    killTimer?.cancel();
    if (!ended) {
      const message = cancelled ? "cancelled" : "A caixa encerrou o turno sem resposta.";
      send({ type: "turn.event", id: turnId, event: { type: "done", ok: false, message } });
      send({ type: "turn.end", id: turnId, ok: false, message });
    }
    for (const [frameId, route] of this.routes) if (route.turnId === turnId) this.routes.delete(frameId);
    this.turns.delete(turnId);
    lifecycle.release(botId);
  }

  private route(turnId: string, agentId: string) {
    const frameId = randomUUID();
    this.routes.set(frameId, { turnId, agentId });
    return frameId;
  }

  private onAgent(turn: ActiveTurn, raw: string) {
    const message = parseRecord(raw);
    if (!message) return;
    const { send } = this.deps;
    const { turnId } = turn;
    const { type } = message;
    if (type === "event" && isProviderEvent(message.event)) {
      send({ type: "turn.event", id: turnId, event: message.event });
      return;
    }
    if (type === "hook.request") {
      const { id, phase, tool, input, toolUseId, response, failed } = message;
      send({
        type: "hook.request",
        id: this.route(turnId, stringOf(id)),
        turnId,
        phase: phase === "after" ? "after" : "before",
        tool: stringOf(tool),
        input: isRecord(input) ? input : {},
        toolUseId: stringOf(toolUseId),
        ...(phase === "after" ? { response, failed: failed === true } : {}),
      });
      return;
    }
    if (type === "mcp.request") {
      const { id, method, path, headers, body } = message;
      send({
        type: "mcp.request",
        id: this.route(turnId, stringOf(id)),
        method: stringOf(method, "POST"),
        path: stringOf(path),
        headers: stringMap(headers),
        body: stringOf(body),
      });
      return;
    }
    if (type === "end") {
      turn.ended = true;
      send({ type: "turn.end", id: turnId, ok: message.ok === true });
    }
  }

  private reply(frame: JsonRecord) {
    const route = this.routes.get(stringOf(frame.id));
    if (!route) return;
    this.routes.delete(stringOf(frame.id));
    const turn = this.turns.get(route.turnId);
    if (!turn) return;
    turn.handle.write(line({ ...frame, id: route.agentId }));
  }

  cancel(turnId: string) {
    if (this.waiting.has(turnId)) this.dropped.add(turnId);
    const turn = this.turns.get(turnId);
    if (!turn || turn.cancelled) return;
    turn.cancelled = true;
    turn.handle.write(line({ type: "cancel" }));
    turn.killTimer = this.deps.clock.after(cancelKillAfterMs, () => turn.handle.kill());
  }

  cancelAll() {
    for (const turnId of this.waiting) this.dropped.add(turnId);
    for (const turnId of this.turns.keys()) this.cancel(turnId);
  }
}
