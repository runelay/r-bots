import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

type Frame = Record<string, unknown>;

const root = resolve(import.meta.dir, "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "rbots-smoke-"));
const dataDir = join(scratch, "data");
mkdirSync(join(dataDir, "locks"), { recursive: true });
writeFileSync(join(dataDir, "vault.key"), "smoke-secret\n");
const requireBwrap = process.env.SMOKE_REQUIRE_BWRAP === "1";
const requireScope = process.env.SMOKE_REQUIRE_SCOPE === "1";
const runnerMain = process.env.SMOKE_RUNNER ?? join(root, "packages", "runner", "src", "main.ts");

const frames: Frame[] = [];
const { promise: ended, resolve: onEnd } = Promise.withResolvers<void>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, srv) {
    if (srv.upgrade(request, { data: undefined })) return undefined;
    return new Response("no", { status: 404 });
  },
  websocket: {
    message(socket, message) {
      const frame = JSON.parse(String(message)) as Frame;
      frames.push(frame);
      if (frame.type === "hello")
        socket.send(
          JSON.stringify({
            type: "request",
            id: "smoke-1",
            op: "turn.start",
            turnId: "smoke-1",
            botId: "smoke-bot",
            request: {
              turnId: "smoke-1",
              provider: "claude",
              model: "smoke",
              effort: null,
              systemPrompt: "",
              prompt: "",
              resume: null,
              mcp: null,
              workKey: "smoke-bot/s1",
              code: { cwd: root },
            },
            box: { memMb: 512, cpus: 1, mounts: [] },
            hooks: false,
          }),
        );
      if (frame.type === "turn.end") onEnd();
    },
  },
});

const runner = Bun.spawn(["bun", runnerMain], {
  env: {
    ...process.env,
    RBOTS_PROVIDER: "host",
    RBOTS_URL: `http://127.0.0.1:${server.port}`,
    RBOTS_DEVICE_TOKEN: "smoke",
    RBOTS_RUNNER_NAME: "smoke",
    RBOTS_HEALTH_FILE: join(scratch, "health"),
    BOTS_DATA_DIR: dataDir,
    RBOTS_BOX_AGENT: join(import.meta.dir, "host-agent.ts"),
  },
  stdout: "inherit",
  stderr: "inherit",
});

const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

try {
  await Promise.race([ended, Bun.sleep(60_000).then(() => Promise.reject(new Error("turn did not end in 60 s")))]);
  const hello = frames.find((frame) => frame.type === "hello") as { capabilities: string[]; runner: { runtime: string } };
  const text = frames
    .filter((frame) => frame.type === "turn.event")
    .map((frame) => frame.event as { type: string; text?: string })
    .find((event) => event.type === "text")?.text;
  const report = JSON.parse(text ?? "{}") as Record<string, { code: number; out: string; command?: string }> & {
    user: string;
    cgroup: string;
  };
  console.log(JSON.stringify(report, null, 2));
  check(hello.capabilities.includes("host") && hello.runner.runtime === "host", "runner announces host");
  check(report.user === userInfo().username, "commands run as the runner user");
  check(report.git?.code === 0, "git status works");
  check(report.gh?.code === 0, "gh --version works");
  check(report.test?.code === 0 && report.test.out === "tested", "test command runs through the lock");
  check(
    report.test?.command?.startsWith("flock ") === true && !/sudo|runelaytool|rb-sandbox-exec/.test(report.test.command),
    "no uid sandbox wrapper",
  );
  const hidden = report.vault?.code !== 0;
  console.log(hidden ? "vault hidden by bwrap" : "vault visible (no bwrap)");
  if (requireBwrap) check(hidden, "bwrap hides the data dir");
  const scoped = /\.scope/.test(report.cgroup);
  console.log(scoped ? "turn runs in a systemd scope" : "turn runs without a systemd scope");
  if (requireScope) check(scoped, "systemd scope limits the turn");
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  runner.kill();
  server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`smoke failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("host runner smoke ok");
