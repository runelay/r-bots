import { afterAll, beforeEach, mock, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderEvent, TurnRequest } from "@runelay-bots/protocol";

export interface QueryParams {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}

type QueryScript = (params: QueryParams) => AsyncIterable<SDKMessage>;

const root = mkdtempSync(join(os.tmpdir(), "rb-providers-"));
const home = join(root, "home");
const binDir = join(home, ".local", "bin");
const stateDir = join(root, "cli");
mkdirSync(binDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });

beforeEach(() => {
  spyOn(os, "homedir").mockReturnValue(home);
});
process.env.GATEWAY_PORT = `test${process.pid}`;
process.env.RB_FAKE_DIR = stateDir;
process.env.RBOTS_CLIS_DIR = join(root, "clis");
process.env.PATH = `${binDir}:/usr/bin:/bin`;
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CURSOR_API_KEY", "XAI_API_KEY"])
  delete process.env[key];
afterAll(() => rmSync(root, { recursive: true, force: true }));

const fakeScript = `#!/bin/sh
dir="__STATE__"
name=$(basename "$0")
if [ $# -gt 0 ]; then printf '%s\\n' "$@"; fi > "$dir/$name.args"
env > "$dir/$name.env"
if [ "$1" = "exec" ]; then cat > "$dir/$name.stdin"; fi
key="$name.$1_$2"
[ -f "$dir/$key.out" ] || key="$name"
[ -f "$dir/$key.err" ] && cat "$dir/$key.err" >&2
[ -f "$dir/$key.out" ] && cat "$dir/$key.out"
exit $(cat "$dir/$key.code" 2>/dev/null || echo 0)
`;

export interface CliReply {
  stdout?: string;
  stderr?: string;
  code?: number;
}

export const fakeCli = {
  home,
  binDir,
  install(name: string) {
    const path = join(binDir, name);
    writeFileSync(path, fakeScript.replace("__STATE__", stateDir));
    chmodSync(path, 0o755);
    return path;
  },
  remove(name: string) {
    rmSync(join(binDir, name), { force: true });
  },
  reply(name: string, reply: CliReply, args?: [string, string?]) {
    const key = args ? `${name}.${args[0]}_${args[1] ?? ""}` : name;
    writeFileSync(join(stateDir, `${key}.out`), reply.stdout ?? "");
    writeFileSync(join(stateDir, `${key}.err`), reply.stderr ?? "");
    writeFileSync(join(stateDir, `${key}.code`), String(reply.code ?? 0));
  },
  lines(name: string, events: unknown[], code = 0, stderr = "") {
    fakeCli.reply(name, { stdout: events.map((event) => JSON.stringify(event)).join("\n"), code, stderr });
  },
  args(name: string) {
    const file = join(stateDir, `${name}.args`);
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(0, -1) : [];
  },
  env(name: string) {
    return readFileSync(join(stateDir, `${name}.env`), "utf8").split("\n");
  },
  stdin(name: string) {
    return readFileSync(join(stateDir, `${name}.stdin`), "utf8");
  },
  reset() {
    rmSync(binDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
  },
};

export const fakeSdk = {
  calls: [] as QueryParams[],
  script: async function* () {} as QueryScript,
  next(script: QueryScript) {
    fakeSdk.script = script;
  },
  reset() {
    fakeSdk.calls = [];
    fakeSdk.script = async function* () {};
  },
};

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: QueryParams) => {
    fakeSdk.calls.push(params);
    return fakeSdk.script(params);
  },
}));

export function turnRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: "turn-1",
    provider: "claude",
    model: "model-x",
    effort: null,
    systemPrompt: "be brief",
    prompt: "hello",
    resume: null,
    mcp: null,
    workKey: "bot/key",
    ...overrides,
  };
}

export function recorder() {
  const events: ProviderEvent[] = [];
  return { events, emit: (event: ProviderEvent) => void events.push(event) };
}
