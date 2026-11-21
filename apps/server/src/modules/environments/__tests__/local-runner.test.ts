import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freshDb } from "../../../../test/db-helpers";
import { dataDir, env } from "../../../config/env";
import { redactText } from "../../../shared/redact";
import { type AuthModule, createAuthModule, type Principal } from "../../auth";
import { useAuthModule } from "../../auth/gate";
import type { AuthDatabase } from "../../auth/services/auth.service";
import { listDevices, revokeDevice } from "../../devices/services/devices.service";
import { ensureLocalRunnerToken, localRunnerTokenPath, startLocalRunnerToken } from "../services/local-runner.service";

let dir: string;
let mod: AuthModule;
let owner: Principal;

const tokenPath = localRunnerTokenPath();

function storedToken() {
  return readFileSync(tokenPath, "utf8").trim();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "rb-local-runner-"));
  mod = createAuthModule({
    db: (await freshDb()) as unknown as AuthDatabase,
    env: {},
    dataDir: join(dir, "data"),
    repoDir: join(dir, "repo"),
    serverDir: join(dir, "server"),
    host: "127.0.0.1",
    port: 2999,
  });
});

afterEach(() => {
  useAuthModule(null);
  env.BOTS_SANDBOX = "off";
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(dirname(tokenPath), { recursive: true, force: true });
});

describe("local runner token", () => {
  test("does nothing while the sandbox is off or auth is off", async () => {
    expect(await ensureLocalRunnerToken()).toBe("off");
    env.BOTS_SANDBOX = "docker";
    expect(await ensureLocalRunnerToken()).toBe("no-auth");
    expect(await startLocalRunnerToken(1).settled).toBe("no-auth");
  });

  test("waits for the owner, then writes a device key the redaction knows", async () => {
    env.BOTS_SANDBOX = "docker";
    useAuthModule(mod);
    expect(await ensureLocalRunnerToken()).toBe("waiting");
    const log = spyOn(console, "log").mockImplementation(() => {});
    const watch = startLocalRunnerToken(5);
    const created = await mod.access.setupOwner(
      { name: "Dona", email: "dona@example.com", password: "correct horse battery" },
      readFileSync(mod.setupToken.issue(), "utf8").trim(),
    );
    owner = {
      userId: created.user.id,
      email: created.user.email,
      name: created.user.name,
      role: "owner",
      method: "session",
    };
    expect(await watch.settled).toBe("written");
    expect(log.mock.calls.flat().join(" ")).toContain(`sandbox: local runner token in ${tokenPath}`);
    log.mockRestore();
    const token = storedToken();
    expect(token).toStartWith("rbk_");
    expect(tokenPath).toBe(join(dataDir, "runner", "box-runner.token"));
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(tokenPath)).mode & 0o777).toBe(0o700);
    expect(redactText(`token ${token}`)).not.toContain(token);
    const devices = await listDevices(owner);
    expect(devices.filter(({ name }) => name === "local-runner")).toHaveLength(1);
  });

  test("keeps a live key and replaces a revoked or unknown one", async () => {
    env.BOTS_SANDBOX = "docker";
    useAuthModule(mod);
    const first = storedToken();
    expect(await ensureLocalRunnerToken()).toBe("kept");
    expect(storedToken()).toBe(first);
    const [device] = (await listDevices(owner)).filter(({ name }) => name === "local-runner");
    await revokeDevice(owner, device.id);
    expect(await ensureLocalRunnerToken()).toBe("written");
    const second = storedToken();
    expect(second).not.toBe(first);
    writeFileSync(tokenPath, "rbk_not-a-key\n");
    expect(await ensureLocalRunnerToken()).toBe("written");
    expect(storedToken()).not.toBe("rbk_not-a-key");
    rmSync(tokenPath);
    expect(await ensureLocalRunnerToken()).toBe("written");
    expect((await listDevices(owner)).filter(({ name }) => name === "local-runner")).toHaveLength(1);
  });

  test("retries after a failure and stops on demand", async () => {
    env.BOTS_SANDBOX = "docker";
    useAuthModule(mod);
    const error = spyOn(console, "error").mockImplementation(() => {});
    const findOwner = spyOn(mod.access, "findOwner");
    findOwner.mockRejectedValueOnce(new Error("db down"));
    findOwner.mockRejectedValueOnce("db still down");
    expect(await startLocalRunnerToken(1).settled).toBe("kept");
    expect(error.mock.calls.flat()).toEqual([
      "sandbox: local runner token failed: db down",
      "sandbox: local runner token failed: db still down",
    ]);
    findOwner.mockResolvedValue(null);
    const waiting = startLocalRunnerToken(60_000);
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    waiting.stop();
    expect(await waiting.settled).toBe("stopped");
    const inFlight = startLocalRunnerToken(1);
    inFlight.stop();
    expect(await inFlight.settled).toBe("stopped");
    findOwner.mockRestore();
    error.mockRestore();
  });
});
