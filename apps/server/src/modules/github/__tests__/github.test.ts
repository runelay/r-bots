import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { request, startTestServer, type TestServer } from "../../../../test/helpers";
import { type GhOutput, GitHubError, graphql, rest, setGhRunner } from "../services/gh-client.service";
import {
  checkOf,
  ciOf,
  cleanText,
  clearGitHubCache,
  detailOf,
  linearKeyOf,
  linkForIssue,
  parseFilter,
  parseRepo,
  pullsByLinearKey,
  reviewOf,
  searchQuery,
  summaryOf,
} from "../services/github.service";

interface Call {
  args: string[];
  query: string;
  variables: Record<string, unknown>;
}

const calls: Call[] = [];
let handler: (call: Call) => GhOutput = () => ok({});

function ok(data: unknown): GhOutput {
  return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
}

function install() {
  setGhRunner(async (args, stdin) => {
    const parsed = stdin ? (JSON.parse(stdin) as { query: string; variables: Record<string, unknown> }) : null;
    const call = { args, query: parsed?.query ?? "", variables: parsed?.variables ?? {} };
    calls.push(call);
    return handler(call);
  });
}

const rawPull = {
  id: "PR_1",
  number: 7,
  title: "feat: add board CTY-12",
  url: "https://github.com/acme/api/pull/7",
  isDraft: false,
  state: "OPEN",
  updatedAt: "2026-11-20T10:00:00Z",
  mergedAt: null,
  headRefName: "anderson/cty-12-board",
  baseRefName: "main",
  additions: 10,
  deletions: 2,
  mergeable: "MERGEABLE",
  reviewDecision: "REVIEW_REQUIRED",
  author: { login: "ana", avatarUrl: "https://a/ana.png" },
  repository: { nameWithOwner: "acme/api", owner: { login: "acme", avatarUrl: "https://a/acme.png" } },
  comments: { totalCount: 3 },
  labels: { nodes: [{ name: "bug", color: "ff0000" }, {}] },
  last: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
};

function detailRepo(overrides: Record<string, unknown> = {}) {
  return {
    repository: {
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: false,
      deleteBranchOnMerge: false,
      viewerDefaultMergeMethod: "SQUASH",
      pullRequest: {
        ...rawPull,
        body: "Closes CTY-12",
        headRefOid: "abc123",
        isCrossRepository: false,
        mergeStateStatus: "CLEAN",
        viewerDidAuthor: true,
        last: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: "FAILURE",
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "test",
                        status: "COMPLETED",
                        conclusion: "FAILURE",
                        detailsUrl: "https://ci/1",
                        checkSuite: { workflowRun: { databaseId: 99, workflow: { name: "CI" } } },
                      },
                      { __typename: "StatusContext", context: "vercel", state: "SUCCESS", targetUrl: "https://v" },
                    ],
                  },
                },
              },
            },
          ],
        },
        files: { totalCount: 1, nodes: [{ path: "src/a.ts", additions: 3, deletions: 1, changeType: "MODIFIED" }] },
        reviews: {
          nodes: [
            { id: "R1", author: { login: "bia" }, state: "APPROVED", body: "ok", submittedAt: "2026-11-20T11:00:00Z" },
            { id: "R2", author: { login: "me" }, state: "PENDING", body: "" },
          ],
        },
        reviewThreads: {
          nodes: [
            {
              id: "T1",
              isResolved: false,
              isOutdated: false,
              path: "src/a.ts",
              line: null,
              originalLine: 4,
              comments: { nodes: [{ id: "C1", author: { login: "bia" }, body: "why?", createdAt: "2026-11-20" }] },
            },
          ],
        },
        issueComments: { nodes: [{ id: "IC1", author: null, body: "hi", createdAt: "2026-11-20", url: "u" }] },
        history: {
          totalCount: 2,
          nodes: [
            {
              commit: {
                oid: "1",
                abbreviatedOid: "1",
                messageHeadline: "first",
                committedDate: "d",
                author: { name: "Ana", user: null },
              },
            },
            {
              commit: {
                oid: "2",
                abbreviatedOid: "2",
                messageHeadline: "second",
                url: "c",
                author: { name: "Ana", user: { login: "ana" } },
              },
            },
          ],
        },
        ...overrides,
      },
    },
  };
}

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
  install();
});

