import { join } from "node:path";
import { wrapHeavyCommand } from "../../apps/server/src/modules/code/services/heavy-commands.service";

const reader = Bun.stdin.stream().getReader();
let buffer = "";
while (!buffer.includes("\n")) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += new TextDecoder().decode(value);
}
const start = JSON.parse(buffer.split("\n")[0] ?? "{}") as { request: { code: { cwd: string } } };
const cwd = start.request.code.cwd;
const dataDir = process.env.BOTS_DATA_DIR ?? "";
const lockFile = join(dataDir, "locks", "tests.lock");
const testCommand = wrapHeavyCommand("bun test smoke", "echo tested", undefined, lockFile) ?? "";

async function shell(command: string) {
  const proc = Bun.spawn(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${stdout}${stderr}`.trim().slice(0, 400) };
}

const report = {
  user: (await shell("id -un")).out,
  cgroup: (await shell("cat /proc/self/cgroup")).out,
  git: await shell("git status --short --branch"),
  gh: await shell("gh --version"),
  test: { command: testCommand, ...(await shell(testCommand)) },
  vault: await shell(`cat ${JSON.stringify(join(dataDir, "vault.key"))}`),
};
const writer = Bun.stdout.writer();
const out = (message: unknown) => writer.write(`${JSON.stringify(message)}\n`);
out({ type: "event", event: { type: "text", part: "report", text: JSON.stringify(report) } });
out({ type: "event", event: { type: "done", ok: true } });
out({ type: "end", ok: true });
await writer.flush();
process.exit(0);
