import { ValidationError } from "../../../shared/errors";
import { notFound, type Req, type Res, readBody, sendJson, validationResponse } from "../../../shared/http";
import { cleanText } from "../../github/services/github.service";
import {
  assignToMe,
  board,
  issueDetail,
  LinearError,
  linearSummary,
  listViews,
  moveIssue,
  parseIssueId,
  startIssue,
} from "../services/linear.service";

function objectBody(value: unknown) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Corpo inválido.", "body");
  return value as Record<string, unknown>;
}

function failure(res: Res, error: unknown) {
  if (error instanceof ValidationError || error instanceof SyntaxError) return validationResponse(res, error);
  if (error instanceof LinearError) return sendJson(res, error.status, { ok: false, error: error.message });
  return sendJson(res, 502, {
    ok: false,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
  });
}

export async function handleLinear(req: Req, res: Res, url: URL, method: string, parts: string[]) {
  try {
    const [, first, id, action] = parts;
    const refresh = url.searchParams.get("refresh") === "1";
    if (method === "GET" && parts.length === 2) {
      if (first === "summary") return sendJson(res, 200, await linearSummary(refresh));
      if (first === "views") return sendJson(res, 200, { views: await listViews(refresh) });
      if (first === "board")
        return sendJson(
          res,
          200,
          await board({
            view: url.searchParams.get("view") || "mine",
            cursor: url.searchParams.get("cursor") || null,
            query: cleanText(url.searchParams.get("q")),
            refresh,
          }),
        );
    }
    if (first === "issues") {
      const issue = parseIssueId(id);
      if (method === "GET" && parts.length === 3) return sendJson(res, 200, { issue: await issueDetail(issue) });
      if (method === "POST" && parts.length === 4) {
        const body = objectBody(await readBody(req));
        if (action === "state")
          return sendJson(res, 200, await moveIssue(issue, typeof body.column === "string" ? body.column : ""));
        if (action === "assign") return sendJson(res, 200, await assignToMe(issue));
        if (action === "start") return sendJson(res, 200, await startIssue(issue));
      }
    }
    return notFound(res);
  } catch (error) {
    return failure(res, error);
  }
}
