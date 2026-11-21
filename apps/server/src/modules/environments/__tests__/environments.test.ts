import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "../../../../test/helpers";
import { boxHello, capacity, dropAllRunners, fakeRunner, runnerDevice } from "../../../../test/runner-helpers";
import type { AuthModule } from "../../auth";
import { useAuthModule } from "../../auth/gate";
import { listEnvironments, onEnvironmentsChange } from "../services/environments.service";
import { meminfoMb, readLocalCapacity } from "../services/local-capacity.service";

const scratch = mkdtempSync(join(tmpdir(), "rb-env-"));

afterEach(() => {
  dropAllRunners();
  useAuthModule(null);
});

describe("local capacity", () => {
  test("reads /proc/meminfo and falls back to the os", () => {
    const file = join(scratch, "meminfo");
    writeFileSync(file, "MemTotal:       4194304 kB\nMemFree:  1 kB\nMemAvailable:   2097152 kB\n");
    expect(readLocalCapacity(file)).toEqual({
      cpus: cpus().length,
      memTotalMb: 4096,
      memFreeMb: 2048,
      boxesRunning: 0,
      boxesPaused: 0,
      maxBoxes: 0,
    });
    const fallback = readLocalCapacity(join(scratch, "missing"));
    expect(fallback.memTotalMb).toBeGreaterThan(0);
    expect(fallback.memFreeMb).toBeGreaterThan(0);
    expect(meminfoMb("MemTotal: x kB", "MemTotal")).toBeNull();
    expect(readLocalCapacity().memTotalMb).toBeGreaterThan(0);
    rmSync(scratch, { recursive: true, force: true });
  });
});

describe("environments", () => {
  test("always lists local and adds box runners of the owner", () => {
    expect(listEnvironments()).toEqual([
      expect.objectContaining({ id: "local", name: "local", kind: "local", connected: true, runtime: null, boxes: [] }),
    ]);
    const mac = fakeRunner(runnerDevice("mac-1"));
    mac.say({ type: "hello", capabilities: ["computer"] });
    const member = fakeRunner(runnerDevice("member-box", 1, { owner: false, userId: "u2" }));
    member.say(boxHello());
    const bare = fakeRunner(runnerDevice("bare-box", 2, { deviceName: null }));
    bare.say({ type: "hello", capabilities: ["boxes"] });
    const box = fakeRunner(runnerDevice("box-1"));
    box.say(boxHello({ memFreeMb: 3000 }));
    const listed = listEnvironments();
    expect(listed.map(({ id }) => id)).toEqual(["local", "bare-box", "box-1"]);
    expect(listed[1]).toEqual({
      id: "bare-box",
      name: "bare-box",
      kind: "runner",
      connected: true,
      capabilities: ["boxes"],
      runtime: null,
      capacity: null,
      boxes: [],
    });
    expect(listed[2]).toMatchObject({ name: "vps-2", runtime: "runsc", capacity: capacity(3000) });
    const named = fakeRunner(runnerDevice("named-box", 3));
    named.say({ type: "hello", capabilities: ["boxes"] });
    expect(listEnvironments().find(({ id }) => id === "named-box")?.name).toBe("Máquina named-box");
  });

  test("notifies on connect, frames and disconnect", () => {
    let calls = 0;
    const stop = onEnvironmentsChange(() => calls++);
    const stopBroken = onEnvironmentsChange(() => {
      throw new Error("listener broke");
    });
    const box = fakeRunner(runnerDevice("box-2"));
    box.say(boxHello());
    box.say({ type: "capacity", capacity: capacity(100) });
    box.say({ type: "boxes", boxes: [] });
    box.drop();
    expect(calls).toBe(5);
    stop();
    stopBroken();
    fakeRunner(runnerDevice("box-3"));
    expect(calls).toBe(5);
  });
});

describe("GET /environments", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  async function call(authorization?: string) {
    const response = await fetch(`${server.url}/environments`, {
      headers: authorization ? { authorization } : {},
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  test("answers anyone while auth is off", async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect((body.environments as Array<{ id: string }>).map(({ id }) => id)).toEqual(["local"]);
  });

  test("serves only the owner once auth is on", async () => {
    const base = { userId: "u1", email: "a@b.c", name: "A", method: "session" };
    const principals: Record<string, unknown> = {
      "Bearer owner": { ...base, role: "owner" },
      "Bearer member": { ...base, role: "member" },
      "Bearer internal": { ...base, role: "owner", method: "internal" },
    };
    useAuthModule({
      authenticate: async (request: Request) => {
        const principal = principals[request.headers.get("authorization") ?? ""];
        return principal ? { kind: "principal", principal } : { kind: "public" };
      },
      handle: async () => null,
    } as unknown as AuthModule);
    expect((await call("Bearer owner")).status).toBe(200);
    const member = await call("Bearer member");
    expect(member.status).toBe(403);
    expect(member.body).toEqual({ ok: false, error: "Só o dono da conta pode fazer isso.", code: "forbidden" });
    const internal = await call("Bearer internal");
    expect(internal.status).toBe(403);
    expect(internal.body).toMatchObject({ error: "O token interno não tem acesso a esta rota." });
    expect((await call()).status).toBe(401);
  });
});
