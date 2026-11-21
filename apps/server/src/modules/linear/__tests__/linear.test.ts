import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { fakeRunelay, request, startTestServer, type TestServer } from "../../../../test/helpers";
import { Req, Res } from "../../../shared/http";
import { listConnections } from "../../connectors/services/runelay.service";
import { type GhOutput, setGhRunner } from "../../github/services/gh-client.service";
import { clearGitHubCache } from "../../github/services/github.service";
import { handleLinear } from "../routes/linear.routes";
import {
  cardOf,
  cleanDescription,
  clearLinearCache,
  linearTool,
  projectOf,
  sortStates,
  stageWeight,
  startedState,
  targetState,
} from "../services/linear.service";

type Handler = (args: Record<string, unknown>) => unknown;

const tools = new Map<string, Handler>();
const saved: Array<Record<string, unknown>> = [];
let ghReply: () => GhOutput = () => ({
  code: 0,
  stdout: JSON.stringify({ data: { list: { nodes: [] } } }),
  stderr: "",
});

const states = [
  { id: "s-done", type: "completed", name: "Concluído" },
  { id: "s-review", type: "started", name: "Em review" },
  { id: "s-todo", type: "unstarted", name: "A fazer" },
  { id: "s-progress", type: "started", name: "Em progresso" },
  { id: "s-cancel", type: "canceled", name: "Reprovado" },
  { id: "s-backlog", type: "backlog", name: "Backlog" },
];

function issue(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    uuid: `${id}-uuid`,
    title: `Issue ${id}`,
    priority: { value: 2, name: "High" },
    estimate: 3,
    url: `https://linear.app/x/issue/${id}`,
    gitBranchName: `me/${id.toLowerCase()}-x`,
    updatedAt: "2026-11-20T10:00:00Z",
    status: "Em progresso",
    statusType: "started",
    labels: ["Produto"],
    assignee: "Ana",
    teamId: "team-1",
    team: "Acme",
    parentId: null,
    project: null,
    ...extra,
  };
}

function register() {
  tools.set("linear_server.list_teams", () => ({
    teams: [{ id: "team-1", key: "ENG", name: "Acme" }, { name: "sem id" }],
    hasNextPage: false,
  }));
  tools.set("linear_server.list_custom_views", (args) =>
    args.cursor
      ? { customViews: [{ id: "v2", name: "Suporte", team: null }], hasNextPage: false }
      : {
          customViews: [
            { id: "v1", name: "Produto", description: "Kanban", team: { id: "team-1", key: "CTY" }, url: "u" },
            {},
          ],
          hasNextPage: true,
          cursor: "c1",
        },
  );
  tools.set("linear_server.list_issue_statuses", () => states);
  tools.set("linear_server.list_issues", (args) => {
    if (args.parentId) return { issues: [issue("ENG-3", { status: "A fazer", statusType: "unstarted" })] };
    if (args.state === "started") return { issues: [{ id: "ENG-1" }], hasNextPage: true };
    return {
      issues: [
        issue("ENG-1"),
        issue("ENG-2", {
          status: "Triagem",
          statusType: "triage",
          assignee: null,
          teamId: null,
          labels: [{ name: "Bug" }],
        }),
      ],
      hasNextPage: !args.cursor,
      cursor: "next",
    };
  });
  tools.set("linear_server.get_issue", (args) => {
    if (args.id === "ENG-404") return {};
    if (args.id === "ENG-8") return issue("ENG-8", { teamId: null });
    return {
      ...issue(String(args.id), { assigneeId: args.id === "ENG-1" ? "u1" : null }),
      description:
        'Veja <pull-request id="1" label="acme/api#7" href="https://github.com/acme/api/pull/7" /> <issue-mention x="1" />',
      createdBy: "Ana",
      attachments: [{ title: "PR #7", url: "https://github.com/acme/api/pull/7" }, { title: "sem url" }],
    };
  });
  tools.set("linear_server.list_comments", () => ({
    comments: [
      { id: "c2", body: "segundo", createdAt: "2026-11-20T12:00:00Z", author: { name: "Bia" } },
      { id: "c1", body: "primeiro", createdAt: "2026-11-20T11:00:00Z", author: null, quotedText: "trecho" },
    ],
  }));
  tools.set("linear_server.save_issue", (args) => {
    saved.push(args);
    return { ok: true };
  });
  fakeRunelay.tool("list_connections", () => [{ name: "linear_server", status: "ok", toolCount: 30 }]);
  fakeRunelay.tool("call_tool", (args) => {
    const handler = tools.get(String(args.name));
    if (!handler) throw new Error(`unknown tool ${String(args.name)}`);
    return handler((args.args ?? {}) as Record<string, unknown>);
  });
}

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
  setGhRunner(async () => ghReply());
});

