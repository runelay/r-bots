import { stat } from "node:fs/promises";
import { notFound, type Req, type Res, sendFile, sendJson } from "../../../shared/http";
import { getRun, publicRun, rerun, runFile } from "../services/test-runs.service";

const types: Record<string, string> = {
  "screenshot.jpg": "image/jpeg",
  "screenshot.png": "image/png",
  "log.txt": "text/plain; charset=utf-8",
  "video.webm": "video/webm",
  "trace.zip": "application/zip",
};

export async function handleTests(req: Req, res: Res, method: string, parts: string[]) {
  const [, id, action] = parts;
  const run = id ? await getRun(id) : null;
  if (!run) return sendJson(res, 404, { ok: false, error: "Teste não encontrado." });
  if (method === "GET" && parts.length === 2) return sendJson(res, 200, publicRun(run));
  if (method === "POST" && action === "rerun" && parts.length === 3) {
    try {
      const started = await rerun(run.id);
      return sendJson(res, 202, { ok: true, run: started ? publicRun(started.run) : null });
    } catch (error) {
      return sendJson(res, 409, { ok: false, error: (error as Error).message });
    }
  }
  if (method === "GET" && action === "files" && parts.length === 4 && types[parts[3]]) {
    const path = runFile(run.id, parts[3]);
    const info = path ? await stat(path).catch(() => null) : null;
    if (!path || !info?.isFile()) return sendJson(res, 404, { ok: false, error: "Arquivo não encontrado." });
    return sendFile(res, Bun.file(path), { "content-type": types[parts[3]], "cache-control": "no-store" });
  }
  void req;
  return notFound(res);
}
