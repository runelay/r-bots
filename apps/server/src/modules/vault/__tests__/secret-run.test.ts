import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootDir } from "../../../config/env";

const helper = join(rootDir, "bin", "rb-secret-run.mjs");
const bin = mkdtempSync(join(tmpdir(), "rb-secret-run-"));
const grants = new Map<string, Record<string, unknown>>();
let server: ReturnType<typeof Bun.serve>;

function fake(name: string) {
  const file = join(bin, name);
  writeFileSync(
    file,
    `#!/bin/sh\necho "args:$*"\necho "token:$GH_TOKEN"\necho "proxy:$HTTPS_PROXY"\necho "leak:$LEAK_ME"\necho "gh:\${GH_CONFIG_DIR:+set}"\nif [ "$1" = "--disable" ]; then while IFS= read -r line; do echo "$line"; done; fi\necho "err:$GH_TOKEN" >&2\nexit 3\n`,
  );
  chmodSync(file, 0o755);
}

async function run(ticket: string, port = server.port) {
  const child = Bun.spawn(["bash", "-c", `BUN_BE_BUN=1 '${process.execPath}' '${helper}' ${port} 3<<<'${ticket}'`], {
    env: { PATH: process.env.PATH, HOME: bin, HTTPS_PROXY: "http://evil.example.com", LEAK_ME: "x" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

beforeAll(() => {
  fake("curl");
  fake("gh");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const ticket = new URL(req.url).pathname.split("/").pop() ?? "";
      const grant = grants.get(ticket);
      grants.delete(ticket);
      return grant ? Response.json(grant) : Response.json({ ok: false }, { status: 410 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(bin, { recursive: true, force: true });
});

describe("rb-secret-run", () => {
  test("runs the granted program with a minimal env, the stdin config and masked output", async () => {
    const ticket = "t".repeat(43);
    grants.set(ticket, {
      argv: ["curl", "--disable", "-s", "https://api.example.com/", "--config", "-"],
      env: {},
      stdin: 'header = "Authorization: Bearer secret-value-1"\n',
      tempHome: false,
      redact: ["secret-value-1"],
      path: bin,
    });
    const result = await run(ticket);
    expect(result).toMatchObject({ code: 3 });
    expect(result.stdout).toContain("args:--disable -s https://api.example.com/ --config -");
    expect(result.stdout).toContain("proxy:\n");
    expect(result.stdout).toContain("leak:\n");
    expect(result.stdout).toContain('header = "Authorization: Bearer ••••"');
    expect(result.stdout).not.toContain("secret-value-1");
  });

  test("gh gets its token in the env and a throwaway config home", async () => {
    const ticket = "g".repeat(43);
    grants.set(ticket, {
      argv: ["gh", "api", "user"],
      env: { GH_TOKEN: "gh-secret-value" },
      stdin: null,
      tempHome: true,
      redact: ["gh-secret-value"],
      path: bin,
    });
    const result = await run(ticket);
    expect(result.stdout).toContain("token:••••");
    expect(result.stdout).toContain("gh:set");
    expect(result.stderr).toBe("err:••••\n");
  });

  test("fails closed on a used ticket, a bad ticket, a foreign program or a missing binary", async () => {
    expect((await run("u".repeat(43))).stderr).toContain("venceu ou já foi usado");
    expect((await run("bad ticket")).code).toBe(126);
    const foreign = "f".repeat(43);
    grants.set(foreign, { argv: ["bash", "-c", "id"], env: {}, stdin: null, tempHome: false, redact: [], path: bin });
    expect((await run(foreign)).stderr).toContain("não é permitido");
    const missing = "m".repeat(43);
    grants.set(missing, { argv: ["git"], env: {}, stdin: null, tempHome: false, redact: [], path: bin });
    expect((await run(missing)).stderr).toContain("Não encontrei o programa git");
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const port = closed.port as number;
    closed.stop(true);
    expect((await run("c".repeat(43), port)).stderr).toContain("Não consegui falar com o cofre");
  });
});
