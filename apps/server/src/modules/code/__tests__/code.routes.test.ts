import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeProcesses, makeRepo } from "../../../../test/code-helpers";
import { factsOfType, makeBot, waitFor } from "../../../../test/engine-helpers";
import { fakeProviders, request, resetData, startTestServer, type TestServer } from "../../../../test/helpers";
import { Req } from "../../../shared/http";
import type { Socket } from "../../../shared/ws";
import type { BotDefinition } from "../../bots/services/bots.service";
import { createConversation } from "../../conversations/services/conversations.service";
import { getStoredSession, type StoredSession } from "../../conversations/services/sessions.service";
import { ensureThread } from "../../conversations/services/threads.service";
import { deliver, isBusy } from "../../engine/services/engine.service";
import * as codeRepository from "../repositories/code.repository";
import { addGrant } from "../repositories/code.repository";
import { isPreviewTraffic, previewSocket, previewUpgradeTarget } from "../routes/code.routes";
import * as devServer from "../services/dev-server.service";
import * as workspaceService from "../services/workspace.service";
import { activeWorkspace, createCheckpoint, listRepos, waitForInstall } from "../services/workspace.service";

let server: TestServer;
let bot: BotDefinition;
const spies: Mock<(...args: never[]) => unknown>[] = [];
const upstreams: ReturnType<typeof Bun.serve>[] = [];
let repoCount = 0;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await resetData();
  codeProcesses();
  bot = await makeBot();
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await Promise.all(upstreams.splice(0).map((item) => item.stop(true)));
});

function spy<T extends object, K extends keyof T>(target: T, key: K) {
  const created = spyOn(target, key as never) as unknown as Mock<(...args: never[]) => unknown>;
  spies.push(created);
  return created;
}

async function threadSession(target = bot) {
  const thread = await ensureThread(target.id);
  return getStoredSession(thread.sessionId) as StoredSession;
}

async function openRepo(options: { files?: Record<string, string>; origin?: boolean } = {}) {
  repoCount++;
  const name = `routes-${repoCount}-${Math.random().toString(36).slice(2, 6)}`;
  await makeRepo(name, {
    files: options.files ?? { "README.md": "hello\n", "src/a.txt": "a\n" },
    origin: options.origin,
  });
  await listRepos(true);
  const opened = await request<{ created: boolean; workspace: { repoName: string } }>(
    `/bots/${bot.id}/code/workspace`,
    { method: "POST", body: { repo: name, task: "ajustar rotas" } },
  );
  expect(opened.status).toBe(201);
  expect(opened.body.created).toBe(true);
  expect(opened.body.workspace.repoName).toBe(name);
  const session = await threadSession();
  const workspace = activeWorkspace(session) as workspaceService.WorkspaceState;
  await waitForInstall(workspace);
  return { name, session, workspace };
}

async function hold(session: StoredSession) {
  let release = () => undefined as undefined;
  fakeProviders.next(
    ({ emit, signal }) =>
      new Promise<void>((resolve) => {
        release = () => {
          emit({ type: "done", ok: true });
          resolve();
        };
        signal.addEventListener("abort", () => release(), { once: true });
      }),
  );
  const before = fakeProviders.turns.length;
  deliver(session, { deliveryId: "hold", text: "trabalha", source: "chat" });
  await waitFor(() => fakeProviders.turns.length > before);
  return async () => {
    release();
    await waitFor(() => !isBusy(session.meta.sessionId));
  };
}