afterAll(async () => {
  setGhRunner(null);
  await server.close();
});

afterEach(() => {
  calls.length = 0;
  clearGitHubCache();
  handler = () => ok({});
});

describe("pure helpers", () => {
  test("finds the Linear key in branch, title or body", () => {
    expect(linearKeyOf("anderson/cty-1319-redesign", "x")).toBe("CTY-1319");
    expect(linearKeyOf("feat/thing", "MAN-12: fix")).toBe("MAN-12");
    expect(linearKeyOf("feat/thing", "SHA-256 update", "Fixes cty-9")).toBe("CTY-9");
    expect(linearKeyOf("feat/thing", "plain", "see https://linear.app/acme/issue/OPS-4/x")).toBe("OPS-4");
    expect(linearKeyOf("utf-8-fix", "nothing")).toBeNull();
  });

  test("maps CI, review and filters", () => {
    expect(ciOf("SUCCESS")).toBe("success");
    expect(ciOf("ERROR")).toBe("failure");
    expect(ciOf("EXPECTED")).toBe("pending");
    expect(ciOf(null)).toBe("none");
    expect(reviewOf("APPROVED")).toBe("approved");
    expect(reviewOf("CHANGES_REQUESTED")).toBe("changes_requested");
    expect(reviewOf("REVIEW_REQUIRED")).toBe("review_required");
    expect(reviewOf(undefined)).toBeNull();
    expect(parseFilter(null)).toBe("mine");
    expect(parseFilter("merged")).toBe("merged");
    expect(() => parseFilter("all")).toThrow("Filtro inválido.");
    expect(parseRepo("acme/api")).toBe("acme/api");
    expect(parseRepo("")).toBeNull();
    expect(() => parseRepo("acme")).toThrow("Repositório inválido.");
    expect(cleanText(' a "b"\n c ')).toBe("a b c");
    expect(searchQuery("review", "acme/api", "board")).toBe(
      "is:pr is:open review-requested:@me archived:false repo:acme/api board sort:updated-desc",
    );
    expect(searchQuery("merged", null, "")).toMatch(/^is:pr is:merged author:@me merged:>=\d{4}-\d{2}-\d{2} sort/);
  });

  test("builds summaries, checks and details", () => {
    const summary = summaryOf({ ...rawPull, state: "MERGED", mergeable: "CONFLICTING", author: null });
    expect(summary).toMatchObject({ state: "merged", mergeable: "conflicting", author: { login: "ghost" } });
    expect(summaryOf({ number: 1, state: "CLOSED", mergeable: "UNKNOWN" })).toMatchObject({
      state: "closed",
      mergeable: "unknown",
      linear: null,
      repo: "",
    });
    expect(checkOf({ __typename: "CheckRun", status: "IN_PROGRESS" }).status).toBe("pending");
    expect(checkOf({ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }).status).toBe("skipped");
    expect(checkOf({ __typename: "CheckRun", status: "COMPLETED", conclusion: "NEUTRAL" }).status).toBe("neutral");
    expect(checkOf({ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" })).toMatchObject({
      name: "check",
      status: "success",
      runId: null,
    });
    expect(checkOf({ __typename: "StatusContext", state: "ERROR" })).toMatchObject({
      name: "status",
      status: "failure",
    });
    expect(checkOf({ __typename: "StatusContext", state: "PENDING", createdAt: "t" })).toMatchObject({
      status: "pending",
      startedAt: "t",
    });
    const detail = detailOf(detailRepo().repository);
    expect(detail.mergeMethods).toEqual(["squash", "merge"]);
    expect(detail.defaultMergeMethod).toBe("squash");
    expect(detail.reviews).toHaveLength(1);
    expect(detail.threads[0]).toMatchObject({ line: 4, path: "src/a.ts" });
    expect(detail.conversation[0].author.login).toBe("ghost");
    expect(detail.commits.map((commit) => commit.message)).toEqual(["second", "first"]);
    expect(detail.commits[1].author).toEqual({ login: "Ana", avatarUrl: null });
    expect(detail.checks.map((check) => check.status)).toEqual(["failure", "success"]);
    expect(() => detailOf({ pullRequest: null })).toThrow("Esse PR não existe.");
    const bare = detailOf({ pullRequest: { number: 2 } });
    expect(bare).toMatchObject({ defaultMergeMethod: "merge", mergeState: "unknown", fileCount: 0, commitCount: 0 });
  });
});

describe("gh client", () => {
  test("reports graphql and process failures", async () => {
    handler = () => ({
      code: 0,
      stdout: JSON.stringify({ errors: [{ type: "NOT_FOUND", message: "nope" }] }),
      stderr: "",
    });
    await expect(graphql("q")).rejects.toMatchObject({ status: 404 });
    handler = () => ({
      code: 0,
      stdout: JSON.stringify({ errors: [{ type: "FORBIDDEN", message: "no" }] }),
      stderr: "",
    });
    await expect(graphql("q")).rejects.toMatchObject({ status: 403 });
    handler = () => ({ code: 0, stdout: JSON.stringify({ errors: [{}] }), stderr: "" });
    await expect(graphql("q")).rejects.toMatchObject({ status: 422 });
    for (const [stderr, status] of [
      ["gh auth login required", 503],
      ["HTTP 404", 404],
      ["HTTP 403 Resource not accessible", 403],
      ["exec: ENOENT", 503],
      ["gh: something odd", 502],
      ["", 502],
    ] as const) {
      handler = () => ({ code: 1, stdout: "not json", stderr });
      const error = await graphql("q").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GitHubError);
      expect((error as GitHubError).status).toBe(status);
    }
  });

  test("calls rest and parses the body", async () => {
    handler = () => ({ code: 0, stdout: '{"a":1}', stderr: "" });
    expect(await rest("GET", "x")).toEqual({ a: 1 });
    handler = () => ({ code: 0, stdout: "plain", stderr: "" });
    expect(await rest("GET", "x")).toBe("plain");
    handler = () => ({ code: 0, stdout: "  ", stderr: "" });
    expect(await rest("DELETE", "x")).toBeNull();
    expect(calls.at(-1)?.args).toEqual(["api", "-X", "DELETE", "x"]);
    handler = () => ({ code: 1, stdout: "", stderr: "HTTP 404" });
    await expect(rest("GET", "x")).rejects.toMatchObject({ status: 404 });
  });
});

