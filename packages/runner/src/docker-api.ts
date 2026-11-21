import { readLines } from "./json";
import type { DockerResponse } from "./types";

export class DockerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Hijacked {
  stream: ReadableStream<Uint8Array>;
  write(data: string): void;
  end(): void;
}

function messageOf(body: unknown, fallback: string) {
  if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string")
    return body.message;
  return fallback;
}

export class DockerApi {
  constructor(readonly socketPath: string) {}

  private send(method: string, path: string, body: unknown, headers: Record<string, string>) {
    return fetch(`http://docker${path}`, {
      method,
      unix: this.socketPath,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<DockerResponse> {
    const response = await this.send(method, path, body, headers);
    const text = await response.text();
    return { status: response.status, body: text ? parseBody(text) : null };
  }

  async stream(method: string, path: string, headers: Record<string, string>, onLine: (line: unknown) => void) {
    const response = await this.send(method, path, undefined, headers);
    if (response.status !== 200 || !response.body) {
      const text = await response.text();
      throw new DockerError(
        messageOf(text ? parseBody(text) : null, `${method} ${path}: ${response.status}`),
        response.status,
      );
    }
    for await (const line of readLines(response.body)) onLine(parseBody(line));
  }

  async expect(method: string, path: string, ok: number[], body?: unknown) {
    const response = await this.request(method, path, body);
    if (ok.includes(response.status)) return response;
    throw new DockerError(messageOf(response.body, `${method} ${path}: ${response.status}`), response.status);
  }

  hijack(path: string, body: unknown) {
    const payload = JSON.stringify(body);
    const head = [
      `POST ${path} HTTP/1.1`,
      "Host: docker",
      "Content-Type: application/json",
      "Connection: Upgrade",
      "Upgrade: tcp",
      `Content-Length: ${Buffer.byteLength(payload)}`,
      "",
      "",
    ].join("\r\n");
    return new Promise<Hijacked>((resolve, reject) => {
      let header = Buffer.alloc(0);
      let upgraded = false;
      let outgoing = Buffer.alloc(0);
      let ending = false;
      let socketRef: Bun.Socket<undefined> | null = null;
      let output: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          output = controller;
        },
      });
      const flush = () => {
        if (!socketRef) return;
        if (outgoing.length > 0) {
          const written = socketRef.write(outgoing);
          outgoing = outgoing.subarray(Math.max(0, written));
        }
        if (outgoing.length === 0 && ending) socketRef.end();
      };
      Bun.connect({
        unix: this.socketPath,
        socket: {
          open(socket) {
            socketRef = socket;
            outgoing = Buffer.from(head + payload);
            flush();
          },
          drain() {
            flush();
          },
          data(socket, data) {
            if (upgraded) {
              output?.enqueue(new Uint8Array(data));
              return;
            }
            header = Buffer.concat([header, data]);
            const end = header.indexOf("\r\n\r\n");
            if (end < 0) return;
            upgraded = true;
            const status = Number(header.subarray(0, end).toString().split(" ")[1]);
            if (status !== 101 && status !== 200) {
              reject(new DockerError(`POST ${path}: ${status}`, status));
              socket.end();
              return;
            }
            resolve({
              stream,
              write(data) {
                outgoing = Buffer.concat([outgoing, Buffer.from(data)]);
                flush();
              },
              end() {
                ending = true;
                flush();
              },
            });
            const rest = header.subarray(end + 4);
            if (rest.length > 0) output?.enqueue(new Uint8Array(rest));
          },
          close() {
            if (!upgraded) reject(new DockerError(`POST ${path}: conexão fechada`, 0));
            output?.close();
          },
        },
      }).catch(reject);
    });
  }
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