describe("global code routes", () => {
  test("lists repos with a query, grants and worktrees", async () => {
    const { name } = await openRepo();
    const repos = await request<Array<{ name: string }>>(`/code/repos?refresh=1&query=${name.toUpperCase()}`);
    expect(repos.status).toBe(200);
    expect(repos.body.map((repo) => repo.name)).toEqual([name]);
    const all = await request<Array<{ name: string }>>("/code/repos");
    expect(all.body.map((repo) => repo.name)).toContain(name);

    await addGrant(name, "push");
    const grants = await request<Array<{ repo: string; key: string }>>("/code/grants");
    expect(grants.status).toBe(200);
    expect(grants.body).toContainEqual(expect.objectContaining({ repo: name, key: "push" }));
    const removed = await request<{ ok: boolean }>("/code/grants", {
      method: "DELETE",
      body: { repo: name, key: "push" },
    });
    expect(removed.status).toBe(200);
    expect(removed.body.ok).toBe(true);
    const again = await request<{ error: string }>("/code/grants", { method: "DELETE", body: {} });
    expect(again.status).toBe(404);
    expect(again.body.error).toBe("Essa permissão não existe.");

    const worktrees = await request<Array<{ botId: string; status: string }>>("/code/worktrees");
    expect(worktrees.status).toBe(200);
    expect(worktrees.body).toContainEqual(expect.objectContaining({ botId: bot.id, status: "alive" }));
  });

  test("maps body and unexpected errors", async () => {
    const syntax = await request<{ error: string }>("/code/grants", { method: "DELETE", body: "{broken" });
    expect(syntax.status).toBe(400);
    expect(syntax.body.error).toBe("JSON inválido.");
    const array = await request<{ error: string }>("/code/grants", { method: "DELETE", body: "[1]" });
    expect(array.status).toBe(400);
    expect(array.body.error).toBe("Corpo inválido.");
    const unknown = await request<{ error: string }>("/code/other");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("Rota não encontrada.");
    spy(codeRepository, "listWorktrees").mockImplementation(() => Promise.reject(new Error("db locked")));
    const crash = await request<{ error: string }>("/code/worktrees");
    expect(crash.status).toBe(500);
    expect(crash.body.error).toBe("db locked");
    spy(codeRepository, "listGrants").mockImplementation(() => Promise.reject("plain failure"));
    const plain = await request<{ error: string }>("/code/grants");
    expect(plain.status).toBe(500);
    expect(plain.body.error).toBe("plain failure");
  });
});

