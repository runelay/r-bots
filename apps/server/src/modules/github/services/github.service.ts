import { ValidationError } from "../../../shared/errors";
import { githubText } from "../constants/github-messages.constants";
import { GitHubError, graphql, rest } from "./gh-client.service";

export const pullFilters = ["mine", "review", "mentions", "merged"] as const;
export type PullFilter = (typeof pullFilters)[number];
export type CiState = "none" | "pending" | "success" | "failure";
export type ReviewState = "approved" | "changes_requested" | "review_required" | null;
export type MergeableState = "mergeable" | "conflicting" | "unknown";
export type PullState = "open" | "merged" | "closed";
export type MergeMethod = "merge" | "squash" | "rebase";

export interface Person {
  login: string;
  avatarUrl: string | null;
}

export interface PullSummary {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: Person;
  draft: boolean;
  state: PullState;
  head: string;
  base: string;
  ci: CiState;
  review: ReviewState;
  mergeable: MergeableState;
  additions: number;
  deletions: number;
  comments: number;
  labels: Array<{ name: string; color: string }>;
  updatedAt: string;
  mergedAt: string | null;
  linear: string | null;
}

export interface RepoGroup {
  name: string;
  owner: string;
  avatarUrl: string | null;
  count: number;
}

export interface Overview {
  viewer: Person;
  filter: PullFilter;
  repo: string | null;
  query: string;
  counts: Record<PullFilter, number>;
  repos: RepoGroup[];
  items: PullSummary[];
  total: number;
  nextCursor: string | null;
  fetchedAt: string;
}

export interface PullCheck {
  name: string;
  workflow: string | null;
  status: "pending" | "success" | "failure" | "skipped" | "neutral";
  url: string | null;
  runId: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PullComment {
  id: string;
  author: Person;
  body: string;
  createdAt: string;
  url: string | null;
}

export interface PullReview {
  id: string;
  author: Person;
  state: string;
  body: string;
  submittedAt: string | null;
}

export interface PullThread {
  id: string;
  path: string;
  line: number | null;
  resolved: boolean;
  outdated: boolean;
  comments: PullComment[];
}

export interface PullFile {
  path: string;
  additions: number;
  deletions: number;
  change: string;
}

export interface PullCommit {
  oid: string;
  short: string;
  message: string;
  date: string | null;
  author: Person;
  url: string | null;
}

export interface PullDetail extends PullSummary {
  body: string;
  headOid: string;
  crossRepository: boolean;
  mergeState: string;
  mergeMethods: MergeMethod[];
  defaultMergeMethod: MergeMethod;
  deleteBranchOnMerge: boolean;
  viewerIsAuthor: boolean;
  files: PullFile[];
  fileCount: number;
  reviews: PullReview[];
  threads: PullThread[];
  conversation: PullComment[];
  commits: PullCommit[];
  commitCount: number;
  checks: PullCheck[];
  fetchedAt: string;
}

export interface PullLink {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: PullState;
  draft: boolean;
  ci: CiState;
  review: ReviewState;
}

interface RawPerson {
  login?: string;
  avatarUrl?: string;
}

interface RawPull {
  id?: string;
  number?: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  state?: string;
  updatedAt?: string;
  mergedAt?: string | null;
  headRefName?: string;
  baseRefName?: string;
  additions?: number;
  deletions?: number;
  mergeable?: string;
  reviewDecision?: string | null;
  author?: RawPerson | null;
  repository?: { nameWithOwner?: string; owner?: { login?: string; avatarUrl?: string } };
  comments?: { totalCount?: number };
  labels?: { nodes?: Array<{ name?: string; color?: string }> };
  bodyText?: string;
  last?: { nodes?: Array<{ commit?: { statusCheckRollup?: RawRollup | null } }> };
}

interface RawRollup {
  state?: string;
  contexts?: { nodes?: RawContext[] };
}

interface RawContext {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  checkSuite?: { workflowRun?: { databaseId?: number; workflow?: { name?: string } } | null } | null;
  context?: string;
  state?: string;
  targetUrl?: string | null;
  createdAt?: string | null;
}

interface RawSearch {
  issueCount?: number;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: RawPull[];
}

const pullFields = `
  id number title url isDraft state updatedAt mergedAt headRefName baseRefName additions deletions mergeable reviewDecision
  author { login avatarUrl }
  repository { nameWithOwner owner { login avatarUrl } }
  comments { totalCount }
  labels(first: 6) { nodes { name color } }
  last: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

const linkFields = `
  number title url isDraft state headRefName mergedAt updatedAt reviewDecision
  repository { nameWithOwner }
  last: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

const overviewTtlMs = 30_000;
const detailTtlMs = 20_000;
const linkTtlMs = 60_000;
const pageSize = 30;
const cache = new Map<string, { at: number; value: unknown }>();

function cached<T>(key: string, ttlMs: number, refresh: boolean, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
  return load().then((value) => {
    cache.set(key, { at: Date.now(), value });
    return value;
  });
}

export function clearGitHubCache() {
  cache.clear();
}

function daysAgo(days: number) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export function searchQuery(filter: PullFilter, repo: string | null, text: string) {
  const base: Record<PullFilter, string> = {
    mine: "is:pr is:open author:@me archived:false",
    review: "is:pr is:open review-requested:@me archived:false",
    mentions: "is:pr is:open involves:@me -author:@me archived:false",
    merged: `is:pr is:merged author:@me merged:>=${daysAgo(7)}`,
  };
  return [base[filter], repo ? `repo:${repo}` : "", text, "sort:updated-desc"].filter(Boolean).join(" ");
}

export function parseFilter(value: string | null): PullFilter {
  if (!value) return "mine";
  if ((pullFilters as readonly string[]).includes(value)) return value as PullFilter;
  throw new ValidationError(githubText("filterInvalid"), "filter");
}

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseRepo(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!repoPattern.test(value)) throw new ValidationError(githubText("repoInvalid"), "repo");
  return value;
}