describe("routes", () => {
  test("lists the overview with counts, repos and the next page", async () => {
    handler = (call) =>
      ok({
        viewer: { login: "me", avatarUrl: "a" },
        mine: { issueCount: 2 },
        review: { issueCount: 1 },
        mentions: {},
        merged: { issueCount: 4 },
        repos: {
          nodes: [
            rawPull,
            rawPull,
            { ...rawPull, repository: { nameWithOwner: "acme/web" } },
            { ...rawPull, repository: {} },
            {},
          ],
        },
        list: {
          issueCount: 31,
          pageInfo: { hasNextPage: call.variables.after === null, endCursor: "c2" },
          nodes: [rawPull, null],
        },
      });
    const first = await request<Record<string, unknown>>("/github/pulls?filter=review&repo=acme/api&q=board");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      filter: "review",
      repo: "acme/api",
      counts: { mine: 2, review: 1, mentions: 0, merged: 4 },
      total: 31,
      nextCursor: "c2",
    });
    expect(first.body.repos).toEqual([
      { name: "acme/api", owner: "acme", avatarUrl: "https://a/acme.png", count: 2 },
      { name: "acme/web", owner: "acme", avatarUrl: null, count: 1 },
    ]);
    expect(calls[0].variables.list).toContain("repo:acme/api board");
    expect(calls[0].variables.all).not.toContain("repo:");
    await request("/github/pulls?filter=review&repo=acme/api&q=board");
    expect(calls).toHaveLength(1);
    const next = await request<Record<string, unknown>>("/github/pulls?cursor=c2&refresh=1");
    expect(next.body.nextCursor).toBeNull();
    expect((await request("/github/pulls?filter=bad")).status).toBe(400);
  });

  test("returns the summary counts", async () => {
    handler = () => ok({ mine: { issueCount: 3 }, review: { issueCount: 1 } });
    const reply = await request<{ counts: Record<string, number> }>("/github/summary");
    expect(reply.body.counts).toEqual({ mine: 3, review: 1, mentions: 0, merged: 0 });
  });

  test("returns a pull detail and maps errors", async () => {
    handler = () => ok(detailRepo());
    const reply = await request<{ pull: Record<string, unknown> }>("/github/repos/acme/api/pulls/7");
    expect(reply.body.pull).toMatchObject({ number: 7, linear: "CTY-12", mergeState: "clean" });
    expect(calls[0].variables).toEqual({ owner: "acme", name: "api", number: 7 });
    handler = () => ok({ repository: null });
    expect((await request("/github/repos/acme/api/pulls/8")).status).toBe(404);
    expect((await request("/github/repos/acme/api/pulls/zero")).status).toBe(400);
    expect((await request("/github/repos/acme/api/issues/1")).status).toBe(404);
    expect((await request("/github/other")).status).toBe(404);
    handler = () => {
      throw new Error("boom");
    };
    expect((await request("/github/repos/acme/api/pulls/9")).status).toBe(502);
  });

  test("merges with the chosen method and deletes the branch", async () => {
    let merged = false;
    handler = (call) => {
      if (call.query.includes("mergePullRequest")) {
        merged = true;
        return ok({ mergePullRequest: { pullRequest: { number: 7 } } });
      }
      if (call.args[1] === "-X") return { code: 0, stdout: "", stderr: "" };
      return ok(detailRepo(merged ? { state: "MERGED", mergedAt: "now" } : {}));
    };
    const reply = await request<{ pull: { state: string }; branchDeleted: boolean }>(
      "/github/repos/acme/api/pulls/7/merge",
      { method: "POST", body: { method: "squash", deleteBranch: true } },
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ pull: { state: "merged" }, branchDeleted: true });
    const mutation = calls.find((call) => call.query.includes("mergePullRequest"));
    expect(mutation?.variables).toEqual({ id: "PR_1", method: "SQUASH", oid: "abc123" });
    expect(
      calls.some((call) => call.args.join(" ") === "api -X DELETE repos/acme/api/git/refs/heads/anderson/cty-12-board"),
    ).toBe(true);
  });

  test("keeps the merge when deleting the branch fails", async () => {
    let merged = false;
    handler = (call) => {
      if (call.query.includes("mergePullRequest")) {
        merged = true;
        return ok({});
      }
      if (call.args[1] === "-X") return { code: 1, stdout: "", stderr: "HTTP 422 Reference does not exist" };
      return ok(detailRepo(merged ? { state: "MERGED" } : {}));
    };
    const reply = await request<{ branchDeleted: boolean }>("/github/repos/acme/api/pulls/7/merge", {
      method: "POST",
      body: { method: "merge", deleteBranch: true },
    });
    expect(reply.body.branchDeleted).toBe(false);
  });

  test("refuses merges that cannot happen", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
      [{}, { method: "rebase" }, "Esse repositório não aceita esse tipo de merge."],
      [{ isDraft: true }, { method: "squash" }, "Marque o PR como pronto para revisão antes de mergear."],
      [{ state: "CLOSED" }, { method: "squash" }, "Esse PR não está aberto."],
      [{ mergeable: "CONFLICTING" }, { method: "squash" }, "O PR tem conflitos com a base."],
      [{}, { method: "fast" }, "Escolha squash, merge ou rebase."],
    ];
    for (const [overrides, body, error] of cases) {
      clearGitHubCache();
      handler = () => ok(detailRepo(overrides));
      const reply = await request<{ error: string }>("/github/repos/acme/api/pulls/7/merge", { method: "POST", body });
      expect(reply.status).toBe(400);
      expect(reply.body.error).toBe(error);
    }
    expect(calls.some((call) => call.query.includes("mergePullRequest"))).toBe(false);
  });

  test("reviews, comments, replies and marks ready", async () => {
    handler = () => ok(detailRepo({ isDraft: true }));
    const post = (action: string, body: unknown) =>
      request<{ error?: string }>(`/github/repos/acme/api/pulls/7/${action}`, { method: "POST", body });
    expect((await post("review", { event: "approve" })).status).toBe(200);
    expect(calls.find((call) => call.query.includes("addPullRequestReview"))?.variables).toEqual({
      id: "PR_1",
      event: "APPROVE",
      body: null,
    });
    expect((await post("review", { event: "request_changes", body: " " })).body.error).toBe(
      "Escreva o comentário da revisão.",
    );
    expect((await post("review", { event: "dismiss" })).status).toBe(400);
    expect((await post("comment", { body: "nice" })).status).toBe(200);
    expect((await post("comment", {})).status).toBe(400);
    expect((await post("reply", { threadId: "T1", body: "because" })).status).toBe(200);
    expect(calls.find((call) => call.query.includes("addPullRequestReviewThreadReply"))?.variables).toEqual({
      thread: "T1",
      body: "because",
    });
    expect((await post("reply", { threadId: "T9", body: "x" })).body.error).toBe("Essa conversa não é deste PR.");
    expect((await post("reply", { threadId: "T1", body: "" })).status).toBe(400);
    expect((await post("ready", undefined)).status).toBe(200);
    expect(calls.some((call) => call.query.includes("markPullRequestReadyForReview"))).toBe(true);
    handler = () => ok(detailRepo());
    calls.length = 0;
    expect((await post("ready", undefined)).status).toBe(200);
    expect(calls.some((call) => call.query.includes("markPullRequestReadyForReview"))).toBe(false);
    expect((await post("unknown", {})).status).toBe(404);
    expect((await post("comment", [1])).status).toBe(400);
  });

  test("reruns failed workflow runs only", async () => {
    handler = (call) => (call.args[1] === "-X" ? { code: 0, stdout: "", stderr: "" } : ok(detailRepo()));
    const reply = await request<{ reruns: number }>("/github/repos/acme/api/pulls/7/rerun", { method: "POST" });
    expect(reply.body.reruns).toBe(1);
    expect(
      calls.some((call) => call.args.join(" ") === "api -X POST repos/acme/api/actions/runs/99/rerun-failed-jobs"),
    ).toBe(true);
    clearGitHubCache();
    handler = () => ok(detailRepo({ last: { nodes: [] } }));
    expect((await request("/github/repos/acme/api/pulls/7/rerun", { method: "POST" })).status).toBe(400);
  });
});

