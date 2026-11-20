import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export { FakeChild, fakeProcesses, type ProcessCall, type ProcessReply } from "./fake-process";
export {
  accountFields,
  type FakeTurn,
  fakeModels,
  fakeProviders,
  readyProbe,
  replyWith,
  type TurnScript,
} from "./fake-providers";
export { type ApiCall, type ApiReply, fakeRunelay } from "./fake-runelay";

export function testDataDir() {
  const dir = process.env.BOTS_DATA_DIR;
  if (!dir) throw new Error("test/setup.ts did not run: BOTS_DATA_DIR is not set");
  return dir;
}

export async function resetData() {
  const dir = testDataDir();
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir)) await rm(join(dir, entry), { recursive: true, force: true });
}

export async function writeData(relativePath: string, value: unknown) {
  const path = join(testDataDir(), relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return path;
}

export async function readData<T = unknown>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(join(testDataDir(), relativePath), "utf8")) as T;
}

export interface TestServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface TestRequestInit extends Omit<RequestInit, "body"> {
  body?: unknown;
}

export interface TestResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

let current: TestServer | null = null;

export async function startTestServer(): Promise<TestServer> {
  const { startServer } = await import("../src/app");
  const server = startServer("127.0.0.1", 0);
  const previousPort = process.env.GATEWAY_PORT;
  const port = Number(server.port);
  process.env.GATEWAY_PORT = String(port);
  const handle: TestServer = {
    url: `http://127.0.0.1:${port}`,
    port,
    async close() {
      await server.stop(true);
      process.env.GATEWAY_PORT = previousPort;
      if (current === handle) current = null;
    },
  };
  current = handle;
  return handle;
}

function encodeBody(init: TestRequestInit) {
  const headers = new Headers(init.headers);
  const body = init.body;
  if (body === undefined || body === null) return { headers, body: undefined };
  if (typeof body === "string" || body instanceof Uint8Array || body instanceof Blob || body instanceof FormData)
    return { headers, body: body as Bun.BodyInit };
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return { headers, body: JSON.stringify(body) };
}

export async function request<T = unknown>(path: string, init: TestRequestInit = {}): Promise<TestResponse<T>> {
  if (!current) throw new Error("request() needs startTestServer() first");
  const { headers, body } = encodeBody(init);
  const response = await fetch(`${current.url}${path}`, { ...init, headers, body });
  const text = await response.text();
  const json = (response.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : text;
  return { status: response.status, headers: response.headers, body: json as T, text };
}