export function cleanText(value: string | null | undefined) {
  return (value ?? "")
    .replace(/[\r\n"\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

const branchKey = /(?:^|[/_-])([a-z][a-z0-9]{1,9})-(\d{1,6})(?=$|[^0-9])/i;
const titleKey = /(?:^|[\s[(])([A-Z][A-Z0-9]{1,9})-(\d{1,6})(?=$|[\s\]):,.])/;
const bodyKey =
  /(?:linear\.app\/[^/\s]+\/issue\/|\b(?:closes|fixes|resolves|refs|ref|fix|close)\s+)([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})/i;
const ignoredKeys = new Set(["SHA", "UTF", "ISO", "HTTP", "TLS", "RFC", "V", "PR", "FEAT", "FIX"]);

export function linearKeyOf(head: string, title: string, body = "") {
  for (const pattern of [branchKey, titleKey, bodyKey]) {
    const source = pattern === branchKey ? head : pattern === titleKey ? title : body;
    const match = source.match(pattern);
    if (!match) continue;
    const prefix = match[1].toUpperCase();
    if (ignoredKeys.has(prefix)) continue;
    return `${prefix}-${match[2]}`;
  }
  return null;
}

function person(raw: RawPerson | null | undefined): Person {
  return { login: raw?.login ?? "ghost", avatarUrl: raw?.avatarUrl ?? null };
}

export function ciOf(state: string | null | undefined): CiState {
  switch ((state ?? "").toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

export function reviewOf(decision: string | null | undefined): ReviewState {
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes_requested";
  if (decision === "REVIEW_REQUIRED") return "review_required";
  return null;
}

function stateOf(raw: { state?: string; mergedAt?: string | null }): PullState {
  if (raw.state === "MERGED" || raw.mergedAt) return "merged";
  if (raw.state === "CLOSED") return "closed";
  return "open";
}

function mergeableOf(value: string | undefined): MergeableState {
  if (value === "MERGEABLE") return "mergeable";
  if (value === "CONFLICTING") return "conflicting";
  return "unknown";
}

export function summaryOf(raw: RawPull): PullSummary {
  const head = raw.headRefName ?? "";
  const title = raw.title ?? "";
  return {
    id: raw.id ?? "",
    repo: raw.repository?.nameWithOwner ?? "",
    number: raw.number ?? 0,
    title,
    url: raw.url ?? "",
    author: person(raw.author),
    draft: raw.isDraft === true,
    state: stateOf(raw),
    head,
    base: raw.baseRefName ?? "",
    ci: ciOf(raw.last?.nodes?.[0]?.commit?.statusCheckRollup?.state),
    review: reviewOf(raw.reviewDecision),
    mergeable: mergeableOf(raw.mergeable),
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    comments: raw.comments?.totalCount ?? 0,
    labels: (raw.labels?.nodes ?? []).map((label) => ({ name: label.name ?? "", color: label.color ?? "888888" })),
    updatedAt: raw.updatedAt ?? "",
    mergedAt: raw.mergedAt ?? null,
    linear: linearKeyOf(head, title, raw.bodyText ?? ""),
  };
}

function isPull(node: RawPull | null | undefined): node is RawPull {
  return Boolean(node && typeof node.number === "number");
}

function groupRepos(nodes: RawPull[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const node of nodes) {
    const name = node.repository?.nameWithOwner;
    if (!name) continue;
    const current = groups.get(name);
    if (current) current.count++;
    else
      groups.set(name, {
        name,
        owner: node.repository?.owner?.login ?? name.split("/")[0],
        avatarUrl: node.repository?.owner?.avatarUrl ?? null,
        count: 1,
      });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export interface OverviewInput {
  filter: PullFilter;
  repo: string | null;
  query: string;
  cursor: string | null;
  refresh: boolean;
}

interface OverviewReply {
  viewer?: RawPerson;
  mine?: RawSearch;
  review?: RawSearch;
  mentions?: RawSearch;
  merged?: RawSearch;
  repos?: RawSearch;
  list?: RawSearch;
}

export function overview(input: OverviewInput): Promise<Overview> {
  const key = `overview:${input.filter}:${input.repo ?? ""}:${input.query}:${input.cursor ?? ""}`;
  return cached(key, overviewTtlMs, input.refresh, async () => {
    const counts = pullFilters
      .map((filter) => `${filter}: search(type: ISSUE, query: $${filter}, first: 0) { issueCount }`)
      .join("\n");
    const query = `query($mine: String!, $review: String!, $mentions: String!, $merged: String!, $all: String!, $list: String!, $first: Int!, $after: String) {
      viewer { login avatarUrl }
      ${counts}
      repos: search(type: ISSUE, query: $all, first: 100) { nodes { ... on PullRequest { number repository { nameWithOwner owner { login avatarUrl } } } } }
      list: search(type: ISSUE, query: $list, first: $first, after: $after) {
        issueCount pageInfo { hasNextPage endCursor }
        nodes { ... on PullRequest { ${pullFields} bodyText } }
      }
    }`;
    const variables: Record<string, unknown> = {
      first: pageSize,
      after: input.cursor,
      all: searchQuery(input.filter, null, input.query),
      list: searchQuery(input.filter, input.repo, input.query),
    };
    for (const filter of pullFilters) variables[filter] = searchQuery(filter, input.repo, "");
    const data = await graphql<OverviewReply>(query, variables);
    const list = data.list ?? {};
    return {
      viewer: person(data.viewer),
      filter: input.filter,
      repo: input.repo,
      query: input.query,
      counts: {
        mine: data.mine?.issueCount ?? 0,
        review: data.review?.issueCount ?? 0,
        mentions: data.mentions?.issueCount ?? 0,
        merged: data.merged?.issueCount ?? 0,
      },
      repos: groupRepos((data.repos?.nodes ?? []).filter(isPull)),
      items: (list.nodes ?? []).filter(isPull).map(summaryOf),
      total: list.issueCount ?? 0,
      nextCursor: list.pageInfo?.hasNextPage ? (list.pageInfo.endCursor ?? null) : null,
      fetchedAt: new Date().toISOString(),
    };
  });
}

export function summary(refresh = false): Promise<Record<PullFilter, number>> {
  return cached("summary", overviewTtlMs, refresh, async () => {
    const counts = pullFilters
      .map((filter) => `${filter}: search(type: ISSUE, query: $${filter}, first: 0) { issueCount }`)
      .join("\n");
    const query = `query($mine: String!, $review: String!, $mentions: String!, $merged: String!) { ${counts} }`;
    const variables: Record<string, unknown> = {};
    for (const filter of pullFilters) variables[filter] = searchQuery(filter, null, "");
    const data = await graphql<Record<PullFilter, RawSearch | undefined>>(query, variables);
    return {
      mine: data.mine?.issueCount ?? 0,
      review: data.review?.issueCount ?? 0,
      mentions: data.mentions?.issueCount ?? 0,
      merged: data.merged?.issueCount ?? 0,
    };
  });
}

function checkStatus(raw: RawContext): PullCheck["status"] {
  if (raw.__typename === "StatusContext") {
    const state = (raw.state ?? "").toUpperCase();
    if (state === "SUCCESS") return "success";
    if (state === "FAILURE" || state === "ERROR") return "failure";
    return "pending";
  }
  if ((raw.status ?? "").toUpperCase() !== "COMPLETED") return "pending";
  switch ((raw.conclusion ?? "").toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "SKIPPED":
      return "skipped";
    case "NEUTRAL":
      return "neutral";
    default:
      return "failure";
  }
}

export function checkOf(raw: RawContext): PullCheck {
  const run = raw.checkSuite?.workflowRun ?? null;
  return {
    name: raw.__typename === "StatusContext" ? (raw.context ?? "status") : (raw.name ?? "check"),
    workflow: run?.workflow?.name ?? null,
    status: checkStatus(raw),
    url: raw.detailsUrl ?? raw.targetUrl ?? null,
    runId: typeof run?.databaseId === "number" ? run.databaseId : null,
    startedAt: raw.startedAt ?? raw.createdAt ?? null,
    completedAt: raw.completedAt ?? null,
  };
}

interface RawComment {
  id?: string;
  author?: RawPerson | null;
  body?: string;
  createdAt?: string;
  submittedAt?: string | null;
  url?: string | null;
  state?: string;
}

interface RawDetailPull extends RawPull {
  body?: string;
  headRefOid?: string;
  isCrossRepository?: boolean;
  mergeStateStatus?: string;
  viewerDidAuthor?: boolean;
  files?: {
    totalCount?: number;
    nodes?: Array<{ path?: string; additions?: number; deletions?: number; changeType?: string }>;
  };
  reviews?: { nodes?: RawComment[] };
  reviewThreads?: {
    nodes?: Array<{
      id?: string;
      isResolved?: boolean;
      isOutdated?: boolean;
      path?: string;
      line?: number | null;
      originalLine?: number | null;
      comments?: { nodes?: RawComment[] };
    }>;
  };
  issueComments?: { nodes?: RawComment[] };
  history?: {
    totalCount?: number;
    nodes?: Array<{
      commit?: {
        oid?: string;
        abbreviatedOid?: string;
        messageHeadline?: string;
        committedDate?: string;
        url?: string;
        author?: { name?: string; user?: RawPerson | null };
      };
    }>;
  };
}

interface RawRepository {
  mergeCommitAllowed?: boolean;
  squashMergeAllowed?: boolean;
  rebaseMergeAllowed?: boolean;
  deleteBranchOnMerge?: boolean;
  viewerDefaultMergeMethod?: string;
  pullRequest?: RawDetailPull | null;
}

function commentOf(raw: RawComment): PullComment {
  return {
    id: raw.id ?? "",
    author: person(raw.author),
    body: raw.body ?? "",
    createdAt: raw.createdAt ?? raw.submittedAt ?? "",
    url: raw.url ?? null,
  };
}

export function detailOf(repo: RawRepository): PullDetail {
  const raw = repo.pullRequest;
  if (!raw) throw new GitHubError(404, githubText("pullMissing"));
  const methods: MergeMethod[] = [];
  if (repo.squashMergeAllowed) methods.push("squash");
  if (repo.mergeCommitAllowed) methods.push("merge");
  if (repo.rebaseMergeAllowed) methods.push("rebase");
  const preferred = (repo.viewerDefaultMergeMethod ?? "").toLowerCase() as MergeMethod;
  const rollup = raw.last?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
  const base = summaryOf({ ...raw, bodyText: raw.body });
  return {
    ...base,
    body: raw.body ?? "",
    headOid: raw.headRefOid ?? "",
    crossRepository: raw.isCrossRepository === true,
    mergeState: (raw.mergeStateStatus ?? "UNKNOWN").toLowerCase(),
    mergeMethods: methods,
    defaultMergeMethod: methods.includes(preferred) ? preferred : (methods[0] ?? "merge"),
    deleteBranchOnMerge: repo.deleteBranchOnMerge === true,
    viewerIsAuthor: raw.viewerDidAuthor === true,
    files: (raw.files?.nodes ?? []).map((file) => ({
      path: file.path ?? "",
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      change: (file.changeType ?? "MODIFIED").toLowerCase(),
    })),
    fileCount: raw.files?.totalCount ?? 0,
    reviews: (raw.reviews?.nodes ?? [])
      .filter((review) => review.state !== "PENDING")
      .map((review) => ({
        id: review.id ?? "",
        author: person(review.author),
        state: (review.state ?? "COMMENTED").toLowerCase(),
        body: review.body ?? "",
        submittedAt: review.submittedAt ?? null,
      })),
    threads: (raw.reviewThreads?.nodes ?? []).map((thread) => ({
      id: thread.id ?? "",
      path: thread.path ?? "",
      line: thread.line ?? thread.originalLine ?? null,
      resolved: thread.isResolved === true,
      outdated: thread.isOutdated === true,
      comments: (thread.comments?.nodes ?? []).map(commentOf),
    })),
    conversation: (raw.issueComments?.nodes ?? []).map(commentOf),
    commits: (raw.history?.nodes ?? []).reverse().map((node) => ({
      oid: node.commit?.oid ?? "",
      short: node.commit?.abbreviatedOid ?? "",
      message: node.commit?.messageHeadline ?? "",
      date: node.commit?.committedDate ?? null,
      author: node.commit?.author?.user
        ? person(node.commit.author.user)
        : { login: node.commit?.author?.name ?? "?", avatarUrl: null },
      url: node.commit?.url ?? null,
    })),
    commitCount: raw.history?.totalCount ?? 0,
    checks: (rollup?.contexts?.nodes ?? []).map(checkOf),
    fetchedAt: new Date().toISOString(),
  };
}

const detailQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge viewerDefaultMergeMethod
    pullRequest(number: $number) {
      id number title url isDraft state updatedAt mergedAt headRefName baseRefName headRefOid additions deletions
      mergeable mergeStateStatus reviewDecision isCrossRepository viewerDidAuthor body
      author { login avatarUrl }
      repository { nameWithOwner owner { login avatarUrl } }
      comments { totalCount }
      labels(first: 10) { nodes { name color } }
      last: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 80) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl startedAt completedAt checkSuite { workflowRun { databaseId workflow { name } } } }
        ... on StatusContext { context state targetUrl createdAt }
      } } } } } }
      files(first: 100) { totalCount nodes { path additions deletions changeType } }
      reviews(last: 30) { nodes { id author { login avatarUrl } state body submittedAt } }
      reviewThreads(first: 60) { nodes { id isResolved isOutdated path line originalLine
        comments(first: 30) { nodes { id author { login avatarUrl } body createdAt url } } } }
      issueComments: comments(last: 60) { nodes { id author { login avatarUrl } body createdAt url } }
      history: commits(last: 40) { totalCount nodes { commit { oid abbreviatedOid messageHeadline committedDate url
        author { name user { login avatarUrl } } } } }
    }
  }
}`;

function splitRepo(repo: string) {
  const [owner, name] = repo.split("/");
  return { owner, name };
}

export function pullDetail(repo: string, number: number, refresh = false): Promise<PullDetail> {
  return cached(`detail:${repo}#${number}`, detailTtlMs, refresh, async () => {
    const data = await graphql<{ repository?: RawRepository | null }>(detailQuery, { ...splitRepo(repo), number });
    if (!data.repository) throw new GitHubError(404, githubText("repoMissing"));
    return detailOf(data.repository);
  });
}

