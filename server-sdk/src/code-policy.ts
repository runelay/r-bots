import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { WorkspaceState } from "./code";
import { type DeliveryAsk, noDeliveryAsk } from "./delivery-intent";

export type Gate =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "human"; prompt: string; reason: string; hard: boolean; grantKey?: string }
  | { kind: "jev"; prompt: string; grantKey?: string }
  | { kind: "asked"; reason: string };

const home = homedir();
const projectsRoot = resolve(home, "projects");
const botsRoot = resolve(projectsRoot, "runelay-bots");
const sensitivePath = /(^|\/)(\.env(\.[\w-]+)?|\.dev\.vars|\.ssh|id_(rsa|ed25519|ecdsa)[\w.-]*|\.netrc|\.npmrc|\.pypirc|[\w-]*\.pw|credentials?(\.json)?|secrets?(\.[\w-]+)?|\.aws|\.gnupg|\.config\/gh|\.credentials\.json|\.runelay-signing|vault\.key|[\w-]+\.enc)($|\/)/i;
const protectedBranch = /^(origin\/)?(main|master|develop)$/;
const messagingHosts = /(^|\.)(slack\.com|hooks\.slack\.com|api\.whatsapp\.com|graph\.facebook\.com|api\.telegram\.org|api\.twilio\.com|api\.sendgrid\.com|api\.resend\.com|api\.mailgun\.net|api\.postmarkapp\.com|discord\.com|api\.asaas\.com|api\.stripe\.com)$/i;
const localHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);
const protectedRoots = [
  resolve(botsRoot, "server-sdk", "data"),
  resolve(botsRoot, "server-sdk", ".env.local"),
  resolve(botsRoot, "server", ".data"),
  resolve(home, ".claude"),
  resolve(home, ".claude-2"),
  resolve(home, ".codex"),
  resolve(home, ".grok"),
  resolve(home, ".config", "systemd"),
  resolve(home, ".ssh"),
  resolve(home, ".config", "runelay-bots"),
  "/run/runelay-bots",
  "/proc",
];

function expand(path: string) {
  return path.replace(/^~(?=$|\/)/, home);
}

function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function short(text: string, max = 90) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function shownPath(workspace: WorkspaceState, path: string) {
  return within(workspace.path, path) ? relative(workspace.path, path) : path.replace(home, "~");
}

export function protectedPath(path: string) {
  const parts = path.split("/");
  if (parts.includes(".git")) return true;
  if (parts.includes(".claude") || parts.includes(".grok")) return true;
  if (parts.includes(".cursor") && /(hooks|permissions|mcp)\.json$/.test(path)) return true;
  if (/^\.env(\..*)?$/.test(basename(path)) || basename(path) === ".dev.vars") return true;
  return protectedRoots.some((root) => within(root, path));
}

function protectedDeny(workspace: WorkspaceState, path: string): Gate {
  return { kind: "deny", message: `${shownPath(workspace, path)} é um caminho protegido: bots não escrevem em .git, .claude, .env nem na configuração dos bots. Siga sem mexer nele e, se for mesmo necessário, peça à pessoa para fazer.` };
}

function readGate(workspace: WorkspaceState, raw: unknown): Gate {
  if (typeof raw !== "string" || !raw) return { kind: "allow" };
  const path = resolve(workspace.path, expand(raw));
  if (within(workspace.path, path) && !sensitivePath.test(relative(workspace.path, path))) return { kind: "allow" };
  if (sensitivePath.test(path)) return { kind: "human", prompt: `Ler ${shownPath(workspace, path)}? Parece um arquivo com segredo.`, reason: "Arquivo de segredo.", hard: true };
  return { kind: "allow" };
}

function writeGate(workspace: WorkspaceState, raw: unknown): Gate {
  if (typeof raw !== "string" || !raw) return { kind: "allow" };
  const path = resolve(workspace.path, expand(raw));
  if (protectedPath(path)) return protectedDeny(workspace, path);
  if (within(workspace.path, path)) return { kind: "allow" };
  return { kind: "human", prompt: `Editar ${shownPath(workspace, path)}, fora da tarefa?`, reason: "Edição fora da worktree da tarefa.", hard: true };
}

export function gateNative(tool: string, input: Record<string, unknown>, workspace: WorkspaceState, asked: DeliveryAsk = noDeliveryAsk): Gate {
  if (tool === "Read") return readGate(workspace, input.file_path);
  if (tool === "Glob" || tool === "Grep") return readGate(workspace, input.path);
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") return writeGate(workspace, input.file_path);
  if (tool === "NotebookEdit") return writeGate(workspace, input.notebook_path);
  if (tool === "Bash") return gateCommand(String(input.command ?? ""), workspace, asked);
  return { kind: "allow" };
}

