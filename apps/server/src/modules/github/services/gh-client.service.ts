import { tmpdir } from "node:os";
import { childEnv, run } from "@runelay-bots/providers/proc";
import { env } from "../../../config/env";

export interface GhOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export type GhRunner = (args: string[], stdin?: string) => Promise<GhOutput>;

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const defaultRunner: GhRunner = (args, stdin) =>
  run(env.CODE_GH_BIN ?? "gh", args, {
    cwd: tmpdir(),
    timeoutMs: 45_000,
    stdin,
    env: childEnv({ GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }),
  });

let runner: GhRunner = defaultRunner;

export function setGhRunner(next: GhRunner | null) {
  runner = next ?? defaultRunner;
}

function failureOf(output: GhOutput) {
  const text = `${output.stderr}\n${output.stdout}`.trim();
  if (/auth login|not logged|authentication|HTTP 401|Bad credentials/i.test(text))
    return new GitHubError(503, "O GitHub não está conectado no servidor. Rode gh auth login no servidor.");
  if (/HTTP 404|Could not resolve/i.test(text)) return new GitHubError(404, "Não achei isso no GitHub.");
  if (/HTTP 403|Resource not accessible|must have/i.test(text))
    return new GitHubError(403, "O GitHub recusou: sua conta não tem permissão para isso.");
  if (/ENOENT|not found: gh|executable file not found/i.test(text))
    return new GitHubError(503, "O gh não está instalado no servidor.");
  const message = text.split("\n").find((line) => line.trim()) ?? "O GitHub não respondeu.";
  return new GitHubError(502, message.replace(/^gh: /, "").slice(0, 300));
}

interface GraphqlReply<T> {
  data?: T;
  errors?: Array<{ message?: string; type?: string }>;
}

export async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const output = await runner(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }));
  let parsed: GraphqlReply<T> | null = null;
  try {
    parsed = JSON.parse(output.stdout) as GraphqlReply<T>;
  } catch {
    parsed = null;
  }
  if (parsed?.errors?.length) {
    const message = parsed.errors.map((item) => item.message ?? "").join(" ");
    if (parsed.errors.some((item) => item.type === "NOT_FOUND")) throw new GitHubError(404, message.slice(0, 300));
    if (parsed.errors.some((item) => item.type === "FORBIDDEN")) throw new GitHubError(403, message.slice(0, 300));
    throw new GitHubError(422, message.slice(0, 300) || "O GitHub recusou a consulta.");
  }
  if (output.code !== 0 || !parsed?.data) throw failureOf(output);
  return parsed.data;
}

export async function rest(method: string, path: string): Promise<unknown> {
  const output = await runner(["api", "-X", method, path]);
  if (output.code !== 0) throw failureOf(output);
  if (!output.stdout.trim()) return null;
  try {
    return JSON.parse(output.stdout) as unknown;
  } catch {
    return output.stdout;
  }
}
