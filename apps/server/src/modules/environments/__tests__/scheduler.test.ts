import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlacementInput, TurnRequest } from "@runelay-bots/protocol";
import {
  boxHello,
  capacity,
  dropAllRunners,
  fakeRunner,
  hostHello,
  runnerDevice,
} from "../../../../test/runner-helpers";
import { clisDir, dataDir, env, hostDataDir, hostHome, hostToolsDir, toolsDir } from "../../../config/env";
import { updatePreferences } from "../../settings/services/preferences.service";
import { environmentsText } from "../constants/environments-messages.constants";
import {
  boxSpecFor,
  hostBoxSpec,
  hostPathOf,
  hostTurnOf,
  toolCredentialMounts,
  workDirOf,
} from "../services/box-spec.service";
import { onHost, runningOnHost, runningOnMac } from "../services/host-turns.service";
import { containsPath, decidePlacement } from "../services/placement.service";
import { place } from "../services/scheduler.service";
import type { RunnerEnvironment } from "../types/environments.types";

const input: PlacementInput = { botId: "b1", provider: "claude", codeCwd: null, memMb: 2048 };

function environment(
  key: string,
  memFreeMb: number | null,
  roots = ["/srv"],
  capabilities = ["boxes"],
): RunnerEnvironment {
  const free = memFreeMb === null ? null : capacity(memFreeMb);
  return {
    key,
    name: key,
    capabilities,
    runner: {
      version: "1",
      name: key,
      kvm: false,
      runtime: "runc",
      providers: ["claude"],
      workspaceRoots: roots,
      capacity: capacity(memFreeMb ?? 0),
    },
    capacity: free,
    boxes: [],
  };
}

const docker = { sandbox: "docker" as const, codeCwd: null };

afterEach(() => {
  dropAllRunners();
  env.BOTS_SANDBOX = "off";
  env.BOTS_HOST_RUNNER = "off";
});

describe("decidePlacement", () => {
  test("stays local while the sandbox is off", () => {
    const environments = [environment("a", 9000)];
    expect(decidePlacement({ ...docker, sandbox: "off", environments })).toEqual({ kind: "local" });
  });

  test("picks the box runner with the most free memory", () => {
    const environments = [environment("a", 4000), environment("b", 9000), environment("c", null)];
    expect(decidePlacement({ ...docker, environments })).toEqual({ kind: "remote", environmentId: "b" });
    expect(decidePlacement({ ...docker, environments: [environment("c", null)] })).toEqual({
      kind: "remote",
      environmentId: "c",
    });
  });

  test("code needs a runner whose workspace roots hold the host path", () => {
    const environments = [environment("a", 9000, ["/srv/repos/"]), environment("b", 20_000, ["/other"])];
    expect(decidePlacement({ ...docker, codeCwd: "/srv/repos/app", environments })).toEqual({
      kind: "remote",
      environmentId: "a",
    });
    expect(decidePlacement({ ...docker, codeCwd: "/home/x", environments })).toEqual({ kind: "local" });
    const bare = { ...environment("c", 9000), runner: null };
    expect(decidePlacement({ ...docker, codeCwd: "/srv/a", environments: [bare] })).toEqual({ kind: "local" });
  });

  test("ignores runners without boxes and falls back to local when none is left", () => {
    const mac = environment("mac", 50_000, ["/srv"], ["computer"]);
    expect(decidePlacement({ ...docker, environments: [mac] })).toEqual({ kind: "local" });
    expect(decidePlacement({ ...docker, environments: [] })).toEqual({ kind: "local" });
  });

  test("prefers the host runner of the chosen environment and never falls back from the Mac", () => {
    const off = { key: null, online: false, canRun: false };
    const hosts = { vps: { key: "host-1", online: true, canRun: true }, mac: off };
    const environments = [environment("a", 9000)];
    expect(decidePlacement({ ...docker, environments, hosts })).toEqual({
      kind: "remote",
      environmentId: "host-1",
      host: true,
    });
    expect(decidePlacement({ ...docker, environments, hosts: { vps: off, mac: off } })).toEqual({
      kind: "remote",
      environmentId: "a",
    });
    expect(decidePlacement({ ...docker, environments, hosts, environment: "mac" })).toEqual({
      kind: "offline",
      message: environmentsText("macOffline"),
    });
    expect(decidePlacement({ ...docker, environments, environment: "mac" })).toEqual({
      kind: "offline",
      message: environmentsText("macOffline"),
    });
    const mac = { key: "mac-1:runner", online: true, canRun: true };
    expect(decidePlacement({ ...docker, environments, hosts: { ...hosts, mac }, environment: "mac" })).toEqual({
      kind: "remote",
      environmentId: "mac-1:runner",
      host: true,
      environment: "mac",
    });
  });

  test("matches paths by whole segment", () => {
    expect(containsPath("/srv", "/srv")).toBe(true);
    expect(containsPath("/srv/", "/srv/a")).toBe(true);
    expect(containsPath("/srv", "/srvx")).toBe(false);
  });
});