export interface Redirect {
  op: string;
  target: string;
}

export interface Segment {
  words: string[];
  redirects: Redirect[];
  piped: boolean;
  background: boolean;
  dynamic: boolean;
}

export class ParseError extends Error {}

function stripHeredocs(command: string) {
  const lines = command.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    out.push(line);
    const markers = [...line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/g)];
    for (const marker of markers) {
      const dash = marker[1] === "-";
      const word = marker[3];
      let found = false;
      while (++index < lines.length) {
        const body = dash ? lines[index].replace(/^\t+/, "") : lines[index];
        if (body === word || body.trim() === word) {
          found = true;
          break;
        }
      }
      if (!found) throw new ParseError("heredoc sem fim");
    }
  }
  return out.join("\n").replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g, "");
}

function matching(text: string, start: number, open: string, close: string) {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && quote === '"') index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return index;
    }
  }
  throw new ParseError("parêntese sem fim");
}

export function parseShell(source: string): Segment[] {
  const text = stripHeredocs(source);
  const segments: Segment[] = [];
  let words: string[] = [];
  let redirects: Redirect[] = [];
  let word = "";
  let hasWord = false;
  let dynamic = false;
  let pendingRedirect: string | null = null;
  let pipedNext = false;
  let piped = false;
  const pushWord = () => {
    if (!hasWord) return;
    if (pendingRedirect) {
      redirects.push({ op: pendingRedirect, target: word });
      pendingRedirect = null;
    } else words.push(word);
    word = "";
    hasWord = false;
  };
  const endSegment = (background = false) => {
    pushWord();
    if (pendingRedirect) throw new ParseError("redirecionamento sem destino");
    if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects, piped, background, dynamic });
    else if (background) throw new ParseError("& solto");
    words = [];
    redirects = [];
    dynamic = false;
    piped = pipedNext;
    pipedNext = false;
  };
  const nested = (inner: string) => {
    for (const segment of parseShell(inner)) segments.push(segment);
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) throw new ParseError("aspas sem fim");
      word += text.slice(index + 1, end);
      hasWord = true;
      index = end;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      let value = "";
      for (; end < text.length; end++) {
        const inner = text[end];
        if (inner === "\\" && end + 1 < text.length) {
          value += text[end + 1];
          end++;
          continue;
        }
        if (inner === '"') break;
        if (inner === "`") {
          const close = text.indexOf("`", end + 1);
          if (close < 0) throw new ParseError("crase sem fim");
          nested(text.slice(end + 1, close));
          dynamic = true;
          value += "$SUB";
          end = close;
          continue;
        }
        if (inner === "$" && text[end + 1] === "(") {
          const close = matching(text, end + 1, "(", ")");
          if (text[end + 2] !== "(") nested(text.slice(end + 2, close));
          dynamic = true;
          value += "$SUB";
          end = close;
          continue;
        }
        value += inner;
      }
      if (end >= text.length) throw new ParseError("aspas sem fim");
      word += value;
      hasWord = true;
      index = end;
      continue;
    }
    if (char === "\\") {
      if (next === "\n") {
        index++;
        continue;
      }
      if (next !== undefined) {
        word += next;
        hasWord = true;
        index++;
      }
      continue;
    }
    if (char === "`") {
      const close = text.indexOf("`", index + 1);
      if (close < 0) throw new ParseError("crase sem fim");
      nested(text.slice(index + 1, close));
      word += "$SUB";
      hasWord = true;
      dynamic = true;
      index = close;
      continue;
    }
    if (char === "$" && next === "(") {
      const close = matching(text, index + 1, "(", ")");
      if (text[index + 2] !== "(") nested(text.slice(index + 2, close));
      word += "$SUB";
      hasWord = true;
      dynamic = true;
      index = close;
      continue;
    }
    if ((char === "<" || char === ">") && next === "(") {
      const close = matching(text, index + 1, "(", ")");
      nested(text.slice(index + 2, close));
      word += "$SUB";
      hasWord = true;
      dynamic = true;
      index = close;
      continue;
    }
    if (char === "$" && next === "{") {
      const close = matching(text, index + 1, "{", "}");
      word += text.slice(index, close + 1);
      hasWord = true;
      dynamic = true;
      index = close;
      continue;
    }
    if (char === "$" && next !== undefined && /[A-Za-z_@*#?0-9!$-]/.test(next)) dynamic = true;
    if (char === " " || char === "\t") {
      pushWord();
      continue;
    }
    if (char === "\n" || char === ";") {
      endSegment();
      if (char === ";" && next === ";") index++;
      continue;
    }
    if (char === "&" && next === "&") {
      endSegment();
      index++;
      continue;
    }
    if (char === "|" && next === "|") {
      endSegment();
      index++;
      continue;
    }
    if (char === "|") {
      pipedNext = true;
      endSegment();
      if (next === "&") index++;
      continue;
    }
    if (char === "&" && next === ">") {
      pushWord();
      const append = text[index + 2] === ">";
      pendingRedirect = append ? "&>>" : "&>";
      index += append ? 2 : 1;
      continue;
    }
    if (char === "&") {
      endSegment(true);
      continue;
    }
    if (char === ">" || char === "<") {
      const fd = hasWord && /^\d+$/.test(word) ? word : "";
      if (fd) {
        word = "";
        hasWord = false;
      } else pushWord();
      let op = char;
      let step = index + 1;
      while (text[step] === ">" || text[step] === "<" || text[step] === "&" || text[step] === "|") {
        op += text[step];
        step++;
      }
      index = step - 1;
      if (op.endsWith("&")) {
        let target = "";
        while (index + 1 < text.length && /[\d-]/.test(text[index + 1])) target += text[++index];
        if (!target) throw new ParseError("redirecionamento estranho");
        continue;
      }
      if (op === "<<<") {
        pendingRedirect = "<<<";
        continue;
      }
      pendingRedirect = `${fd}${op}`;
      continue;
    }
    if (char === "(" || char === ")" || ((char === "{" || char === "}") && !hasWord && (next === undefined || /\s|;/.test(next)))) {
      endSegment();
      continue;
    }
    word += char;
    hasWord = true;
  }
  endSegment();
  return segments;
}