afterAll(async () => {
  setGhRunner(null);
  await server.close();
});

beforeEach(async () => {
  tools.clear();
  saved.length = 0;
  clearLinearCache();
  clearGitHubCache();
  register();
  await listConnections(true);
});

afterEach(() => {
  ghReply = () => ({ code: 0, stdout: JSON.stringify({ data: { list: { nodes: [] } } }), stderr: "" });
});

describe("helpers", () => {
  test("orders workflow states and picks the started one", () => {
    expect(sortStates(states).map((state) => state.name)).toEqual([
      "Backlog",
      "A fazer",
      "Em progresso",
      "Em review",
      "Concluído",
      "Reprovado",
    ]);
    expect(stageWeight("Correção de review")).toBe(2);
    expect(stageWeight("Em teste")).toBe(3);
    expect(stageWeight("Aguardando deploy")).toBe(4);
    expect(stageWeight("Aguardando")).toBe(5);
    expect(stageWeight("Outro")).toBe(2.5);
    expect(
      sortStates([
        { name: "x", type: "weird" },
        { name: "y", type: "triage" },
      ]).map((s) => s.name),
    ).toEqual(["y", "x"]);
    expect(startedState(states)?.id).toBe("s-progress");
    expect(startedState([])).toBeNull();
    expect(targetState(states, "started:Em review")?.id).toBe("s-review");
    expect(targetState(states, "s-done")?.id).toBe("s-done");
    expect(targetState(states, "em review")?.id).toBe("s-review");
    expect(targetState(states, "started:Nada")).toBeNull();
  });

  test("cleans Linear tags and builds cards", () => {
    expect(cleanDescription('a <pull-request href="h" label="L" /> b <x-y z="1" />')).toBe("a [L](h) b");
    expect(cleanDescription('<pull-request label="L" href="h" />')).toBe("[L](h)");
    expect(
      cleanDescription(
        'x <linear-image>{"type":"image","attrs":{"src":"https://uploads.linear.app/a/b?signature=s","title":"print.png"}}</linear-image> y',
      ),
    ).toBe("x \n\n![print.png](https://uploads.linear.app/a/b?signature=s)\n\n y");
    expect(cleanDescription('<linear-mention>{"attrs":{"label":"Ana"}}</linear-mention>')).toBe("Ana");
    expect(cleanDescription("<linear-x>{broken</linear-x>ok")).toBe("ok");
    const card = cardOf({ id: "ENG-5", priority: 4, labels: ["a", 1], assignee: { name: "Ana" } }, new Map());
    expect(card).toMatchObject({
      priority: 4,
      priorityName: "Sem prioridade",
      labels: ["a"],
      assignee: "Ana",
      column: "backlog:",
    });
  });
});

