import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { rootDir } from "../../../config/env";
import { ensureTool } from "../../tools/services/tools.service";

export interface CutoutStats {
  width: number;
  height: number;
  partialEdgePixels: number;
  opaquePixels: number;
  islands: number;
}

const timeoutMs = 180_000;
let running: Promise<unknown> = Promise.resolve();

export async function cutoutRuntime() {
  const python = process.env.IMAGE_CUTOUT_PYTHON;
  if (python) return { python, env: undefined };
  const dir = await ensureTool("cutout");
  return { python: join(dir, "bin", "python"), env: { ...process.env, IMAGE_CUTOUT_MODELS: join(dir, "models") } };
}

export function cutoutScript() {
  return join(rootDir, "bin", "image-cutout.py");
}

async function spawnCutout(input: string, output: string, trim: boolean, signal: AbortSignal) {
  const partial = `${output}.part.png`;
  const runtime = await cutoutRuntime();
  const child = Bun.spawn([runtime.python, "-I", cutoutScript(), input, partial, ...(trim ? ["--trim"] : [])], {
    env: runtime.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    await rm(partial, { force: true });
    const detail = stderr.trim().split("\n").at(-1) || `código ${code}`;
    throw new Error(`Não consegui recortar a imagem: ${detail}`);
  }
  await rename(partial, output);
  return JSON.parse(stdout.trim().split("\n").at(-1) || "{}") as CutoutStats;
}

export function cutoutImage(input: string, output: string, trim: boolean, signal: AbortSignal) {
  const job = running.then(() => spawnCutout(input, output, trim, signal));
  running = job.catch(() => undefined);
  return job;
}