function stripPrefix(tokens: string[]) {
  const rest = [...tokens];
  while (rest.length > 0) {
    const first = rest[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) rest.shift();
    else if (["env", "time", "command", "builtin", "nice", "ionice", "stdbuf"].includes(first)) {
      rest.shift();
      while (rest[0]?.startsWith("-")) rest.shift();
    } else if (first === "timeout") {
      rest.shift();
      while (rest[0]?.startsWith("-")) rest.shift();
      rest.shift();
    } else if (first === "!" ) rest.shift();
    else break;
  }
  if ((rest[0] === "npx" || rest[0] === "bunx") && rest.length > 1) {
    rest.shift();
    while (rest[0]?.startsWith("-")) rest.shift();
  } else if ((rest[0] === "pnpm" || rest[0] === "yarn" || rest[0] === "bun") && (rest[1] === "exec" || rest[1] === "dlx" || rest[1] === "x")) {
    rest.splice(0, 2);
  }
  return rest;
}

const readOnlyCommands = new Set([
  "ls", "cat", "head", "tail", "wc", "rg", "grep", "egrep", "fgrep", "fd", "tree", "pwd", "echo", "printf", "sort", "uniq", "cut", "tr", "diff", "cmp",
  "jq", "yq", "which", "type", "file", "stat", "du", "df", "date", "true", "false", "test", "[", "basename", "dirname", "realpath", "readlink", "seq",
  "column", "nl", "od", "less", "more", "zcat", "shasum", "sha256sum", "md5sum", "base64", "lsof", "ps", "ss", "netstat", "uname", "whoami", "id",
  "hostname", "nproc", "free", "uptime", "sleep", "awk", "sed", "find", "set", "exit", "cd", "export", "unset", "wait",
]);

const devCommands = new Set([
  "mkdir", "touch", "cp", "mv", "rm", "ln", "chmod", "node", "tsx", "ts-node", "bun", "deno", "npm", "pnpm", "yarn", "tsc", "vitest", "jest", "biome",
  "eslint", "prettier", "make", "go", "cargo", "swift", "git", "tee", "vite", "next", "astro", "turbo", "nx", "wrangler", "playwright", "agent-browser",
  "openspec", "gh", "curl", "wget", "unzip", "tar", "gzip", "gunzip", "drizzle-kit", "tsup", "esbuild", "rollup", "webpack", "storybook", "sqlite3",
  "xargs", "patch", "python3", "python",
]);

const safeGit = new Set([
  "status", "diff", "log", "show", "add", "branch", "rev-parse", "ls-files", "ls-tree", "blame", "grep", "stash", "switch", "checkout", "restore", "fetch",
  "config", "remote", "worktree", "mv", "rm", "describe", "shortlog", "reflog", "merge-base", "cat-file", "diff-tree", "name-rev", "cherry", "whatchanged",
  "format-patch", "apply", "check-ignore", "symbolic-ref", "for-each-ref", "show-ref", "count-objects", "version", "help", "notes", "range-diff",
]);

