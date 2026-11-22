import { policyText } from "../constants/policy-messages.constants";
import { parseShell, type Segment } from "./policy.service";

export interface Critical {
  prompt: string;
  reason: string;
}

const paymentOrMessagingHosts =
  /(^|\.)(slack\.com|api\.whatsapp\.com|graph\.facebook\.com|api\.telegram\.org|api\.twilio\.com|api\.sendgrid\.com|api\.resend\.com|api\.mailgun\.net|api\.postmarkapp\.com|discord\.com|asaas\.com|api\.stripe\.com|api\.pagar\.me|api\.mercadopago\.com)$/i;
const infraCommands = new Set([
  "vercel",
  "netlify",
  "fly",
  "flyctl",
  "heroku",
  "firebase",
  "eas",
  "railway",
  "terraform",
  "pulumi",
  "kubectl",
  "helm",
  "aws",
  "gcloud",
  "az",
  "doctl",
]);
const remoteDatabases = new Set(["psql", "mysql", "mongosh", "mongo", "redis-cli", "pg_restore"]);
const pipeReaders = new Set(["head", "tail", "jq", "wc", "sort", "uniq", "grep", "column", "cut", "cat"]);
const writeMethods = /^(POST|PUT|PATCH|DELETE)$/i;

function short(text: string, max = 140) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function wordsOf(segment: Segment) {
  const words = [...segment.words];
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
  while (["env", "time", "command", "npx", "bunx", "pnpx", "exec"].includes(words[0] ?? "")) {
    words.shift();
    while (words.length > 0 && (words[0]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")))
      words.shift();
  }
  return words;
}

function segmentsOf(command: string): Segment[] | null {
  try {
    return parseShell(command.trim());
  } catch {
    return null;
  }
}

function remoteFlag(args: string[]) {
  return args.some((arg) => /^--(remote|linked|db-url)(=|$)/.test(arg));
}

function hostsOf(args: string[]) {
  const hosts: string[] = [];
  for (const arg of args) {
    const match = arg.match(/^(?:https?:\/\/)?([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?::\d+)?(?:\/|$)/);
    if (match?.[1]) hosts.push(match[1].toLowerCase());
  }
  return hosts;
}

function inspect(words: string[]): Critical | null {
  const [command = "", ...args] = words;
  const line = short(words.join(" "));
  const plain = args.filter((arg) => !arg.startsWith("-"));
  if (command === "bash" || command === "sh" || command === "zsh") {
    const inline = args.findIndex((arg) => arg === "-c" || arg === "-lc");
    return inline >= 0 && args[inline + 1] ? criticalCommand(args[inline + 1] ?? "") : null;
  }
  if (command === "supabase") {
    if (plain[0] === "db" && plain[1] === "query")
      return remoteFlag(args) && !args.includes("--read-only")
        ? { prompt: policyText("remoteSql", { line }), reason: policyText("prodDeny") }
        : null;
    if (
      (plain[0] === "db" && ["push", "reset"].includes(plain[1] ?? "")) ||
      (plain[0] === "migration" && ["up", "repair", "squash"].includes(plain[1] ?? "") && remoteFlag(args)) ||
      (plain[0] === "functions" && ["deploy", "delete"].includes(plain[1] ?? "")) ||
      (plain[0] === "secrets" && ["set", "unset"].includes(plain[1] ?? "")) ||
      (plain[0] === "storage" && ["rm", "cp", "mv"].includes(plain[1] ?? "") && remoteFlag(args))
    )
      return { prompt: policyText("supabaseProd", { line }), reason: policyText("prodDeny") };
    return null;
  }
  if (command === "wrangler") {
    if (plain.some((arg) => ["deploy", "publish", "rollback"].includes(arg)) || plain[0] === "triggers")
      return { prompt: policyText("cloudflareDeploy", { line }), reason: policyText("deployDeny") };
    if (plain[0] === "secret" || plain.includes("delete") || plain.includes("put") || plain.includes("create"))
      return { prompt: policyText("cloudflareProd", { line }), reason: policyText("prodDeny") };
    if (plain[0] === "d1" && ["execute", "migrations"].includes(plain[1] ?? "") && args.includes("--remote"))
      return { prompt: policyText("d1Prod", { line }), reason: policyText("prodDeny") };
    return null;
  }
  if (command === "gh") {
    if (plain[0] === "pr" && plain[1] === "merge")
      return { prompt: policyText("prMergeDeploy", { line }), reason: policyText("deployDeny") };
    if (plain[0] === "workflow" && plain[1] === "run")
      return { prompt: policyText("workflow", { line }), reason: policyText("deployDeny") };
    if (plain[0] === "release" && ["create", "delete", "edit", "upload"].includes(plain[1] ?? ""))
      return { prompt: policyText("release", { line }), reason: policyText("deployDeny") };
    if (plain[0] === "api" && /\/(merges?|deployments|dispatches)\b/.test(words.join(" ")))
      return args.some((arg, index) => /^(-X|--method)$/.test(args[index - 1] ?? "") && writeMethods.test(arg))
        ? { prompt: policyText("githubApi", { line }), reason: policyText("deployDeny") }
        : null;
    return null;
  }
  if (infraCommands.has(command))
    return { prompt: policyText("infraShort", { line }), reason: policyText("deployDeny") };
  if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
    const sub = plain[0] ?? "";
    const script = sub === "run" || sub === "run-script" ? (plain[1] ?? "") : sub;
    if (sub === "publish" || /deploy|release|publish|prod/i.test(script))
      return { prompt: policyText("script", { script: script || sub }), reason: policyText("deployDeny") };
    return null;
  }
  if (remoteDatabases.has(command) && !/(localhost|127\.0\.0\.1|::1)/.test(words.join(" ")))
    return { prompt: policyText("remoteDb", { line }), reason: policyText("prodDeny") };
  if (["curl", "wget", "http", "https", "xh"].includes(command)) {
    const target = hostsOf(args).find((host) => paymentOrMessagingHosts.test(host));
    const writes = args.some(
      (arg, index) =>
        /^(-d|--data|--data-raw|--data-binary|--data-urlencode|-F|--form|--json|--post-data|--post-file)(=|$)/.test(
          arg,
        ) ||
        (/^(-X|--request|--method)$/.test(args[index - 1] ?? "") && writeMethods.test(arg)) ||
        /^-X(POST|PUT|PATCH|DELETE)$/i.test(arg) ||
        writeMethods.test(arg),
    );
    if (target && writes)
      return { prompt: policyText("messaging", { target, line }), reason: policyText("outboundDeny") };
    return null;
  }
  if (words.some((word) => /^deploy(:|$)/i.test(word)))
    return { prompt: policyText("deployAsk", { line }), reason: policyText("deployDeny") };
  return null;
}

export function criticalCommand(command: string): Critical | null {
  const segments = segmentsOf(command);
  if (!segments) return null;
  for (const segment of segments) {
    const found = inspect(wordsOf(segment));
    if (found) return found;
  }
  return null;
}

export function prodReadCommand(command: string) {
  const segments = segmentsOf(command);
  if (!segments || segments.length === 0) return false;
  let reads = 0;
  for (const segment of segments) {
    if (segment.background || segment.dynamic) return false;
    if (segment.redirects.some((redirect) => redirect.op.includes(">") && redirect.target !== "/dev/null"))
      return false;
    const words = wordsOf(segment);
    const [command = "", ...args] = words;
    const plain = args.filter((arg) => !arg.startsWith("-"));
    if (command === "cd") continue;
    if (command === "supabase") {
      if (plain[0] === "db" && plain[1] === "query" && args.includes("--read-only") && remoteFlag(args)) {
        reads++;
        continue;
      }
      if ((plain[0] === "projects" || plain[0] === "migration") && plain[1] === "list") {
        reads++;
        continue;
      }
      return false;
    }
    if (segment.piped && pipeReaders.has(command)) continue;
    return false;
  }
  return reads > 0;
}
