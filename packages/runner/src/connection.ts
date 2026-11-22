import { backoffDelay, upgradeStatus } from "./backoff";
import {
  capacityIntervalMs,
  fatalUpgradeStatuses,
  revokedCloseCode,
  runnerRole,
  runnerRoleHeader,
  tokenWaitMs,
} from "./constants";
import { parseRecord } from "./json";
import type { ConnectionOptions, JsonRecord, TimerHandle } from "./types";

function errorStatus(event: Event) {
  return "message" in event && typeof event.message === "string" ? upgradeStatus(event.message) : null;
}

export class RunnerConnection {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private retry: TimerHandle | null = null;
  private beat: TimerHandle | null = null;
  private waiting = false;

  constructor(private readonly options: ConnectionOptions) {}

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  start() {
    this.open();
  }

  send(frame: JsonRecord) {
    const { socket } = this;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  stop(reason = "stopped") {
    if (this.stopped) return;
    this.stopped = true;
    this.retry?.cancel();
    this.beat?.cancel();
    const { socket } = this;
    this.socket = null;
    socket?.close(1000, reason);
    this.options.onStop(reason);
  }

  private open() {
    if (this.stopped) return;
    const { url, clock, log } = this.options;
    const token = this.options.token();
    if (!token) {
      if (!this.waiting) log(`token do runner ainda não existe; tentando de novo a cada ${tokenWaitMs / 1000} s`);
      this.waiting = true;
      this.retry = clock.after(tokenWaitMs, () => this.open());
      return;
    }
    this.waiting = false;
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}`, [runnerRoleHeader]: runnerRole },
    });
    let refused: number | null = null;
    this.socket = socket;
    socket.addEventListener("open", () => void this.onOpen(socket));
    socket.addEventListener("message", ({ data }) => this.onMessage(data));
    socket.addEventListener("error", (event) => {
      const status = errorStatus(event);
      if (status !== null && fatalUpgradeStatuses.includes(status)) refused = status;
    });
    socket.addEventListener("close", ({ code }) => this.onClose(socket, code, refused));
  }

  private async onOpen(socket: WebSocket) {
    this.attempt = 0;
    this.options.log("runner conectado");
    const hello = await this.options.hello();
    if (socket !== this.socket) return;
    if (this.send({ ...hello })) this.options.onBeat?.();
    this.beat?.cancel();
    this.beat = this.options.clock.every(capacityIntervalMs, () => void this.pushCapacity());
  }

  private async pushCapacity() {
    const capacity = await this.options.capacity();
    if (this.send({ type: "capacity", capacity })) this.options.onBeat?.();
  }

  private onMessage(data: unknown) {
    if (typeof data !== "string") return;
    const frame = parseRecord(data);
    if (!frame) return;
    if (frame.type === "ping") {
      this.send({ type: "pong" });
      return;
    }
    this.options.onFrame(frame);
  }

  private onClose(socket: WebSocket, code: number, refused: number | null) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.beat?.cancel();
    this.beat = null;
    this.options.onClose();
    if (code === revokedCloseCode) {
      this.stop("revoked");
      return;
    }
    if (refused !== null) {
      this.stop(`refused ${refused}`);
      return;
    }
    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    this.options.log(`runner desconectado (${code}); tentando de novo em ${delay} ms`);
    this.retry = this.options.clock.after(delay, () => this.open());
  }
}