describe("place", () => {
  test("keeps everything local by default", () => {
    const box = fakeRunner(runnerDevice("box-1"));
    box.say(boxHello());
    expect(env.BOTS_SANDBOX).toBe("off");
    expect(place(input)).toEqual({ kind: "local" });
  });

  test("runs on the server's own host runner and says so when it falls back to the container", () => {
    env.BOTS_HOST_RUNNER = "on";
    expect(place(input)).toEqual({ kind: "local", notice: environmentsText("hostFallback") });
    const mac = fakeRunner(runnerDevice("mac-1", 5));
    mac.say({ type: "hello", version: "9", capabilities: ["computer", "host"] });
    expect(place(input)).toEqual({ kind: "local", notice: environmentsText("hostFallback") });
    const host = fakeRunner(runnerDevice("host-1"));
    host.say(hostHello());
    expect(place(input)).toEqual({ kind: "remote", environmentId: "host-1", host: true });
  });

  test("runs on the Mac runner when the owner picked Este Mac", async () => {
    await updatePreferences({ environment: "mac" });
    expect(place(input)).toEqual({ kind: "offline", message: environmentsText("macOffline") });
    const runner = fakeRunner(runnerDevice("mac-1:runner", 5, { deviceId: "mac-1" }));
    runner.say(hostHello({ environment: "mac" }));
    expect(place(input)).toEqual({ kind: "remote", environmentId: "mac-1:runner", host: true, environment: "mac" });
    await updatePreferences({ environment: "vps" });
    expect(place(input)).toEqual({ kind: "local" });
  });

  test("sends turns to the owner box runner with docker and warns when there is none", () => {
    env.BOTS_SANDBOX = "docker";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(place(input)).toEqual({ kind: "local" });
    expect(warn.mock.calls[0]?.[0]).toContain("sandbox: no box runner for bot b1, running local");
    const small = fakeRunner(runnerDevice("box-1"));
    small.say(boxHello({ memFreeMb: 5000 }));
    const bigger = fakeRunner(runnerDevice("box-2", 2));
    bigger.say(boxHello({ memFreeMb: 50_000, workspaceRoots: ["/other"] }));
    const member = fakeRunner(runnerDevice("box-3", 3, { owner: false, userId: "u2" }));
    member.say(boxHello({ memFreeMb: 90_000 }));
    expect(place(input)).toEqual({ kind: "remote", environmentId: "box-2" });
    expect(place({ ...input, codeCwd: "/srv/repo" })).toEqual({ kind: "remote", environmentId: "box-1" });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("host turns", () => {
  test("rewrites the server paths of a turn to the host ones", () => {
    const base = {
      turnId: "t1",
      provider: "claude",
      workKey: "b1/s1",
      systemPrompt: `Anexo em ${dataDir}/bots/b1/uploads/a.png e https://x.com${dataDir}/y`,
      prompt: `veja "${dataDir}/bots/b1/uploads/a.png"`,
    } as unknown as TurnRequest;
    const turn = hostTurnOf({
      ...base,
      images: [{ path: join(dataDir, "bots", "b1", "uploads", "a.png"), mime: "image/png", label: "a" }],
      code: { cwd: join(dataDir, "workspaces", "b1"), readOnly: true },
      configDir: "/home/app/.claude",
    });
    expect(turn.images?.[0]?.path).toBe(join(hostDataDir, "bots", "b1", "uploads", "a.png"));
    expect(turn.code).toEqual({ cwd: join(hostDataDir, "workspaces", "b1"), readOnly: true });
    expect(turn.configDir).toBe(`${hostHome}/.claude`);
    expect(turn.systemPrompt).toBe(`Anexo em ${hostDataDir}/bots/b1/uploads/a.png e https://x.com${dataDir}/y`);
    expect(turn.prompt).toBe(`veja "${hostDataDir}/bots/b1/uploads/a.png"`);
    const bare = hostTurnOf(base);
    expect([bare.images, bare.code, bare.configDir]).toEqual([undefined, undefined, undefined]);
    expect(hostBoxSpec()).toEqual({ memMb: env.BOX_MEM_MB, cpus: env.BOX_CPUS, mounts: [] });
  });

  test("marks the hooks of a host turn", async () => {
    const seen: boolean[] = [];
    const hooks = onHost({
      before: async () => {
        seen.push(runningOnHost());
        return { allow: true };
      },
      after: async () => {
        seen.push(runningOnHost());
      },
    });
    expect(await hooks.before("Bash", {}, "u1")).toEqual({ allow: true });
    await hooks.after("Bash", {}, null, "u1", false);
    expect(seen).toEqual([true, true]);
    expect(runningOnHost()).toBe(false);
    const flags: boolean[] = [];
    const mac = onHost(
      {
        before: async () => {
          flags.push(runningOnMac());
          return { allow: true };
        },
        after: async () => {},
      },
      "mac",
    );
    await mac.before("Bash", {}, "u2");
    await hooks.before("Bash", {}, "u3");
    expect(flags).toEqual([true]);
    expect(seen.at(-1)).toBe(true);
    expect(runningOnMac()).toBe(false);
  });
});

describe("box spec", () => {
  const request = { turnId: "t1", provider: "claude", workKey: "b1/s 1", code: null } as unknown as TurnRequest;

  test("translates the data dir and the container home to the host", () => {
    expect(hostPathOf(join(dataDir, "work", "x"))).toBe(join(hostDataDir, "work", "x"));
    expect(hostPathOf(dataDir)).toBe(hostDataDir);
    expect(hostPathOf("/home/app/.claude")).toBe(`${hostHome}/.claude`);
    expect(hostPathOf("/srv/repo")).toBe("/srv/repo");
    expect(hostPathOf(join(toolsDir, "chrome"))).toBe(join(hostToolsDir, "chrome"));
    expect(workDirOf(request)).toBe(join(dataDir, "work", "b1/s_1"));
  });

  test("mounts the work dir, the account and the code at the same path", () => {
    expect(boxSpecFor({ request, accountPath: null })).toEqual({
      memMb: env.BOX_MEM_MB,
      cpus: env.BOX_CPUS,
      mounts: [{ host: join(hostDataDir, "work", "b1"), box: join(dataDir, "work", "b1"), readOnly: false }],
    });
    const coding = { ...request, code: { cwd: "/srv/repo", readOnly: true } };
    expect(boxSpecFor({ request: coding, accountPath: "/home/app/.claude" }).mounts).toEqual([
      { host: join(hostDataDir, "work", "b1"), box: join(dataDir, "work", "b1"), readOnly: false },
      { host: `${hostHome}/.claude`, box: "/home/app/.claude", readOnly: false },
      { host: "/srv/repo", box: "/srv/repo", readOnly: true },
      { host: join(hostDataDir, "locks"), box: join(dataDir, "locks"), readOnly: false },
    ]);
    const home = { ...request, code: { cwd: "/home/app/.claude" } };
    expect(boxSpecFor({ request: home, accountPath: "/home/app/.claude" }).mounts).toHaveLength(3);
  });

  test("mounts the main .git of a worktree, so git works inside the box", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rb-git-")));
    try {
      const common = join(root, "repo", ".git");
      const worktree = join(root, "wt");
      const plain = join(root, "plain");
      const loose = join(root, "loose");
      mkdirSync(join(common, "worktrees", "wt"), { recursive: true });
      mkdirSync(worktree);
      mkdirSync(join(plain, ".git"), { recursive: true });
      mkdirSync(loose);
      writeFileSync(join(worktree, ".git"), "gitdir: ../repo/.git/worktrees/wt\n");
      writeFileSync(join(loose, ".git"), "gitdir: /elsewhere/.git\n");
      const mountsOf = (cwd: string) =>
        boxSpecFor({ request: { ...request, code: { cwd } }, accountPath: null }).mounts.map(({ box }) => box);
      const coding = boxSpecFor({ request: { ...request, code: { cwd: worktree } }, accountPath: null });
      expect(coding.mounts).toContainEqual({ host: common, box: common, readOnly: false, optional: true });
      expect(mountsOf(plain)).not.toContain(join(plain, ".git"));
      expect(mountsOf(loose)).not.toContain("/elsewhere/.git");
      expect(mountsOf(join(root, "missing"))).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mounts the CLI logins for the sandbox user only when they exist", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "rb-home-")));
    try {
      expect(toolCredentialMounts(home)).toEqual([]);
      mkdirSync(join(home, ".config", "gh"), { recursive: true });
      writeFileSync(join(home, ".gitconfig"), "[user]\n");
      expect(toolCredentialMounts(home)).toEqual([
        { host: join(home, ".config", "gh"), box: "/home/runelaytool/.config/gh", readOnly: true, optional: true },
        { host: join(home, ".gitconfig"), box: "/home/runelaytool/.gitconfig.host", readOnly: true, optional: true },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("gives every conversation of a bot the same mounts, so they share one box", () => {
    const other = { ...request, workKey: "b1/s 2" };
    expect(boxSpecFor({ request: other, accountPath: null })).toEqual(boxSpecFor({ request, accountPath: null }));
  });

  test("mounts folders the account links to outside itself, so sessions survive a new box", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rb-account-")));
    try {
      const account = join(root, ".claude-2");
      const shared = join(root, ".claude", "projects");
      mkdirSync(join(account, "inner"), { recursive: true });
      mkdirSync(shared, { recursive: true });
      writeFileSync(join(root, "CLAUDE.md"), "x");
      symlinkSync(shared, join(account, "projects"));
      symlinkSync(join(root, "CLAUDE.md"), join(account, "CLAUDE.md"));
      symlinkSync(join(account, "inner"), join(account, "inner-link"));
      symlinkSync(join(root, "missing"), join(account, "dangling"));
      expect(boxSpecFor({ request, accountPath: account }).mounts.slice(1)).toEqual([
        { host: account, box: account, readOnly: false },
        { host: shared, box: shared, readOnly: false },
      ]);
      expect(boxSpecFor({ request, accountPath: join(root, "absent") }).mounts).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mounts the bot uploads read-only, so pasted images reach the model in the box", () => {
    const uploads = join(dataDir, "bots", "b1", "uploads");
    mkdirSync(uploads, { recursive: true });
    try {
      expect(boxSpecFor({ request, accountPath: null }).mounts).toEqual([
        { host: join(hostDataDir, "work", "b1"), box: join(dataDir, "work", "b1"), readOnly: false },
        { host: join(hostDataDir, "bots", "b1", "uploads"), box: uploads, readOnly: true },
      ]);
    } finally {
      rmSync(join(dataDir, "bots", "b1"), { recursive: true, force: true });
    }
  });

  test("mounts the managed clis read-only at the same path once the folder exists", () => {
    expect(clisDir).toBe(join(dataDir, "clis"));
    mkdirSync(clisDir, { recursive: true });
    try {
      expect(boxSpecFor({ request, accountPath: null }).mounts).toEqual([
        { host: join(hostDataDir, "work", "b1"), box: join(dataDir, "work", "b1"), readOnly: false },
        { host: join(hostDataDir, "clis"), box: join(dataDir, "clis"), readOnly: true },
      ]);
    } finally {
      rmSync(clisDir, { recursive: true, force: true });
    }
  });

  test("mounts the downloaded tools read-only at the same path once the folder exists", () => {
    expect(hostToolsDir).toBe(join(hostHome, ".local", "share", "runelay-bots-tools"));
    mkdirSync(toolsDir, { recursive: true });
    try {
      expect(boxSpecFor({ request, accountPath: null }).mounts).toEqual([
        { host: join(hostDataDir, "work", "b1"), box: join(dataDir, "work", "b1"), readOnly: false },
        { host: hostToolsDir, box: toolsDir, readOnly: true },
      ]);
    } finally {
      rmSync(toolsDir, { recursive: true, force: true });
    }
  });
});
