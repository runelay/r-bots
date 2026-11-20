import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { join } from "node:path";
import { capture, childEnv, findBinary, maxLineBytes, parseJson, run, runBytes, runLines, searchPath } from "../proc";
import { fakeCli } from "./fakes";

const savedPath = process.env.PATH;

function collect(
  script: string,
  options: { signal?: AbortSignal; stdin?: string; env?: Record<string, string> } = {},
  onLine?: (line: string) => void,
) {
  const lines: string[] = [];
  const result = runLines(
    "sh",
    ["-c", script],
    {
      cwd: fakeCli.home,
      env: options.env ?? childEnv(),
      signal: options.signal ?? new AbortController().signal,
      stdin: options.stdin,
    },
    (line) => {
      lines.push(line);
      onLine?.(line);
    },
  );
  return { lines, result };
}

describe("proc", () => {
  beforeEach(() => fakeCli.reset());
  afterEach(() => {
    process.env.PATH = savedPath;
    jest.useRealTimers();
  });

  test("searchPath puts system dirs first, the home bin last and dedupes PATH", () => {
    process.env.PATH = `/custom/bin::/usr/bin:${join(fakeCli.home, ".local", "bin")}`;
    const dirs = searchPath().split(":");
    expect(dirs[0]).toBe("/opt/homebrew/bin");
    expect(dirs.at(-1)).toBe(join(fakeCli.home, ".local", "bin"));
    expect(dirs.filter((dir) => dir === join(fakeCli.home, ".local", "bin"))).toHaveLength(1);
    expect(dirs).toContain("/custom/bin");
    expect(dirs.filter((dir) => dir === "/usr/bin")).toHaveLength(1);
    expect(dirs).not.toContain("");
  });

  test("searchPath works without PATH", () => {
    delete process.env.PATH;
    expect(searchPath().split(":")).toHaveLength(5);
  });

  test("findBinary returns the first existing candidate or null", () => {
    const path = fakeCli.install("rb-fake-tool");
    expect(findBinary(["rb-missing-tool", "rb-fake-tool"])).toBe(path);
    expect(findBinary(["rb-missing-tool"])).toBeNull();
  });

  test("childEnv keeps only allowlisted variables, rewrites PATH and merges extras", () => {
    const set = {
      OPENAI_API_KEY: "secret",
      RUNELAY_MCP_TOKEN: "secret",
      DATABASE_URL: "postgres://x",
      BETTER_AUTH_SECRET: "s",
      RB_DROP: "x",
      LC_ALL: "C",
      AGENT_BROWSER_HOME: "/b",
      CODEX_HOME: "/c",
      TZ: "UTC",
    };
    Object.assign(process.env, set);
    const env = childEnv({ EXTRA: "1" });
    for (const key of Object.keys(set)) delete process.env[key];
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.RUNELAY_MCP_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.RB_DROP).toBeUndefined();
    expect(env.LC_ALL).toBe("C");
    expect(env.AGENT_BROWSER_HOME).toBe("/b");
    expect(env.CODEX_HOME).toBe("/c");
    expect(env.TZ).toBe("UTC");
    expect(env.EXTRA).toBe("1");
    expect(env.PATH).toBe(searchPath());
  });

  test("run without env passes the allowlisted environment only", async () => {
    process.env.RB_SECRET_LEAK = "leak";
    process.env.TZ = "UTC";
    const result = await run("sh", ["-c", "echo ${RB_SECRET_LEAK:-none}-$TZ"]);
    delete process.env.RB_SECRET_LEAK;
    delete process.env.TZ;
    expect(result.stdout.trim()).toBe("none-UTC");
  });

  test("runBytes truncates stdout at maxBytes", async () => {
    const result = await runBytes("sh", ["-c", "printf abcdef; printf ghij"], { maxBytes: 4 });
    expect(new TextDecoder().decode(result.stdout)).toBe("abcd");
    expect(result.code).toBe(0);
  });

  test("capture resolves stdout, stderr and exit code", async () => {
    const bin = fakeCli.install("rb-cap");
    fakeCli.reply("rb-cap", { stdout: "out", stderr: "err" });
    expect(await capture(bin, ["a"])).toEqual({ code: 0, stdout: "out", stderr: "err" });
    fakeCli.reply("rb-cap", { stdout: "", code: 3 });
    expect((await capture(bin, [])).code).toBe(3);
    expect(fakeCli.args("rb-cap")).toEqual([]);
  });

  test("capture maps spawn failures to code 1", async () => {
    const result = await capture(join(fakeCli.home, "missing"), []);
    expect(result.code).toBe(1);
  });

  test("capture keeps numeric exit codes from the process", async () => {
    expect(await capture("sh", ["-c", "printf x; printf y >&2; exit 7"])).toEqual({
      code: 7,
      stdout: "x",
      stderr: "y",
    });
  });

  test("runLines splits stdout into trimmed lines and flushes the tail", async () => {
    const { lines, result } = collect("printf ' one \\n\\ntwo\\nthree'; printf 'warn' >&2; exit 2");
    expect(await result).toEqual({ code: 2, stderr: "warn" });
    expect(lines).toEqual(["one", "two", "three"]);
  });

  test("runLines writes stdin to the child", async () => {
    const { lines, result } = collect("cat", { stdin: "hello\n" });
    expect((await result).code).toBe(0);
    expect(lines).toEqual(["hello"]);
  });

  test("runLines reports spawn errors through stderr", async () => {
    const lines: string[] = [];
    const result = await runLines(
      join(fakeCli.home, "missing"),
      [],
      { cwd: fakeCli.home, env: childEnv(), signal: new AbortController().signal },
      (line) => lines.push(line),
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("ENOENT");
    expect(lines).toEqual([]);
  });

  test("runLines kills the child when the signal aborts mid-run", async () => {
    const controller = new AbortController();
    const { lines, result } = collect("echo ready; exec sleep 30", { signal: controller.signal }, () =>
      controller.abort(),
    );
    const finished = await result;
    expect(lines).toEqual(["ready"]);
    expect(finished.code).not.toBe(0);
  });

  test("runLines kills immediately on an aborted signal and escalates to SIGKILL", async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const { result } = collect("exec sleep 30", { signal: controller.signal });
    jest.advanceTimersByTime(3000);
    jest.useRealTimers();
    expect((await result).code).not.toBe(0);
  });

  test("runLines drops a single line that grows past the cap", async () => {
    const big = maxLineBytes + 10;
    const { lines, result } = collect(`head -c ${big} /dev/zero | tr '\\0' 'a'; printf '\\nok\\n'`);
    expect((await result).code).toBe(0);
    expect(lines.at(-1)).toBe("ok");
    expect(lines.every((line) => line.length <= maxLineBytes)).toBe(true);
  });

  test("parseJson accepts objects only", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson("[1]")).toEqual([1] as unknown as Record<string, unknown>);
    expect(parseJson("3")).toBeNull();
    expect(parseJson("null")).toBeNull();
    expect(parseJson("nope")).toBeNull();
  });
});