describe("bot code state", () => {
  test("reports an empty state and resolves sessions", async () => {
    const empty = await request<Record<string, unknown>>(`/bots/${bot.id}/code`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ workspace: null, files: [], servers: [], checkpoints: [], running: false });
    const conversation = await createConversation(bot.id, {});
    const bySession = await request(`/bots/${bot.id}/code?sessionId=${conversation.meta.sessionId}`);
    expect(bySession.status).toBe(200);
    const other = await makeBot();
    const foreign = await createConversation(other.id, {});
    const hidden = await request<{ error: string }>(`/bots/${bot.id}/code?sessionId=${foreign.meta.sessionId}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error).toBe("Conversa não encontrada.");
    const missing = await request(`/bots/${bot.id}/code?sessionId=nothing`);
    expect(missing.status).toBe(404);
  });

  test("fails when the thread session vanished", async () => {
    spy(await import("../../conversations/services/threads.service"), "ensureThread").mockImplementation(() =>
      Promise.resolve({ sessionId: "gone", lastMessage: null, unread: 0, readAt: null }),
    );
    const response = await request<{ error: string }>(`/bots/${bot.id}/code`);
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Conversa não encontrada.");
  });

  test("routes that need a workspace report its absence", async () => {
    for (const [method, path] of [
      ["GET", "files"],
      ["GET", "diff"],
      ["POST", "revert"],
      ["POST", "deliver"],
      ["GET", "pr"],
      ["GET", "servers"],
      ["POST", "servers/stop"],
      ["POST", "finish"],
    ] as const) {
      const response = await request<{ error: string }>(`/bots/${bot.id}/code/${path}`, { method });
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      expect(response.body.error).toBe("Esta conversa não tem repositório aberto.");
    }
    const closed = await request<{ error: string }>(`/bots/${bot.id}/code/workspace`, { method: "DELETE" });
    expect(closed.status).toBe(404);
    const reopen = await request<{ error: string }>(`/bots/${bot.id}/code/pr/reopen`, { method: "POST" });
    expect(reopen.status).toBe(404);
    expect(reopen.body.error).toBe("Esta conversa não tem PR.");
    const unknown = await request<{ error: string }>(`/bots/${bot.id}/code/elsewhere`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("Rota não encontrada.");
  });
});

describe("workspace lifecycle", () => {
  test("opens, diffs, reverts, delivers and finishes", async () => {
    const { name, session, workspace } = await openRepo();
    const reopened = await request<{ created: boolean }>(`/bots/${bot.id}/code/workspace`, {
      method: "POST",
      body: { repo: name },
    });
    expect(reopened.status).toBe(200);
    expect(reopened.body.created).toBe(false);

    writeFileSync(join(workspace.path, "src/a.txt"), "a\nb\n");
    writeFileSync(join(workspace.path, "new.txt"), "novo\n");
    const files = await request<Array<{ path: string }>>(`/bots/${bot.id}/code/files?fresh=1`);
    expect(files.body.map((file) => file.path).sort()).toEqual(["new.txt", "src/a.txt"]);
    const state = await request<{ workspace: { files: number; added: number; removed: number }; files: unknown[] }>(
      `/bots/${bot.id}/code`,
    );
    expect(state.status).toBe(200);
    expect(state.body.workspace).toMatchObject({ files: 2, added: 2, removed: 0 });
    const one = await request<{ path: string }>(`/bots/${bot.id}/code/diff?path=src/a.txt`);
    expect(one.status).toBe(200);
    expect(one.body.path).toBe("src/a.txt");
    const all = await request<{ files: Array<{ path: string }>; patch: string }>(`/bots/${bot.id}/code/diff`);
    expect(all.body.files.map((file) => file.path).sort()).toEqual(["new.txt", "src/a.txt"]);
    expect(all.body.patch).toContain("+b");

    const reverted = await request<{ ok: boolean; path: string }>(`/bots/${bot.id}/code/revert`, {
      method: "POST",
      body: { path: "new.txt" },
    });
    expect(reverted.status).toBe(200);
    expect(reverted.body).toEqual({ ok: true, path: "new.txt" });
    expect(existsSync(join(workspace.path, "new.txt"))).toBe(false);
    expect((await factsOfType(session, "code.reverted")).at(-1)?.data).toMatchObject({ path: "new.txt", by: "user" });

    const badAction = await request<{ error: string }>(`/bots/${bot.id}/code/deliver`, {
      method: "POST",
      body: { action: "ship" },
    });
    expect(badAction.status).toBe(400);
    expect(badAction.body.error).toBe("action precisa ser commit, push ou pr.");
    const committed = await request<{ commit: string | null }>(`/bots/${bot.id}/code/deliver`, {
      method: "POST",
      body: { action: "commit", message: "feat(routes): add b", title: "t", body: "b" },
    });
    expect(committed.status).toBe(200);
    expect(committed.body.commit).toEqual(expect.any(String));
    expect(await factsOfType(session, "code.delivered")).toHaveLength(1);
    for (const action of ["push", "pr"]) {
      const response = await request<{ error: string }>(`/bots/${bot.id}/code/deliver`, {
        method: "POST",
        body: { action, message: "feat: x" },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(typeof response.body.error).toBe("string");
    }

    const pr = await request<{ pr: unknown }>(`/bots/${bot.id}/code/pr`);
    expect(pr.body).toEqual({ pr: null });
    const refreshed = await request<{ pr: unknown }>(`/bots/${bot.id}/code/pr?refresh=1`);
    expect(refreshed.body).toEqual({ pr: null });

    const servers = await request<unknown[]>(`/bots/${bot.id}/code/servers`);
    expect(servers.body).toEqual([]);
    const stopped = await request<{ ok: boolean; stopped: number[] }>(`/bots/${bot.id}/code/servers/stop`, {
      method: "POST",
      body: { port: 5999 },
    });
    expect(stopped.body).toEqual({ ok: true, stopped: [] });
    const stopSpy = spy(devServer, "stopDevServers").mockImplementation((() =>
      Promise.resolve([{ port: 5173 }, { port: 5174 }])) as never);
    const stoppedAll = await request<{ ok: boolean; stopped: number[] }>(`/bots/${bot.id}/code/servers/stop`, {
      method: "POST",
      body: { port: "x" },
    });
    expect(stoppedAll.body).toEqual({ ok: true, stopped: [5173, 5174] });
    expect(stopSpy.mock.calls.at(-1)?.[1]).toBeUndefined();
    stopSpy.mockRestore();

    const finished = await request<Record<string, unknown>>(`/bots/${bot.id}/code/finish`, { method: "POST" });
    expect(finished.status).toBe(200);
    expect(existsSync(workspace.path)).toBe(false);
    expect(activeWorkspace(session)).toBeNull();
  });

  test("closes the workspace and validates opening", async () => {
    const { workspace } = await openRepo();
    const missingRepo = await request<{ error: string }>(`/bots/${bot.id}/code/workspace`, {
      method: "POST",
      body: { repo: " " },
    });
    expect(missingRepo.status).toBe(400);
    expect(missingRepo.body.error).toBe("Diga qual repositório.");
    const closed = await request<{ ok: boolean; path: string; branch: string }>(`/bots/${bot.id}/code/workspace`, {
      method: "DELETE",
    });
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ ok: true, path: workspace.path, branch: workspace.branch });
  });

  test("defaults the task name from the repo", async () => {
    repoCount++;
    const name = `routes-default-${repoCount}`;
    await makeRepo(name);
    await listRepos(true);
    const opened = await request<{ workspace: { task: string } }>(`/bots/${bot.id}/code/workspace`, {
      method: "POST",
      body: { repo: name },
    });
    expect(opened.status).toBe(201);
    const workspace = activeWorkspace(await threadSession()) as workspaceService.WorkspaceState;
    expect(workspace.task).toBe(`${name} ${new Date().toISOString().slice(0, 10)}`);
    await waitForInstall(workspace);
  });

  test("refuses changes while the bot works", async () => {
    const { name, session } = await openRepo();
    const release = await hold(session);
    for (const [method, path, body] of [
      ["POST", "workspace", { repo: name }],
      ["DELETE", "workspace", undefined],
      ["POST", "deliver", { action: "commit", message: "feat: x" }],
      ["POST", "rewind", { turnId: "turn_0" }],
    ] as const) {
      const response = await request<{ error: string }>(`/bots/${bot.id}/code/${path}`, { method, body });
      expect({ path, method, status: response.status }).toEqual({ path, method, status: 409 });
      expect(response.body.error).toContain("O bot ainda está trabalhando");
    }
    const state = await request<{ running: boolean }>(`/bots/${bot.id}/code`);
    expect(state.body.running).toBe(true);
    await release();
  });

  test("keeps going when listing files fails", async () => {
    await openRepo();
    spy(workspaceService, "changedFiles").mockImplementation(() => Promise.reject(new Error("git died")));
    const state = await request<{ workspace: { files: number }; files: unknown[] }>(`/bots/${bot.id}/code`);
    expect(state.status).toBe(200);
    expect(state.body.workspace.files).toBe(0);
    expect(state.body.files).toEqual([]);
  });
});

describe("checkpoints and rewind", () => {
  test("labels checkpoints from the requests that made them", async () => {
    const { session, workspace } = await openRepo();
    const consumed = (turnId: string, data: Record<string, unknown>) =>
      session.log.emit({ type: "delivery.consumed", data, scope: { turnId } });
    consumed("turn_1", { parts: [{ text: "  arruma   o\nlayout " }] });
    consumed("turn_1", { parts: [{ text: "ignorado" }] });
    consumed("turn_2", { parts: [{ text: "x".repeat(200) }] });
    consumed("turn_3", { attachments: [{ kind: "audio", duration: 75 }] });
    consumed("turn_4", { attachments: [{ kind: "video" }, { kind: "file" }] });
    consumed("turn_5", { attachments: [{ kind: "image" }, { kind: "image" }] });
    consumed("turn_6", { attachments: [{ kind: "image" }] });
    consumed("turn_7", { attachments: [{ kind: "file", name: "plano.pdf" }, { kind: "file" }] });
    consumed("turn_8", { attachments: [{ kind: "file" }] });
    consumed("turn_9", { source: "delegate", parts: [{ text: "revisa" }] });
    consumed("turn_10", { from: { name: "Ana" }, parts: [{ text: "olha" }] });
    consumed("turn_11", { source: "delegate" });
    consumed("turn_12", { source: "schedule", scheduleId: "manha" });
    consumed("turn_13", { source: "schedule", parts: [{ text: "resumo" }] });
    consumed("turn_14", {});
    consumed("turn_15", { attachments: [{ kind: "video", duration: 5 }] });
    consumed("turn_16", { attachments: [{ kind: "audio" }, { kind: "audio" }] });
    session.log.emit({ type: "delivery.consumed", data: { parts: [{ text: "sem turno" }] } });
    const turns = Array.from({ length: 17 }, (_, index) => `turn_${index + 1}`);
    session.meta.checkpoints = [
      ...turns.map((turnId) => ({ turnId, ref: "r", commit: "c", workspaceId: workspace.id, at: "2026-01-01" })),
      { turnId: "turn_1", ref: "r", commit: "c", workspaceId: "other-workspace", at: "2026-01-01" },
    ];
    session.meta.revertedTurns = ["turn_17"];
    const state = await request<{ checkpoints: Array<{ turnId: string; request: string | null }> }>(
      `/bots/${bot.id}/code`,
    );
    const labels = Object.fromEntries(state.body.checkpoints.map((item) => [item.turnId, item.request]));
    expect(labels).toEqual({
      turn_1: "arruma o layout",
      turn_2: `${"x".repeat(139)}…`,
      turn_3: "Áudio de 1:15",
      turn_4: "Vídeo e mais 1",
      turn_5: "2 imagens",
      turn_6: "Imagem",
      turn_7: "plano.pdf e mais 1",
      turn_8: "Arquivo",
      turn_9: "Outro bot pediu: revisa",
      turn_10: "Ana pediu: olha",
      turn_11: null,
      turn_12: "Rotina: manha",
      turn_13: "Rotina: resumo",
      turn_14: null,
      turn_15: "Vídeo de 0:05",
      turn_16: "Áudio e mais 1",
    });
    session.meta.checkpoints = [];
    session.meta.revertedTurns = [];
    const plainSession = await createConversation(bot.id, {});
    plainSession.meta.checkpoints = [{ turnId: "turn_1", ref: "r", commit: "c", workspaceId: "w", at: "x" }];
    const noWorkspace = await request<{ checkpoints: unknown[] }>(
      `/bots/${bot.id}/code?sessionId=${plainSession.meta.sessionId}`,
    );
    expect(noWorkspace.body.checkpoints).toEqual([{ turnId: "turn_1", at: "x", workspaceId: "w", request: null }]);
  });

  test("rewinds files and turns to a checkpoint", async () => {
    const { session, workspace } = await openRepo();
    session.log.emit({ type: "turn.started", data: { turnId: "turn_0" }, scope: { turnId: "turn_0" } });
    await createCheckpoint(session, workspace, "turn_1");
    session.log.emit({ type: "turn.started", data: { turnId: "turn_1" } });
    writeFileSync(join(workspace.path, "src/a.txt"), "mudado\n");
    await createCheckpoint(session, workspace, "turn_2");
    writeFileSync(join(workspace.path, "extra.txt"), "extra\n");
    session.log.emit({ type: "content.completed", data: { value: "x" }, scope: { turnId: "turn_2" } });
    session.log.emit({ type: "content.completed", data: { turnId: 5 } });

    const invalid = await request<{ error: string }>(`/bots/${bot.id}/code/rewind`, {
      method: "POST",
      body: { turnId: "nope" },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("Turno inválido.");

    const rewound = await request<{
      turnId: string;
      turnIds: string[];
      filesRestored: boolean;
      restored: number;
      removed: number;
    }>(`/bots/${bot.id}/code/rewind`, { method: "POST", body: { turnId: "turn_1" } });
    expect(rewound.status).toBe(200);
    expect(rewound.body).toEqual({
      turnId: "turn_1",
      turnIds: ["turn_1", "turn_2"],
      filesRestored: true,
      restored: 2,
      removed: 1,
    });
    expect(existsSync(join(workspace.path, "extra.txt"))).toBe(false);
    expect(session.meta.revertedTurns).toEqual(["turn_1", "turn_2"]);
    expect(session.meta.providerSessions).toEqual({});
    expect((await factsOfType(session, "turn.reverted")).at(-1)?.data).toMatchObject({
      turnId: "turn_1",
      files: true,
      checkpoint: `refs/runelay/checkpoints/${session.meta.sessionId}/turn_1`,
    });

    const nothing = await request<Record<string, unknown>>(`/bots/${bot.id}/code/rewind`, {
      method: "POST",
      body: { turnId: "turn_1" },
    });
    expect(nothing.body).toEqual({ turnId: "turn_1", turnIds: [], filesRestored: false, restored: 0, removed: 0 });
    expect((await factsOfType(session, "turn.reverted")).at(-1)?.data.checkpoint).toBeUndefined();

    const conversation = await createConversation(bot.id, {});
    const plain = await request<{ filesRestored: boolean }>(
      `/bots/${bot.id}/code/rewind?sessionId=${conversation.meta.sessionId}`,
      { method: "POST", body: {} },
    );
    expect(plain.status).toBe(400);
  });
});

describe("preview proxy", () => {
  function upstream(handler: (request: Request) => Response | Promise<Response>) {
    const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    upstreams.push(target);
    return Number(target.port);
  }

  test("issues the cookie and proxies requests", async () => {
    const seen: Array<{ method: string; path: string; body: string; host: string | null }> = [];
    const port = upstream(async (incoming) => {
      const url = new URL(incoming.url);
      seen.push({
        method: incoming.method,
        path: url.pathname,
        body: await incoming.text(),
        host: incoming.headers.get("host"),
      });
      return new Response(`page ${url.pathname}`, { headers: { "x-upstream": "yes" } });
    });
    const token = "tok-preview-1";
    spy(devServer, "previewTarget").mockImplementation(((workspaceId: string, asked: number) =>
      workspaceId === "ws1" && asked === port ? { port, token } : null) as never);
    spy(devServer, "findPreviewByToken").mockImplementation(((value: string) =>
      value === token ? { port, workspaceId: "ws1", token } : null) as never);

    const redirect = await request(`/preview/ws1/${port}/app/index.html?t=${token}`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/app/index.html");
    expect(redirect.headers.get("set-cookie")).toContain(`rb_preview=${token}`);

    const denied = await request<{ error: string }>(`/preview/ws1/${port}?t=wrong`);
    expect(denied.status).toBe(403);
    const noPort = await request(`/preview/ws1/abc?t=${token}`);
    expect(noPort.status).toBe(403);
    const noWorkspace = await request("/preview");
    expect(noWorkspace.status).toBe(403);

    const page = await request(`/assets/app.js?v=1`, { headers: { cookie: `other=1; rb_preview=${token}` } });
    expect(page.status).toBe(200);
    expect(page.text).toBe("page /assets/app.js");
    expect(page.headers.get("x-upstream")).toBe("yes");
    const posted = await request("/form", { method: "POST", headers: { cookie: `rb_preview=${token}` }, body: "a=1" });
    expect(posted.status).toBe(200);
    expect(seen).toEqual([
      { method: "GET", path: "/assets/app.js", body: "", host: `localhost:${port}` },
      { method: "POST", path: "/form", body: "a=1", host: `localhost:${port}` },
    ]);

    const api = await request<{ error: string }>("/code/other", { headers: { cookie: `rb_preview=${token}` } });
    expect(api.status).toBe(404);
    const stranger = await request("/assets/app.js", { headers: { cookie: "rb_preview=unknown" } });
    expect(stranger.status).toBe(404);
    const bare = await request("/assets/app.js");
    expect(bare.status).toBe(404);
  });

  test("reports an upstream that is down", async () => {
    const port = upstream(() => new Response("x"));
    upstreams.pop()?.stop(true);
    spy(devServer, "findPreviewByToken").mockImplementation((() => ({ port, workspaceId: "ws", token: "t" })) as never);
    const response = await request<{ error: string }>("/page", { headers: { cookie: "rb_preview=t" } });
    expect(response.status).toBe(502);
    expect(response.body.error).toContain("O servidor de desenvolvimento não respondeu");
  });

  test("classifies preview traffic and upgrade targets", () => {
    spy(devServer, "findPreviewByToken").mockImplementation(((value: string) =>
      value === "good" ? { port: 4321, workspaceId: "ws", token: "good" } : null) as never);
    const at = (path: string, headers: Record<string, string> = {}) =>
      new Request(`http://127.0.0.1${path}`, { headers });
    expect(isPreviewTraffic(at("/preview/x/1"))).toBe(true);
    expect(isPreviewTraffic(at("/bots", { cookie: "rb_preview=good" }))).toBe(false);
    expect(isPreviewTraffic(at("/app", { cookie: "rb_preview=good" }))).toBe(true);
    expect(isPreviewTraffic(at("/app", { cookie: "rb_preview=bad" }))).toBe(false);
    expect(isPreviewTraffic(at("/"))).toBe(false);

    expect(previewUpgradeTarget(new Req(at("/bots/x", { cookie: "rb_preview=good" })))).toBeNull();
    expect(previewUpgradeTarget(new Req(at("/hmr")))).toBeNull();
    expect(
      previewUpgradeTarget(
        new Req(at("/hmr?x=1", { cookie: "rb_preview=good", "sec-websocket-protocol": "vite-hmr, , other" })),
      ),
    ).toEqual({ port: 4321, path: "/hmr?x=1", protocols: ["vite-hmr", "other"] });
    expect(previewUpgradeTarget(new Req(at("/", { cookie: "rb_preview=good" })))).toEqual({
      port: 4321,
      path: "/",
      protocols: [],
    });
  });
});