describe("links to Linear", () => {
  test("indexes pulls by Linear key and searches by branch", async () => {
    handler = (call) =>
      call.variables.q === "is:pr involves:@me archived:false sort:updated-desc"
        ? ok({ list: { nodes: [rawPull, { ...rawPull, number: 5 }, { ...rawPull, headRefName: "x", title: "y" }] } })
        : ok({ list: { nodes: [{ ...rawPull, number: 40, state: "MERGED" }] } });
    const links = await pullsByLinearKey();
    expect(links.get("CTY-12")).toMatchObject({ number: 7, ci: "failure", review: "review_required" });
    expect(links.size).toBe(1);
    expect(await linkForIssue("cty-12", null)).toMatchObject({ number: 7 });
    expect(await linkForIssue("CTY-99", null)).toBeNull();
    expect(await linkForIssue("CTY-99", "anderson/cty-99-x")).toMatchObject({ number: 40, state: "merged" });
    handler = (call) =>
      call.variables.q?.toString().startsWith("is:pr head:") ? ok({ list: { nodes: [] } }) : ok({ list: {} });
    clearGitHubCache();
    expect(await linkForIssue("CTY-99", "b")).toBeNull();
    handler = () => ({ code: 1, stdout: "", stderr: "HTTP 401" });
    clearGitHubCache();
    expect(await linkForIssue("CTY-12", null)).toBeNull();
  });
});
