import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import * as dbModule from "../../../db";
import { type Db, getDb } from "../../../db";
import { codeWorkspaces } from "../../../db/tables";
import { dataDir } from "../../../config/env";
import {
  addAllowedRepo,
  allowedRepos,
  fileRoots,
  repoRootProblem,
  seedAllowedRepos,
  worktreesRoot,
} from "../services/repos.service";

const spies: Array<{ mockRestore: () => void }> = [];

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await seedAllowedRepos();
});

function failingSelects() {
  const real = getDb();
  const broken = new Proxy(real, {
    get(target, key, receiver) {
      if (key === "select") {
        return () => {
          throw new Error("banco fora");
        };
      }
      return Reflect.get(target, key, receiver);
    },
  }) as Db;
  const spy = spyOn(dbModule, "getDb").mockReturnValue(broken);
  spies.push(spy);
}

describe("repos", () => {
  test("fileRoots lists the worktree root, allowed repos and worktrees that were not removed", async () => {
    const repo = await addAllowedRepo(
      join(process.env.HOST_HOME as string, "repos", `roots-${Date.now()}`),
      "teste",
      "ana",
    );
    const now = new Date().toISOString();
    const live = join(worktreesRoot, `live-${Date.now()}`);
    const gone = join(worktreesRoot, `gone-${Date.now()}`);
    const base = {
      botId: "bot-roots",
      repo: repo.path,
      repoName: repo.name,
      branch: "b",
      base: "main",
      createdAt: now,
    };
    await getDb()
      .insert(codeWorkspaces)
      .values([
        { ...base, id: `ws_live_${Date.now()}`, path: live, status: "active" },
        { ...base, id: `ws_gone_${Date.now()}`, path: gone, status: "removed", branch: "c" },
      ]);
    const roots = await fileRoots();
    expect(roots[0]).toBe(worktreesRoot);
    expect(roots).toContain(repo.path);
    expect(roots).toContain(live);
    expect(roots).not.toContain(gone);
  });

  test("a database that cannot be read leaves an empty allow list and only the worktree root", async () => {
    failingSelects();
    const path = join(process.env.HOST_HOME as string, "repos", `offline-${Date.now()}`);
    const added = await addAllowedRepo(path, "sem banco", null);
    expect(added).toMatchObject({ path, name: path.split("/").at(-1), reason: "sem banco", addedBy: null });
    expect(allowedRepos()).toEqual([]);
    expect(await fileRoots()).toEqual([worktreesRoot]);
  });
});

describe("repoRootProblem", () => {
  test("refuses the root, the home folder and anything that holds or sits in a server folder", () => {
    const home = process.env.HOST_HOME as string;
    expect(repoRootProblem("/")).toContain("pasta pessoal inteira");
    expect(repoRootProblem(home)).toContain("pasta pessoal inteira");
    expect(repoRootProblem("~")).toContain("pasta pessoal inteira");
    expect(repoRootProblem(dataDir)).toContain("pasta do servidor");
    expect(repoRootProblem(join(dataDir, "code"))).toContain("pasta do servidor");
    expect(repoRootProblem(join(home, ".local"))).toContain("pasta do servidor");
    expect(repoRootProblem(join(worktreesRoot, "repo", "task"))).toContain("pasta do servidor");
    expect(repoRootProblem("/etc")).toContain("pasta do servidor");
    expect(repoRootProblem(join(home, "repos", "app"))).toBeNull();
  });
});