describe("preview socket relay", () => {
  function wsUpstream() {
    const received: string[] = [];
    const protocols: Array<string | null> = [];
    const sockets = new Set<import("bun").ServerWebSocket<unknown>>();
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(incoming, srv) {
        protocols.push(incoming.headers.get("sec-websocket-protocol"));
        const protocol = incoming.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
        return srv.upgrade(incoming, protocol ? { headers: { "Sec-WebSocket-Protocol": protocol } } : {})
          ? undefined
          : new Response("no", { status: 400 });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
        },
        message(ws, message) {
          received.push(String(message));
          ws.send(typeof message === "string" ? `echo:${message}` : message);
        },
        close(ws) {
          sockets.delete(ws);
        },
      },
    });
    upstreams.push(target);
    return { port: Number(target.port), received, protocols, sockets };
  }

  function fakeClient(data: Record<string, unknown>) {
    const sent: Array<string | Uint8Array> = [];
    let closed = 0;
    let onSend: () => void = () => undefined;
    let onClose: () => void = () => undefined;
    const client = {
      data: { kind: "preview", ...data },
      readyState: 1,
      send(message: string | Uint8Array) {
        sent.push(message);
        onSend();
      },
      close() {
        closed++;
        onClose();
      },
    } as unknown as Socket & { readyState: number };
    return {
      client,
      sent,
      closedCount: () => closed,
      nextSend: () =>
        new Promise<void>((resolve) => {
          onSend = resolve;
        }),
      nextClose: () =>
        new Promise<void>((resolve) => {
          onClose = resolve;
        }),
    };
  }

  test("queues until open, relays both ways and closes upstream", async () => {
    const { port, received, protocols, sockets } = wsUpstream();
    const fake = fakeClient({ port, path: "/hmr", protocols: ["vite-hmr"] });
    previewSocket.open(fake.client);
    const echoed = fake.nextSend();
    previewSocket.message(fake.client, "early");
    await echoed;
    expect(received).toEqual(["early"]);
    expect(fake.sent).toEqual(["echo:early"]);
    expect(protocols).toEqual(["vite-hmr"]);

    const binary = fake.nextSend();
    previewSocket.message(fake.client, Buffer.from([1, 2, 3]));
    await binary;
    expect(fake.sent[1]).toBeInstanceOf(Uint8Array);
    expect([...(fake.sent[1] as Uint8Array)]).toEqual([1, 2, 3]);

    fake.client.readyState = 3;
    previewSocket.message(fake.client, "after-close");
    await waitFor(() => received.includes("after-close"));
    const upstreamClosed = fake.nextClose();
    for (const socket of sockets) {
      socket.send("server push");
      socket.close();
    }
    await upstreamClosed;
    expect(fake.sent).toHaveLength(2);
    previewSocket.close(fake.client, 1000, "");
    previewSocket.message(fake.client, "ignored");
    expect(received).not.toContain("ignored");

    const second = fakeClient({ port, path: "/hmr", protocols: [] });
    previewSocket.open(second.client);
    await waitFor(() => sockets.size === 1);
    previewSocket.close(second.client, 1000, "");
    await waitFor(() => sockets.size === 0);
  });

  test("closes the client when the upstream closes or fails", async () => {
    const { port, sockets } = wsUpstream();
    const fake = fakeClient({ port, path: "/", protocols: undefined });
    const closed = fake.nextClose();
    previewSocket.open(fake.client);
    await waitFor(() => sockets.size === 1);
    for (const socket of sockets) socket.close();
    await closed;
    expect(fake.closedCount()).toBeGreaterThanOrEqual(1);

    const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const deadPort = Number(dead.port);
    await dead.stop(true);
    const failing = fakeClient({ port: deadPort, path: "/", protocols: [] });
    const failed = failing.nextClose();
    previewSocket.open(failing.client);
    await failed;
    expect(failing.closedCount()).toBeGreaterThanOrEqual(1);
    previewSocket.close(failing.client, 1006, "");
  });
});