function afterWrite(repo: string, number: number) {
  clearGitHubCache();
  return pullDetail(repo, number, true);
}

export interface MergeInput {
  method: MergeMethod;
  deleteBranch: boolean;
}

export async function mergePull(repo: string, number: number, input: MergeInput) {
  const current = await pullDetail(repo, number, true);
  if (current.state !== "open") throw new ValidationError(githubText("pullNotOpen"), "state");
  if (current.draft) throw new ValidationError(githubText("pullDraft"), "draft");
  if (!current.mergeMethods.includes(input.method)) throw new ValidationError(githubText("mergeMethod"), "method");
  if (current.mergeable === "conflicting") throw new ValidationError(githubText("conflicts"), "mergeable");
  await graphql(
    `mutation($id: ID!, $method: PullRequestMergeMethod!, $oid: GitObjectID) {
      mergePullRequest(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $oid }) { pullRequest { number } }
    }`,
    { id: current.id, method: input.method.toUpperCase(), oid: current.headOid || null },
  );
  let branchDeleted = false;
  if (input.deleteBranch && !current.crossRepository && current.head) {
    try {
      await rest("DELETE", `repos/${repo}/git/refs/heads/${current.head.split("/").map(encodeURIComponent).join("/")}`);
      branchDeleted = true;
    } catch (error) {
      branchDeleted = current.deleteBranchOnMerge || !(error instanceof GitHubError) || error.status === 404;
    }
  }
  return { pull: await afterWrite(repo, number), branchDeleted };
}