describe("routes", () => {
  test("lists my views, teams and saved views", async () => {
    const reply = await request<{ views: Array<{ id: string; kind: string }> }>("/linear/views");
    expect(reply.status).toBe(200);
    expect(reply.body.views.map((view) => view.id)).toEqual(["mine", "team:team-1", "view:v1", "view:v2"]);
  });

  test("builds a board with ordered columns and linked pulls", async () => {
    ghReply = () => ({
      code: 0,
      stdout: JSON.stringify({
        data: {
          list: {
            nodes: [
              {
                number: 7,
                title: "feat",
                url: "u",
                headRefName: "me/eng-1-x",
                state: "OPEN",
                repository: { nameWithOwner: "acme/api" },
              },
            ],
          },
        },
      }),
      stderr: "",
    });
    const reply = await request<{
      columns: Array<{ key: string; count: number }>;
      issues: Array<{ id: string; pr: unknown; column: string; labels: string[] }>;
      nextCursor: string | null;
      searchable: boolean;
    }>("/linear/board?view=team:team-1");
    expect(reply.status).toBe(200);
    expect(reply.body.columns.map((column) => `${column.key}=${column.count}`)).toEqual([
      "triage:Triagem=1",
      "backlog:Backlog=0",
      "unstarted:A fazer=0",
      "started:Em progresso=1",
      "started:Em review=0",
      "completed:Concluído=0",
    ]);
    expect(reply.body.issues[0].pr).toMatchObject({ repo: "acme/api", number: 7 });
    expect(reply.body.issues[1]).toMatchObject({ pr: null, labels: ["Bug"] });
    expect(reply.body.nextCursor).toBe("next");
    expect(reply.body.searchable).toBe(true);
    const mine = await request<{ view: { kind: string } }>("/linear/board?q=board&cursor=next");
    expect(mine.body.view.kind).toBe("mine");
    const call = fakeRunelay.toolCalls.filter((item) => item.name === "call_tool").at(-1);
    expect(call?.args.args).toMatchObject({ assignee: "me", query: "board", cursor: "next" });
  });

  test("handles saved views and unknown views", async () => {
    const view = await request<{ searchable: boolean; columns: Array<{ count: number }> }>(
      "/linear/board?view=view:v1",
    );
    expect(view.body.searchable).toBe(false);
    expect(view.body.columns.some((column) => column.count === 0)).toBe(true);
    expect((await request("/linear/board?view=view:v1&q=x")).status).toBe(400);
    const loose = await request<{ view: { name: string } }>("/linear/board?view=view:zzz");
    expect(loose.body.view.name).toBe("Visão");
    const team = await request<{ view: { name: string } }>("/linear/board?view=team:other");
    expect(team.body.view.name).toBe("Time");
    expect((await request("/linear/board?view=bad id")).status).toBe(400);
  });

  test("keeps every saved view issue on screen without empty columns of absent state types", async () => {
    tools.set("linear_server.list_issues", () => ({
      issues: [
        issue("ENG-1"),
        issue("ENG-2", { status: "Concluído", statusType: "completed" }),
        issue("ENG-3", { status: "Em teste", statusType: "started" }),
      ],
      hasNextPage: true,
      cursor: "next",
    }));
    const reply = await request<{
      columns: Array<{ key: string; count: number }>;
      issues: Array<{ column: string }>;
    }>("/linear/board?view=view:v1");
    expect(reply.body.columns.map((column) => `${column.key}=${column.count}`)).toEqual([
      "started:Em progresso=1",
      "started:Em review=0",
      "started:Em teste=1",
      "completed:Concluído=1",
    ]);
    const keys = new Set(reply.body.columns.map((column) => column.key));
    expect(reply.body.issues.every((item) => keys.has(item.column))).toBe(true);
  });

  test("returns the summary of started issues", async () => {
    const reply = await request("/linear/summary");
    expect(reply.body).toEqual({ started: 1, more: true });
  });

  test("returns the issue detail with comments, children and pull", async () => {
    const reply = await request<{ issue: Record<string, unknown> }>("/linear/issues/ENG-1");
    expect(reply.status).toBe(200);
    expect(reply.body.issue).toMatchObject({
      id: "ENG-1",
      description: "Veja [acme/api#7](https://github.com/acme/api/pull/7)",
      createdBy: "Ana",
      pr: null,
    });
    expect(
      (reply.body.issue.comments as Array<{ id: string; author: string }>).map((c) => `${c.id}:${c.author}`),
    ).toEqual(["c1:Alguém", "c2:Bia"]);
    expect((reply.body.issue.children as unknown[]).length).toBe(1);
    expect((reply.body.issue.attachments as unknown[]).length).toBe(1);
    expect((reply.body.issue.states as unknown[]).length).toBe(6);
    expect((await request("/linear/issues/ENG-404")).status).toBe(404);
    expect((await request("/linear/issues/not an id")).status).toBe(400);
  });

  test("moves, assigns and starts issues", async () => {
    const moved = await request("/linear/issues/ENG-1/state", {
      method: "POST",
      body: { column: "started:Em review" },
    });
    expect(moved.body).toEqual({ id: "ENG-1", state: "Em review", stateType: "started", column: "started:Em review" });
    expect(saved.at(-1)).toEqual({ id: "ENG-1", state: "s-review" });
    expect((await request("/linear/issues/ENG-1/state", { method: "POST", body: { column: "x:Nada" } })).status).toBe(
      400,
    );
    expect((await request("/linear/issues/ENG-1/state", { method: "POST", body: {} })).status).toBe(400);
    expect((await request("/linear/issues/ENG-8/state", { method: "POST", body: { column: "a" } })).status).toBe(422);
    expect((await request("/linear/issues/ENG-1/assign", { method: "POST" })).body).toEqual({
      id: "ENG-1",
      assigned: true,
    });
    expect(saved.at(-1)).toEqual({ id: "ENG-1", assignee: "me" });
    const started = await request("/linear/issues/ENG-2/start", { method: "POST" });
    expect(started.body).toMatchObject({ state: "Em progresso", branch: "me/eng-2-x" });
    expect(saved.at(-1)).toEqual({ id: "ENG-2", state: "s-progress", assignee: "me" });
    await request("/linear/issues/ENG-1/start", { method: "POST" });
    expect(saved.at(-1)).toEqual({ id: "ENG-1", state: "s-progress" });
    expect((await request("/linear/issues/ENG-8/start", { method: "POST" })).status).toBe(422);
    tools.set("linear_server.list_issue_statuses", () => ({
      statuses: [{ id: "b", name: "Backlog", type: "backlog" }],
    }));
    clearLinearCache();
    expect((await request("/linear/issues/ENG-1/start", { method: "POST" })).status).toBe(422);
    expect((await request("/linear/issues/ENG-1/other", { method: "POST" })).status).toBe(404);
    expect((await request("/linear/issues/ENG-1/assign", { method: "POST", body: [1] })).status).toBe(400);
    expect((await request("/linear/nothing")).status).toBe(404);
  });

  test("explains when Linear is missing or broken", async () => {
    fakeRunelay.tool("list_connections", () => [{ name: "github", status: "ok" }]);
    await listConnections(true);
    clearLinearCache();
    const missing = await request<{ error: string }>("/linear/views");
    expect(missing.status).toBe(503);
    expect(missing.body.error).toBe("Conecte o Linear em Conectores para ver suas issues aqui.");
    fakeRunelay.tool("list_connections", () => [{ name: "linear_server", status: "needs_auth" }]);
    await listConnections(true);
    clearLinearCache();
    expect((await request("/linear/views")).status).toBe(503);
    fakeRunelay.tool("list_connections", () => [{ name: "linear_server", status: "ok" }]);
    await listConnections(true);
    clearLinearCache();
    tools.set("linear_server.list_teams", () => {
      throw new Error("rate limited");
    });
    const broken = await request<{ error: string }>("/linear/views");
    expect(broken.status).toBe(502);
    expect(broken.body.error).toContain("rate limited");
    tools.set("linear_server.get_issue", () => {
      throw new Error("Entity not found");
    });
    expect((await request("/linear/issues/ENG-1/assign", { method: "POST" })).status).toBe(200);
    expect((await request("/linear/issues/ENG-1/start", { method: "POST" })).status).toBe(404);
  });

  test("lists open projects, labels and active users", async () => {
    tools.set("linear_server.list_projects", (args) =>
      args.cursor
        ? {
            projects: [{ id: "p3", name: "Fechado", status: { name: "Done", type: "completed" } }],
            hasNextPage: false,
          }
        : {
            projects: [
              {
                uuid: "p1",
                name: "Checkout",
                icon: "Cart",
                color: "#f00",
                url: "https://linear.app/p/p1",
                summary: "Novo checkout",
                status: { name: "Em andamento", type: "started" },
              },
              { id: "p2" },
              { name: "sem id" },
              { id: "p4", status: { type: "canceled" } },
            ],
            hasNextPage: true,
            cursor: "pc",
          },
    );
    tools.set("linear_server.list_issue_labels", () => ({
      labels: [
        { id: "l2", name: "bug", color: "#f00" },
        { id: "l1", name: "Area" },
        { id: "l3", name: "Bug" },
        { id: "l4", name: "Velha", retiredAt: "2026-01-01" },
        { id: "l5" },
      ],
    }));
    tools.set("linear_server.list_users", () => ({
      users: [
        { id: "u1", name: "Ana", displayName: "ana", email: "ana@x.dev", avatarUrl: "https://a/u1.png" },
        { id: "u2", displayName: "bia" },
        { id: "u3", name: "Ex", isActive: false },
        { name: "sem id" },
      ],
    }));
    const projects = await request<{ projects: Array<Record<string, unknown>> }>("/linear/projects?refresh=1");
    expect(projects.status).toBe(200);
    expect(projects.body.projects).toEqual([
      {
        id: "p1",
        name: "Checkout",
        icon: "Cart",
        color: "#f00",
        url: "https://linear.app/p/p1",
        summary: "Novo checkout",
        state: "Em andamento",
        stateType: "started",
      },
      {
        id: "p2",
        name: "Projeto",
        icon: null,
        color: null,
        url: null,
        summary: null,
        state: null,
        stateType: null,
      },
    ]);
    const projectCall = fakeRunelay.toolCalls.filter((item) => item.name === "call_tool").at(-1);
    expect(projectCall?.args.args).toEqual({ limit: 50, cursor: "pc" });
    const labels = await request<{ labels: unknown[] }>("/linear/labels");
    expect(labels.body.labels).toEqual([
      { id: "l1", name: "Area", color: null },
      { id: "l2", name: "bug", color: "#f00" },
    ]);
    const users = await request<{ users: unknown[] }>("/linear/users");
    expect(users.body.users).toEqual([
      { id: "u1", name: "Ana", displayName: "ana", email: "ana@x.dev", avatarUrl: "https://a/u1.png" },
      { id: "u2", name: "bia", displayName: "bia", email: null, avatarUrl: null },
    ]);
    const views = await request<{ views: Array<Record<string, unknown>> }>("/linear/views");
    expect(views.body.views.at(-1)).toEqual({
      id: "project:p2",
      name: "Projeto",
      kind: "project",
      description: null,
      team: null,
      url: null,
      icon: null,
      color: null,
    });
    expect(views.body.views.find((view) => view.id === "project:p1")).toMatchObject({
      description: "Novo checkout",
      icon: "Cart",
    });
  });

  test("filters the board by project and label", async () => {
    tools.set("linear_server.list_projects", () => ({ projects: [{ id: "p1", name: "Checkout" }] }));
    const project = await request<{ view: { kind: string; name: string }; project: string | null }>(
      "/linear/board?view=project:p1&project=Outro",
    );
    expect(project.status).toBe(200);
    expect(project.body.view).toMatchObject({ kind: "project", name: "Checkout" });
    expect(project.body.project).toBeNull();
    const projectArgs = fakeRunelay.toolCalls.filter((item) => item.args.name === "linear_server.list_issues").at(-1)
      ?.args.args;
    expect(projectArgs).toMatchObject({ project: "p1" });
    const loose = await request<{ view: { name: string } }>("/linear/board?view=project:zzz");
    expect(loose.body.view.name).toBe("Projeto");
    const filtered = await request<{ label: string; project: string }>(
      "/linear/board?view=team:team-1&label=Bug&project=Checkout",
    );
    expect(filtered.body).toMatchObject({ label: "Bug", project: "Checkout" });
    const args = fakeRunelay.toolCalls.filter((item) => item.args.name === "linear_server.list_issues").at(-1)
      ?.args.args;
    expect(args).toMatchObject({ team: "team-1", label: "Bug", project: "Checkout" });
    const bad = await request<{ field: string }>("/linear/board?label=%3Cscript%3E");
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe("label");
  });

  test("exposes raw tool calls and project parsing", async () => {
    expect(await linearTool("list_issues", { parentId: "ENG-1" })).toMatchObject({
      issues: [{ id: "ENG-3" }],
    });
    expect(projectOf({})).toBeNull();
    expect(projectOf({ id: "p9", status: "x" })).toMatchObject({ id: "p9", state: null });
  });

  test("answers 502 when the request body breaks mid-read", async () => {
    for (const reason of [new Error("client aborted"), "socket hang up"]) {
      const body = new ReadableStream({
        start(controller) {
          controller.error(reason);
        },
      });
      const controller = new AbortController();
      const req = new Req(
        new Request("http://x.local/linear/issues/ENG-1/assign", { method: "POST", body, duplex: "half" }),
      );
      const res = new Res(controller.signal);
      await handleLinear(req, res, new URL(`http://x.local${req.url}`), "POST", [
        "linear",
        "issues",
        "ENG-1",
        "assign",
      ]);
      const response = await res.response;
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ ok: false, error: reason instanceof Error ? reason.message : reason });
      expect(saved).toEqual([]);
    }
  });

  test("still shows the board and the issue when GitHub and the team states fail", async () => {
    ghReply = () => ({ code: 1, stdout: "", stderr: "gh: auth required" });
    tools.set("linear_server.list_issue_statuses", () => {
      throw new Error("statuses down");
    });
    const reply = await request<{
      columns: Array<{ key: string; count: number }>;
      issues: Array<{ pr: unknown }>;
    }>("/linear/board?view=team:team-1");
    expect(reply.status).toBe(200);
    expect(reply.body.columns.map((column) => `${column.key}=${column.count}`)).toEqual([
      "triage:Triagem=1",
      "started:Em progresso=1",
    ]);
    expect(reply.body.issues.map((item) => item.pr)).toEqual([null, null]);
    const detail = await request<{ issue: { states: unknown[]; pr: unknown } }>("/linear/issues/ENG-1");
    expect(detail.status).toBe(200);
    expect(detail.body.issue).toMatchObject({ states: [], pr: null });
  });

  test("treats a failing connection list as Linear not connected", async () => {
    clearLinearCache();
    fakeRunelay.tool("list_connections", () => {
      throw new Error("runelay down");
    });
    setSystemTime(new Date(Date.now() + 120_000));
    try {
      const reply = await request<{ error: string }>("/linear/summary");
      expect(reply.status).toBe(503);
      expect(reply.body.error).toBe("Conecte o Linear em Conectores para ver suas issues aqui.");
    } finally {
      setSystemTime();
    }
  });
});
