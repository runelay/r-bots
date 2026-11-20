import { ValidationError } from "../../../shared/errors";
import { notFound, type Req, type Res, readBody, sendJson, validationResponse } from "../../../shared/http";
import { jobStatuses, jobsActive, lanes, listJobs, retryJob } from "../services/jobs.service";
import type { JobStatus, Lane } from "../types/jobs.types";

function intParam(url: URL, name: string, fallback: number, max: number) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new ValidationError(`${name} precisa ser um inteiro entre 1 e ${max}.`, name);
  return value;
}

function listQuery(url: URL) {
  const status = (url.searchParams.get("status") ?? "failed") as JobStatus;
  if (!jobStatuses.includes(status))
    throw new ValidationError(`status precisa ser ${jobStatuses.join(", ")}.`, "status");
  const queue = url.searchParams.get("queue");
  if (queue !== null && !lanes.includes(queue as Lane))
    throw new ValidationError(`queue precisa ser ${lanes.join(" ou ")}.`, "queue");
  return {
    status,
    ...(queue ? { queue: queue as Lane } : {}),
    page: intParam(url, "page", 1, 100_000),
    pageSize: intParam(url, "pageSize", 20, 100),
  };
}

export async function handleJobs(req: Req, res: Res, url: URL, method: string, parts: string[]) {
  if (!jobsActive()) return sendJson(res, 503, { ok: false, error: "A fila não está ligada." });
  try {
    if (method === "GET" && parts.length === 1) return sendJson(res, 200, await listJobs(listQuery(url)));
    if (method === "POST" && parts.length === 3 && parts[2] === "retry") {
      await readBody(req).catch(() => undefined);
      const job = await retryJob(parts[1]);
      if (!job) return sendJson(res, 404, { ok: false, error: "Job não encontrado." });
      return sendJson(res, 202, { ok: true, job });
    }
  } catch (error) {
    return validationResponse(res, error);
  }
  return notFound(res);
}
