import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import * as dbModule from "../../../db";
import { type Db, getDb } from "../../../db";
import { codeWorkspaces } from "../../../db/tables";
import { addAllowedRepo, allowedRepos, fileRoots, seedAllowedRepos, worktreesRoot } from "../services/repos.service";

const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  seedAllowedRepos();
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
  test("fileRoots lists the worktree root, allowed repos and worktrees that were not removed", () => {
    const repo = addAllowedRepo(join(process.env.HOST_HOME as string, "repos", `roots-${Date.now()}`), "teste", "ana");
    const now = new Date().toISOString();
    const live = join(worktreesRoot, `live-${Date.now()}`);
    const gone = join(worktreesRoot, `gone-${Date.now()}`);
    const base = { botId: "bot-roots", repo: repo.path, repoName: repo.name, branch: "b", base: "main", createdAt: now };
    getDb()
      .insert(codeWorkspaces)
      .values([
        { ...base, id: `ws_live_${Date.now()}`, path: live, status: "active" },
        { ...base, id: `ws_gone_${Date.now()}`, path: gone, status: "removed", branch: "c" },
      ])
      .run();
    const roots = fileRoots();
    expect(roots[0]).toBe(worktreesRoot);
    expect(roots).toContain(repo.path);
    expect(roots).toContain(live);
    expect(roots).not.toContain(gone);
  });

  test("a database that cannot be read leaves an empty allow list and only the worktree root", () => {
    failingSelects();
    const path = join(process.env.HOST_HOME as string, "repos", `offline-${Date.now()}`);
    const added = addAllowedRepo(path, "sem banco", null);
    expect(added).toMatchObject({ path, name: path.split("/").at(-1), reason: "sem banco", addedBy: null });
    expect(allowedRepos()).toEqual([]);
    expect(fileRoots()).toEqual([worktreesRoot]);
  });
});