export const reviewEvents = ["approve", "request_changes", "comment"] as const;
export type ReviewEvent = (typeof reviewEvents)[number];

export async function reviewPull(repo: string, number: number, event: ReviewEvent, body: string) {
  if (event !== "approve" && !body.trim()) throw new ValidationError(githubText("reviewBody"), "body");
  const current = await pullDetail(repo, number);
  await graphql(
    `mutation($id: ID!, $event: PullRequestReviewEvent!, $body: String) {
      addPullRequestReview(input: { pullRequestId: $id, event: $event, body: $body }) { pullRequestReview { id } }
    }`,
    { id: current.id, event: event.toUpperCase(), body: body.trim() || null },
  );
  return afterWrite(repo, number);
}

export async function commentPull(repo: string, number: number, body: string) {
  if (!body.trim()) throw new ValidationError(githubText("commentBody"), "body");
  const current = await pullDetail(repo, number);
  await graphql(
    `mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { clientMutationId } }`,
    { id: current.id, body: body.trim() },
  );
  return afterWrite(repo, number);
}

export async function replyThread(repo: string, number: number, threadId: string, body: string) {
  if (!body.trim()) throw new ValidationError(githubText("replyBody"), "body");
  const current = await pullDetail(repo, number);
  if (!current.threads.some((thread) => thread.id === threadId))
    throw new ValidationError(githubText("threadOther"), "threadId");
  await graphql(
    `mutation($thread: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } }
    }`,
    { thread: threadId, body: body.trim() },
  );
  return afterWrite(repo, number);
}

