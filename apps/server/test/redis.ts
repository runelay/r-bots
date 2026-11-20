import { randomBytes } from "node:crypto";
import type { RedisSettings } from "../src/config/redis";

export interface TestRedis {
  settings: RedisSettings;
  stop: () => Promise<void>;
}

async function docker(args: string[]) {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`docker ${args[0]}: ${err.trim()}`);
  return out.trim();
}

export async function startRedis(): Promise<TestRedis> {
  const name = `rb-test-redis-${randomBytes(4).toString("hex")}`;
  const password = randomBytes(12).toString("hex");
  try {
    await docker([
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-p",
      "127.0.0.1::6379",
      process.env.TEST_REDIS_IMAGE ?? "redis:7.4-alpine",
      "redis-server",
      "--requirepass",
      password,
      "--appendonly",
      "no",
      "--save",
      "",
    ]);
    const port = Number((await docker(["port", name, "6379/tcp"])).split("\n")[0]?.split(":").at(-1));
    const cli = (...args: string[]) => docker(["exec", "-e", `REDISCLI_AUTH=${password}`, name, "redis-cli", ...args]);
    const started = Date.now();
    while ((await cli("ping").catch(() => "")) !== "PONG") {
      if (Date.now() - started > 20_000) throw new Error("redis de teste não subiu");
      await Bun.sleep(50);
    }
    return {
      settings: { host: "127.0.0.1", port, db: 0, password, tls: false },
      stop: async () => {
        await docker(["rm", "-f", name]);
      },
    };
  } catch (error) {
    await docker(["rm", "-f", name]).catch(() => undefined);
    throw error;
  }
}