const interpreters = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "node", "python", "python3", "perl", "ruby", "php", "deno", "bun"]);

function hostsIn(tokens: string[]) {
  const hosts: string[] = [];
  for (const token of tokens) {
    const match = token.match(/^(?:https?|wss?|ftp):\/\/([^/:?#\s]+|\[[^\]]+\])/i);
    if (match) hosts.push(match[1].toLowerCase());
    else if (/^[\w.-]+\.[a-z]{2,}(?:[:/]|$)/i.test(token) && !token.startsWith("-") && !token.includes("=")) hosts.push(token.split(/[:/]/)[0].toLowerCase());
  }
  return hosts;
}

type Verdict = { level: "read" } | { level: "dev" } | { level: "unknown"; key: string } | Exclude<Gate, { kind: "allow" } | { kind: "jev" }>;

function hard(prompt: string, reason: string): Verdict {
  return { kind: "human", prompt, reason, hard: true };
}


function pathVerdict(workspace: WorkspaceState, cwd: string, target: string, verb: string): Verdict | null {
  if (!target || target === "/dev/null" || target === "-" || target.startsWith("$SUB")) return null;
  if (/[*?]/.test(target) && /^(\/|~)/.test(target) && !within(workspace.path, resolve(cwd, expand(target.replace(/[*?].*$/, ""))))) {
    return hard(`${verb} ${target}, fora da tarefa?`, "Fora da worktree.");
  }
  const path = resolve(cwd, expand(target));
  if (protectedPath(path)) return protectedDeny(workspace, path) as Verdict;
  if (within(workspace.path, path) || within("/tmp", path)) return null;
  return hard(`${verb} ${shownPath(workspace, path)}, fora da tarefa?`, "Fora da worktree.");
}

function inspect(segment: Segment, tokens: string[], cwd: string, workspace: WorkspaceState, asked: DeliveryAsk = noDeliveryAsk): Verdict {
  const branch = workspace.branch;
  const [command, ...args] = tokens;
  const line = short(tokens.join(" "));
  if (!command) return { level: "read" };
  if (command.includes("$SUB") || command.startsWith("$")) return hard(`Rodar um comando montado na hora: ${line}?`, "Não dá para saber o que vai rodar.");
  if (segment.piped && interpreters.has(command) && !args.some((arg) => !arg.startsWith("-") && arg !== "-")) {
    return hard(`Rodar como script o que veio de outro comando: ${line}?`, "Script vindo de um pipe.");
  }
  const secret = args.find((arg) => !arg.startsWith("-") && sensitivePath.test(resolve(cwd, expand(arg))) && !/\.example$|\.sample$|\.template$/.test(arg));
  if (secret) return hard(`Mexer em ${shownPath(workspace, resolve(cwd, expand(secret)))}? Parece um arquivo com segredo.`, "Arquivo de segredo.");
  if (command === "eval" || command === "exec" || command === "source" || command === ".") return hard(`Rodar ${line}?`, "Executa código montado na hora.");
  if (command === "sudo" || command === "su" || command === "doas" || command === "pkexec") return hard(`Rodar como administrador: ${line}?`, "sudo sempre passa por você.");
  if (command === "nohup" || command === "disown" || command === "setsid" || command === "screen" || command === "tmux") {
    return { kind: "deny", message: "Para deixar algo rodando (servidor, watcher), use a ferramenta dev_server_start." };
  }
  if (command === "git") {
    const gitArgs = args.filter((arg, index) => !(index > 0 && (args[index - 1] === "-C" || args[index - 1] === "-c")));
    const gitSub = gitArgs.filter((arg) => !arg.startsWith("-"))[0] ?? "";
    const refs = gitArgs.filter((arg) => !arg.startsWith("-")).slice(1);
    const onProtected = protectedBranch.test(branch);
    if (gitSub === "commit") {
      if (/co-authored-by|generated with/i.test(tokens.join(" "))) return { kind: "deny", message: "Sem assinatura de IA no commit (Co-Authored-By, Generated with). Refaça a mensagem sem ela." };
      return { level: "dev" };
    }
    if (gitSub === "push") {
      if (args.some((arg) => /^(-f|--force|--force-with-lease|--force-if-includes|--mirror|--delete|-d)(=|$)/.test(arg) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg)) || refs.some((ref) => ref.startsWith("+") || ref.startsWith(":"))) {
        return hard(`Forçar ou apagar no remote: ${line}?`, "Push forçado sempre passa por você.");
      }
      const targets = refs.slice(1).map((ref) => ref.split(":").pop() ?? ref);
      const target = targets.find((ref) => protectedBranch.test(ref)) ?? (targets.length === 0 && onProtected ? branch : null);
      if (target) return hard(`Push direto na ${target}?`, "Push direto em main, master ou develop sempre passa por você.");
      return { level: "dev" };
    }
    if (["merge", "pull", "rebase", "cherry-pick", "revert", "am"].includes(gitSub) && onProtected) {
      return hard(`Rodar git ${gitSub} direto na ${branch}?`, "Mexer direto em main, master ou develop sempre passa por você.");
    }
    if (gitSub === "config" && !args.some((arg) => ["--get", "--list", "-l", "--get-all", "--get-regexp", "--show-origin"].includes(arg))) return { kind: "deny", message: "Configuração do git é protegida: bots não mudam git config." };
    if (gitSub === "worktree" && args.some((arg) => ["remove", "prune", "move"].includes(arg))) return hard(`Mexer nas worktrees: ${line}?`, "Pode apagar trabalho de outro bot.");
    return ["status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "blame", "grep", "describe", "shortlog", "reflog", "merge-base", "cat-file", "diff-tree", "show-ref", "for-each-ref", "version", "help", "check-ignore", "name-rev"].includes(gitSub) ? { level: "read" } : { level: "dev" };
  }
  if (command === "gh") {
    const action = args.filter((arg) => !arg.startsWith("-"));
    if (action[0] === "pr" && action[1] === "merge") return hard(`Fazer merge do PR: ${line}?`, "Merge só com o seu ok.");
    if (action[0] === "pr" && ["create", "edit"].includes(action[1] ?? "") && /co-authored-by|generated with/i.test(tokens.join(" "))) {
      return { kind: "deny", message: "Sem assinatura de IA no PR (Co-Authored-By, Generated with). Refaça o texto sem ela." };
    }
    if (action[0] === "api" && /\/merge(s)?\b/.test(tokens.join(" ")) && args.some((arg) => /^(-X|--method)$/.test(arg))) return hard(`Fazer merge pelo GitHub: ${line}?`, "Merge só com o seu ok.");
    if (action[0] === "release" && ["create", "delete", "upload", "edit"].includes(action[1] ?? "")) return hard(`Publicar release: ${line}?`, "Publicação sempre passa por você.");
    if (action[0] === "repo" && ["delete", "archive", "rename", "edit"].includes(action[1] ?? "")) return hard(`Mexer no repositório do GitHub: ${line}?`, "Apaga ou muda o repositório.");
    if (["auth", "secret", "ssh-key", "gpg-key", "variable"].includes(action[0] ?? "") && !["view", "list", "status"].includes(action[1] ?? "")) {
      return hard(`Mexer na conta do GitHub: ${line}?`, "Conta e segredos do GitHub.");
    }
    if (action[0] === "workflow" && action[1] === "run" && /deploy|prod|release/i.test(tokens.join(" "))) return hard(`Isso parece um deploy: ${line}?`, "Deploy só com o seu ok.");
    return { level: "dev" };
  }
  if (command === "wrangler") {
    if (args.some((arg) => ["deploy", "publish", "rollback", "secret", "delete", "login", "logout"].includes(arg)) || (args.includes("versions") && args.includes("deploy")) || ((args.includes("d1") || args.includes("kv") || args.includes("r2") || args.includes("queues")) && !args.includes("--local"))) {
      return hard(`Isso mexe em produção (Cloudflare): ${line}. Pode rodar?`, "Deploy e produção só com o seu ok.");
    }
    return { level: "dev" };
  }
  if (tokens.some((arg) => /^deploy(:|$)/i.test(arg)) && !readOnlyCommands.has(command)) return hard(`Isso parece um deploy: ${line}. Pode rodar?`, "Deploy só com o seu ok.");
  if (["vercel", "netlify", "fly", "flyctl", "heroku", "firebase", "eas", "railway", "terraform", "pulumi", "kubectl", "helm", "aws", "gcloud", "az", "doctl"].includes(command)) {
    return hard(`Isso publica ou mexe em infraestrutura: ${line}. Pode rodar?`, "Deploy só com o seu ok.");
  }
  if (command === "supabase") {
    if (args.includes("--linked") || args.includes("--remote") || args.includes("--db-url") || args.includes("link") || args.includes("secrets") || (args.includes("db") && args.includes("push")) || (args.includes("migration") && (args.includes("up") || args.includes("repair"))) || args.includes("functions")) {
      return hard(`Isso mexe no Supabase de verdade: ${line}. Pode rodar?`, "Banco e funções remotas só com o seu ok.");
    }
    return { level: "dev" };
  }
  if ((command === "drizzle-kit" || command === "prisma") && args.some((arg) => ["push", "deploy", "migrate", "drop"].includes(arg)) && /\b(prod|production)\b/i.test(tokens.join(" "))) return hard(`Aplicar migration em produção: ${line}?`, "Migration em produção só com o seu ok.");
  if (/migrat/i.test(tokens.join(" ")) && /\b(prod|production|--remote|remote)\b/i.test(tokens.join(" "))) return hard(`Migration em produção: ${line}?`, "Migration em produção só com o seu ok.");
  if (["psql", "mysql", "redis-cli", "mongosh", "mongo", "pg_dump", "pg_restore", "pg_dumpall"].includes(command) && !/(localhost|127\.0\.0\.1|::1)/.test(tokens.join(" "))) return hard(`Conectar num banco fora da VPS: ${line}?`, "Banco de produção sempre passa por você.");
  if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
    const sub = args.find((arg) => !arg.startsWith("-")) ?? "";
    if (["publish", "unpublish", "deprecate", "login", "logout", "adduser", "token", "owner", "access", "dist-tag", "link", "config", "set"].includes(sub)) return hard(`Isso publica ou mexe na conta do ${command}: ${line}?`, "Publicação de pacote.");
    const packages = args.slice(args.indexOf(sub) + 1).filter((arg) => !arg.startsWith("-"));
    void packages;
    const script = sub === "run" || sub === "run-script" ? (args[args.indexOf(sub) + 1] ?? "") : sub;
    if (/deploy|publish|release|prod/i.test(script)) return hard(`Rodar o script ${script}? Parece publicar ou mexer em produção.`, "Script de deploy ou produção.");
    return { level: "dev" };
  }
  if (["curl", "wget", "http", "https", "xh", "httpie"].includes(command)) {
    const outside = hostsIn(args).filter((host) => !localHosts.has(host));
    const messaging = outside.find((host) => messagingHosts.test(host));
    if (messaging && args.some((arg) => /^(-X|--request|-d|--data|--data-raw|--data-binary|-F|--form|--json)$/.test(arg))) return hard(`Mandar para ${messaging}: ${line}?`, "Mensagem para fora ou dinheiro sempre passa por você.");
    if (outside.length > 0) return { level: "dev" };
    if (args.some((arg) => /^(-o|--output|-O|--remote-name)$/.test(arg))) return { level: "dev" };
    return { level: "read" };
  }
  if (["ssh", "scp", "sftp", "nc", "ncat", "netcat", "telnet", "ftp", "socat", "tailscale", "mosh"].includes(command)) return hard(`Conectar em outra máquina: ${line}?`, "Acesso à rede fora da VPS.");
  if (command === "rsync" && args.some((arg) => /^[\w.@-]+:/.test(arg))) return hard(`Copiar para outra máquina: ${line}?`, "Acesso à rede fora da VPS.");
  if (["kill", "pkill", "killall", "systemctl", "service", "reboot", "shutdown", "halt", "poweroff", "crontab", "launchctl", "useradd", "userdel", "usermod", "passwd", "mount", "umount", "iptables", "ufw", "apt", "apt-get", "dpkg", "dnf", "yum", "snap", "brew", "chsh", "visudo", "mkfs", "dd", "fdisk", "shred"].includes(command)) {
    return hard(`Mexer no sistema: ${line}?`, command.includes("kill") ? "Para parar servidor, use dev_server_stop." : "Comando de sistema.");
  }
  if (command === "docker" || command === "podman") {
    if (args.some((arg) => ["rm", "rmi", "stop", "kill", "prune", "down", "push", "volume", "system", "exec", "run", "login", "network"].includes(arg))) return hard(`Mexer nos containers: ${line}?`, "Docker compartilhado da VPS.");
    return { level: "read" };
  }
  if (command === "xargs") {
    const rest = args.filter((arg, index) => !arg.startsWith("-") || (index > 0 && /^-[IinPdLs]$/.test(args[index - 1])));
    const inner = stripPrefix(args.slice(args.findIndex((arg) => !arg.startsWith("-") && !(args[args.indexOf(arg) - 1] ?? "").match(/^-[IinPdLs]$/))));
    if (inner.length === 0 || rest.length === 0) return { level: "read" };
    return inspect({ ...segment, piped: false }, inner, cwd, workspace, asked);
  }
  if (command === "find") {
    const execAt = args.findIndex((arg) => arg === "-exec" || arg === "-execdir" || arg === "-ok" || arg === "-okdir");
    const roots = args.slice(0, args.findIndex((arg) => arg.startsWith("-")) === -1 ? args.length : args.findIndex((arg) => arg.startsWith("-")));
    if (args.includes("-delete")) {
      for (const root of roots.length > 0 ? roots : ["."]) {
        const verdict = pathVerdict(workspace, cwd, root, "Apagar arquivos em");
        if (verdict) return verdict;
      }
      return { level: "dev" };
    }
    if (execAt >= 0) {
      const end = args.findIndex((arg, index) => index > execAt && (arg === ";" || arg === "+"));
      const inner = args.slice(execAt + 1, end < 0 ? undefined : end).map((arg) => (arg === "{}" ? (roots[0] ?? ".") : arg));
      return inspect({ ...segment, piped: false }, stripPrefix(inner), cwd, workspace, asked);
    }
    return { level: "read" };
  }
  if (["rm", "rmdir", "chmod", "chown", "ln", "mv", "cp", "touch", "mkdir", "tee", "truncate", "unlink", "install", "patch"].includes(command)) {
    const targets = args.filter((arg) => !arg.startsWith("-"));
    const checked = command === "cp" || command === "ln" || command === "install" ? targets.slice(-1) : command === "chmod" || command === "chown" ? targets.slice(1) : command === "patch" ? [] : targets;
    const verb = command === "rm" || command === "rmdir" || command === "unlink" ? "Apagar" : command === "chmod" || command === "chown" ? "Mudar permissão de" : "Escrever em";
    for (const target of checked) {
      const verdict = pathVerdict(workspace, cwd, target, verb);
      if (verdict) return verdict;
    }
    if (command === "mv") {
      for (const target of targets.slice(0, -1)) {
        const verdict = pathVerdict(workspace, cwd, target, "Mover");
        if (verdict) return verdict;
      }
    }
    return { level: "dev" };
  }
  if (command === "sed" && args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place"))) {
    for (const target of args.filter((arg) => !arg.startsWith("-")).slice(1)) {
      const verdict = pathVerdict(workspace, cwd, target, "Editar");
      if (verdict) return verdict;
    }
    return { level: "dev" };
  }
  if ((command === "awk" || command === "sed") && args.some((arg) => /\b(system|getline)\b|\bw\s+\/|\be\b/.test(arg) && command === "awk")) return { level: "unknown", key: command };
  if (interpreters.has(command)) {
    const inline = args.findIndex((arg) => arg === "-c" || arg === "-lc" || arg === "-e" || arg === "--eval" || arg === "-p");
    if (inline >= 0 && (command === "sh" || command === "bash" || command === "zsh" || command === "dash")) return { level: "unknown", key: `${command} -c` };
    if (inline >= 0) return { level: "unknown", key: `${command} ${args[inline]}` };
    return { level: "dev" };
  }
  if (readOnlyCommands.has(command)) return { level: "read" };
  if (devCommands.has(command) || command.startsWith("./node_modules/.bin/") || command.startsWith("node_modules/.bin/")) return { level: "dev" };
  if (command.startsWith("./") || command.startsWith("/")) {
    const path = resolve(cwd, command);
    if (within(workspace.path, path) && !protectedPath(path)) return { level: "unknown", key: relative(workspace.path, path) };
    return hard(`Rodar ${shownPath(workspace, path)}?`, "Programa fora da tarefa.");
  }
  return { level: "unknown", key: [command, args.find((arg) => !arg.startsWith("-"))].filter(Boolean).join(" ") };
}

export function gateCommand(command: string, workspace: WorkspaceState, asked: DeliveryAsk = noDeliveryAsk): Gate {
  const trimmed = command.trim();
  if (!trimmed) return { kind: "allow" };
  let segments: Segment[];
  try {
    segments = parseShell(trimmed);
  } catch (error) {
    return { kind: "human", prompt: `Não consegui entender este comando com segurança. Posso rodar? ${short(trimmed, 160)}`, reason: `Comando que não deu para analisar (${error instanceof Error ? error.message : "erro"}).`, hard: true };
  }
  if (segments.some((segment) => segment.background)) {
    return { kind: "deny", message: "Comandos com & não ficam vivos. Para servidor ou watcher, use a ferramenta dev_server_start; para ver a saída, dev_server_logs." };
  }
  let cwd = workspace.path;
  const unknownKeys: string[] = [];
  let softGate: Extract<Gate, { kind: "human" }> | null = null;
  let askedGate: Extract<Gate, { kind: "asked" }> | null = null;
  for (const segment of segments) {
    const tokens = stripPrefix(segment.words);
    for (const redirect of segment.redirects) {
      if (!redirect.op.includes(">")) continue;
      const verdict = pathVerdict(workspace, cwd, redirect.target, "Escrever em");
      if (verdict && "kind" in verdict) return verdict as Gate;
    }
    if (tokens[0] === "cd" || tokens[0] === "pushd") {
      const target = tokens[1] ?? home;
      if (target.includes("$SUB") || target.startsWith("$")) return { kind: "human", prompt: `Rodar ${short(trimmed, 160)}?`, reason: "Pasta montada na hora.", hard: true };
      cwd = resolve(cwd, expand(target));
      continue;
    }
    if ((tokens[0] === "bash" || tokens[0] === "sh" || tokens[0] === "zsh" || tokens[0] === "dash") && (tokens[1] === "-c" || tokens[1] === "-lc") && tokens[2] !== undefined && !segment.dynamic) {
      const inner = gateCommand(tokens[2], workspace, asked);
      if (inner.kind === "allow") continue;
      if (inner.kind === "asked") {
        askedGate = askedGate ?? inner;
        continue;
      }
      if (inner.kind === "jev") {
        unknownKeys.push(inner.grantKey ?? "bash -c");
        continue;
      }
      return inner;
    }
    const verdict = inspect(segment, tokens, cwd, workspace, asked);
    if ("kind" in verdict && verdict.kind === "asked") {
      askedGate = askedGate ?? verdict;
      continue;
    }
    if ("kind" in verdict) {
      if (verdict.kind === "deny" || verdict.hard) return verdict;
      softGate = softGate ?? verdict;
      continue;
    }
    if (verdict.level === "unknown") unknownKeys.push(verdict.key);
  }
  if (softGate) return unknownKeys.length > 0 ? { ...softGate, grantKey: [softGate.grantKey, ...unknownKeys].join(" && ") } : softGate;
  return askedGate ?? { kind: "allow" };
}

export function commandIsReadOnly(command: string, workspace: WorkspaceState) {
  const trimmed = command.trim();
  if (!trimmed) return true;
  let segments: Segment[];
  try {
    segments = parseShell(trimmed);
  } catch {
    return false;
  }
  let cwd = workspace.path;
  for (const segment of segments) {
    if (segment.background) return false;
    if (segment.redirects.some((redirect) => redirect.op.includes(">") && redirect.target !== "/dev/null" && !/^&\d$/.test(redirect.target))) return false;
    const tokens = stripPrefix(segment.words);
    if (tokens[0] === "cd" || tokens[0] === "pushd") {
      cwd = resolve(cwd, expand(tokens[1] ?? home));
      continue;
    }
    if ((tokens[0] === "bash" || tokens[0] === "sh") && (tokens[1] === "-c" || tokens[1] === "-lc") && tokens[2] !== undefined && !segment.dynamic) {
      if (!commandIsReadOnly(tokens[2], workspace)) return false;
      continue;
    }
    const verdict = inspect(segment, tokens, cwd, workspace);
    if ("kind" in verdict || verdict.level !== "read") return false;
  }
  return true;
}

const forceFlag = /^(-f|--force|--force-with-lease|--force-if-includes|--mirror)(=|$)|^-[a-zA-Z]*f[a-zA-Z]*$/;

export function fixedRuleViolation(command: string, workspace: WorkspaceState): string | null {
  let segments: Segment[];
  try {
    segments = parseShell(command.trim());
  } catch {
    return null;
  }
  for (const segment of segments) {
    const tokens = stripPrefix(segment.words);
    if ((tokens[0] === "bash" || tokens[0] === "sh") && (tokens[1] === "-c" || tokens[1] === "-lc") && tokens[2] !== undefined) {
      const inner = fixedRuleViolation(tokens[2], workspace);
      if (inner) return inner;
      continue;
    }
    if (tokens[0] !== "git") continue;
    const args = tokens.slice(1);
    const gitArgs = args.filter((arg, index) => !(index > 0 && (args[index - 1] === "-C" || args[index - 1] === "-c")));
    const words = gitArgs.filter((arg) => !arg.startsWith("-"));
    if (words[0] !== "push") continue;
    const refs = words.slice(1);
    const forced = gitArgs.some((arg) => forceFlag.test(arg)) || refs.some((ref) => ref.startsWith("+"));
    if (!forced) continue;
    const targets = refs.slice(1).map((ref) => ref.replace(/^\+/, "").split(":").pop() ?? ref);
    const target = targets.find((ref) => protectedBranch.test(ref)) ?? (targets.length === 0 && protectedBranch.test(workspace.branch) ? workspace.branch : null);
    if (target) return `push --force em ${target} é proibido pelas regras fixas da pessoa, em qualquer modo.`;
  }
  return null;
}
