import type { ServerWebSocket } from "bun";

export type SocketData = { kind: string; botId?: string; [key: string]: unknown };
export type Socket = ServerWebSocket<SocketData>;

export interface SocketHandler {
  open(ws: Socket): void;
  message(ws: Socket, message: string | Buffer): void;
  close(ws: Socket, code: number, reason: string): void;
  pong?(ws: Socket): void;
}

export const socketOpen = 1;
