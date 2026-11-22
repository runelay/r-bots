import { ValidationError } from "../../../shared/errors";
import { notFound, type Req, type Res, readBody, sendFile, sendJson, validationResponse } from "../../../shared/http";
import { commonText } from "../../../shared/messages";
import { githubText } from "../constants/github-messages.constants";
import { fetchGitHubAsset, GitHubError } from "../services/gh-client.service";
import {
  cleanText,
  commentPull,
  type MergeMethod,
  markReady,
  mergePull,
  overview,
  parseFilter,
  parseRepo,
  pullDetail,
  type ReviewEvent,
  replyThread,
  rerunFailed,
  reviewEvents,
  reviewPull,
  summary,
} from "../services/github.service";

function objectBody(value: unknown) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError(commonText("bodyInvalid"), "body");
  return value as Record<string, unknown>;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function pullNumber(value: string | undefined) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new ValidationError(githubText("pullNumber"), "number");
  return number;
}

function failure(res: Res, error: unknown) {
  if (error instanceof ValidationError || error instanceof SyntaxError) return validationResponse(res, error);
  if (error instanceof GitHubError) return sendJson(res, error.status, { ok: false, error: error.message });
  return sendJson(res, 502, {
    ok: false,
    error: (error instanceof Error ? error.message : "Erro interno.").slice(0, 300),
  });
}

const mergeMethods = new Set<MergeMethod>(["merge", "squash", "rebase"]);

async function pullAction(req: Req, res: Res, repo: string, number: number, action: string) {
  const body = objectBody(await readBody(req));
  switch (action) {
    case "merge": {
      const method = text(body.method) as MergeMethod;
      if (!mergeMethods.has(method)) throw new ValidationError(githubText("pickMethod"), "method");
      return sendJson(res, 200, await mergePull(repo, number, { method, deleteBranch: body.deleteBranch === true }));
    }
    case "review": {
      const event = text(body.event) as ReviewEvent;
      if (!reviewEvents.includes(event)) throw new ValidationError(githubText("reviewInvalid"), "event");
      return sendJson(res, 200, { pull: await reviewPull(repo, number, event, text(body.body)) });
    }
    case "comment":
      return sendJson(res, 200, { pull: await commentPull(repo, number, text(body.body)) });
    case "reply":
      return sendJson(res, 200, { pull: await replyThread(repo, number, text(body.threadId), text(body.body)) });
    case "ready":
      return sendJson(res, 200, { pull: await markReady(repo, number) });
    case "rerun":
      return sendJson(res, 200, await rerunFailed(repo, number));
    default:
      return notFound(res);
  }
}

export async function handleGitHub(req: Req, res: Res, url: URL, method: string, parts: string[]) {
  try {
    const [, first, owner, name, kind, number, action] = parts;
    const refresh = url.searchParams.get("refresh") === "1";
    if (method === "GET" && first === "asset" && parts.length === 2) {
      const asset = await fetchGitHubAsset(url.searchParams.get("url") ?? "");
      return sendFile(res, new Blob([asset.data], { type: asset.type }), {
        "content-type": asset.type,
        "cache-control": "private, max-age=3600",
      });
    }
    if (method === "GET" && first === "summary" && parts.length === 2)
      return sendJson(res, 200, { counts: await summary(refresh) });
    if (method === "GET" && first === "pulls" && parts.length === 2)
      return sendJson(
        res,
        200,
        await overview({
          filter: parseFilter(url.searchParams.get("filter")),
          repo: parseRepo(url.searchParams.get("repo")),
          query: cleanText(url.searchParams.get("q")),
          cursor: url.searchParams.get("cursor") || null,
          refresh,
        }),
      );
    if (first === "repos" && kind === "pulls" && owner && name) {
      const repo = parseRepo(`${owner}/${name}`) as string;
      const pull = pullNumber(number);
      if (method === "GET" && parts.length === 6)
        return sendJson(res, 200, { pull: await pullDetail(repo, pull, refresh) });
      if (method === "POST" && parts.length === 7 && action) return await pullAction(req, res, repo, pull, action);
    }
    return notFound(res);
  } catch (error) {
    return failure(res, error);
  }
}