export async function markReady(repo: string, number: number) {
  const current = await pullDetail(repo, number, true);
  if (!current.draft) return current;
  await graphql(
    `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number } } }`,
    { id: current.id },
  );
  return afterWrite(repo, number);
}

export async function rerunFailed(repo: string, number: number) {
  const current = await pullDetail(repo, number, true);
  const runs = [
    ...new Set(
      current.checks
        .filter((check) => check.status === "failure" && check.runId !== null)
        .map((check) => check.runId as number),
    ),
  ];
  if (runs.length === 0) throw new ValidationError(githubText("noFailedChecks"), "checks");
  for (const runId of runs) await rest("POST", `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`);
  return { pull: await afterWrite(repo, number), reruns: runs.length };
}

function linkOf(raw: RawPull): PullLink {
  return {
    repo: raw.repository?.nameWithOwner ?? "",
    number: raw.number ?? 0,
    title: raw.title ?? "",
    url: raw.url ?? "",
    state: stateOf(raw),
    draft: raw.isDraft === true,
    ci: ciOf(raw.last?.nodes?.[0]?.commit?.statusCheckRollup?.state),
    review: reviewOf(raw.reviewDecision),
  };
}

export function pullsByLinearKey(refresh = false): Promise<Map<string, PullLink>> {
  return cached("links", linkTtlMs, refresh, async () => {
    const data = await graphql<{ list?: RawSearch }>(
      `query($q: String!) { list: search(type: ISSUE, query: $q, first: 100) { nodes { ... on PullRequest { ${linkFields} bodyText } } } }`,
      { q: "is:pr involves:@me archived:false sort:updated-desc" },
    );
    const links = new Map<string, PullLink>();
    for (const node of (data.list?.nodes ?? []).filter(isPull)) {
      const key = linearKeyOf(node.headRefName ?? "", node.title ?? "", node.bodyText ?? "");
      if (key && !links.has(key)) links.set(key, linkOf(node));
    }
    return links;
  });
}

export async function linkForIssue(identifier: string, branch: string | null) {
  try {
    const links = await pullsByLinearKey();
    const direct = links.get(identifier.toUpperCase());
    if (direct) return direct;
    if (!branch) return null;
    const data = await graphql<{ list?: RawSearch }>(
      `query($q: String!) { list: search(type: ISSUE, query: $q, first: 1) { nodes { ... on PullRequest { ${linkFields} } } } }`,
      { q: `is:pr head:${cleanText(branch)} sort:updated-desc` },
    );
    const found = (data.list?.nodes ?? []).filter(isPull)[0];
    return found ? linkOf(found) : null;
  } catch {
    return null;
  }
}
