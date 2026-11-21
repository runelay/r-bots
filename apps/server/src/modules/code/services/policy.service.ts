import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { dataDir } from "../../../config/env";
import { hostHome, insideAllowedArea, insideHome } from "./repos.service";
import type { WorkspaceState } from "./workspace.service";

export type Gate =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "human"; prompt: string; reason: string; hard: boolean; grantKey?: string }
  | { kind: "jev"; prompt: string; grantKey?: string }
  | { kind: "asked"; reason: string };

const home = homedir();
const sensitivePath =
  /(^|\/)(\.env(\.[\w-]+)?|\.dev\.vars|\.ssh|id_(rsa|ed25519|ecdsa)[\w.-]*|\.netrc|\.npmrc|\.pypirc|[\w-]*\.pw|credentials?(\.json)?|secrets?(\.[\w-]+)?|\.aws|\.gnupg|\.config\/gh|\.credentials\.json|\.runelay-signing|vault\.key|[\w-]+\.enc)($|\/)/i;
const protectedBranch = /^(origin\/)?(main|master|develop)$/;
const messagingHosts =
  /(^|\.)(slack\.com|hooks\.slack\.com|api\.whatsapp\.com|graph\.facebook\.com|api\.telegram\.org|api\.twilio\.com|api\.sendgrid\.com|api\.resend\.com|api\.mailgun\.net|api\.postmarkapp\.com|discord\.com|api\.asaas\.com|api\.stripe\.com)$/i;
const localHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);
const serverRoots = [
  resolve(dataDir),
  resolve(hostHome, ".local", "share", "runelay-bots"),
  resolve(hostHome, ".local", "share", "runelay-bots-backups"),
  "/backups",
  "/run/runelay-bots",
];
const protectedRoots = [
  ...serverRoots,
  ...[...new Set([home, hostHome])].flatMap((root) => [
    resolve(root, ".claude"),
    resolve(root, ".claude-2"),
    resolve(root, ".claude.json"),
    resolve(root, ".codex"),
    resolve(root, ".grok"),
    resolve(root, ".config", "systemd"),
    resolve(root, ".config", "gh"),
    resolve(root, ".supabase"),
    resolve(root, ".ssh"),
    resolve(root, ".config", "runelay-bots"),
  ]),
  "/proc",
];
const deniedSystemRoots = ["/proc", "/sys", "/dev", "/run", "/var/run", "/data", "/backups"];
const systemReadRoots = ["/usr", "/etc", "/opt", "/lib", "/lib32", "/lib64", "/bin", "/sbin"];
const safeDevices = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
]);

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

export function resolveReal(raw: string, cwd = "/") {
  const absolute = isAbsolute(raw) ? raw : `${cwd}/${raw}`;
  let current = "/";
  let exists = true;
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = current === "/" ? `/${part}` : `${current}/${part}`;
    if (exists) {
      try {
        current = realpathSync(next);
        continue;
      } catch {
        exists = false;
      }
    }
    current = next;
  }
  return { real: current, exists };
}

function safeDevice(path: string) {
  return safeDevices.has(path) || /^\/dev\/fd\/\d+$/.test(path);
}

function blocked(path: string) {
  if (safeDevice(path)) return false;
  return [...deniedSystemRoots, ...protectedRoots].some((root) => within(root, path));
}

function inWorkspace(workspace: WorkspaceState, path: string) {
  return within(workspace.path, path) || within(resolveReal(workspace.path).real, path);
}

function shownPath(workspace: WorkspaceState, path: string) {
  return within(workspace.path, path) ? relative(workspace.path, path) : path.replace(home, "~");
}

function outsideRepos(workspace: WorkspaceState, path: string) {
  if (serverRoots.some((root) => within(root, path))) return true;
  return insideHome(path) && !insideAllowedArea(path, [workspace.path, "/tmp"]);
}

function readAllowed(workspace: WorkspaceState, path: string) {
  return (
    inWorkspace(workspace, path) ||
    within("/tmp", path) ||
    insideAllowedArea(path) ||
    systemReadRoots.some((root) => within(root, path))
  );
}

function outsideDeny(workspace: WorkspaceState, path: string): Gate {
  return {
    kind: "deny",
    message: `${shownPath(workspace, path)} fica fora dos repositórios liberados. Siga sem ele; se for mesmo preciso, peça para liberar o repositório com workspace_add(path, reason).`,
  };
}

function blockedDeny(workspace: WorkspaceState, path: string): Gate {
  return {
    kind: "deny",
    message: `${shownPath(workspace, path)} é uma área protegida: bots não leem nem escrevem em dados do servidor, /proc, /sys, /dev, /run nem na configuração das contas. Siga sem ele.`,
  };
}

export function protectedPath(path: string) {
  const parts = path.split("/");
  if (parts.includes(".git")) return true;
  if (parts.includes(".claude") || parts.includes(".grok")) return true;
  if (parts.includes(".cursor") && /(hooks|permissions|mcp|cli)\.json$/.test(path)) return true;
  if (/^\.env(\..*)?$/.test(basename(path)) || basename(path) === ".dev.vars") return true;
  return protectedRoots.some((root) => within(root, path));
}

function protectedDeny(workspace: WorkspaceState, path: string): Gate {
  return {
    kind: "deny",
    message: `${shownPath(workspace, path)} é um caminho protegido: bots não escrevem em .git, .claude, .env nem na configuração dos bots. Siga sem mexer nele e, se for mesmo necessário, peça à pessoa para fazer.`,
  };
}

function readVerdict(workspace: WorkspaceState, raw: string, cwd: string, strict: boolean): Gate | null {
  const expanded = expand(raw);
  const lexical = resolve(cwd, expanded);
  if (safeDevice(lexical)) return null;
  const { real, exists } = resolveReal(expanded, cwd);
  if (blocked(lexical) || blocked(real)) return blockedDeny(workspace, lexical);
  if (inWorkspace(workspace, real)) return null;
  if (outsideRepos(workspace, real) || outsideRepos(workspace, lexical)) return outsideDeny(workspace, lexical);
  if (!strict && !exists) return null;
  if (readAllowed(workspace, real)) return null;
  return outsideDeny(workspace, lexical);
}

function readGate(workspace: WorkspaceState, raw: unknown, cwd = workspace.path): Gate {
  if (typeof raw !== "string" || !raw) return { kind: "allow" };
  const verdict = readVerdict(workspace, raw, cwd, true);
  if (verdict) return verdict;
  const path = resolve(cwd, expand(raw));
  const { real } = resolveReal(expand(raw), cwd);
  const secret = inWorkspace(workspace, path)
    ? sensitivePath.test(relative(workspace.path, path)) || (path !== real && sensitivePath.test(real))
    : sensitivePath.test(path) || sensitivePath.test(real);
  if (!secret) return { kind: "allow" };
  return {
    kind: "human",
    prompt: `Ler ${shownPath(workspace, path)}? Parece um arquivo com segredo.`,
    reason: "Arquivo de segredo.",
    hard: true,
  };
}

const globChars = /[*?[{]/;

function globGate(workspace: WorkspaceState, base: string, pattern: string): Gate {
  const expanded = expand(pattern);
  const meta = expanded.search(globChars);
  const fixed = meta < 0 ? expanded : expanded.slice(0, meta);
  const rest = meta < 0 ? "" : expanded.slice(meta);
  if (rest.split("/").includes(".."))
    return {
      kind: "deny",
      message: `O padrão ${short(pattern, 80)} sobe de pasta depois do curinga. Use um padrão dentro da tarefa.`,
    };
  const dir = meta < 0 ? fixed : fixed.endsWith("/") ? fixed : dirname(fixed);
  return readGate(workspace, dir || ".", base);
}

function searchGate(tool: string, input: Record<string, unknown>, workspace: WorkspaceState): Gate {
  const base = typeof input.path === "string" && input.path ? resolve(workspace.path, expand(input.path)) : null;
  const baseGate = base ? readGate(workspace, base) : { kind: "allow" as const };
  if (baseGate.kind !== "allow") return baseGate;
  const pattern = tool === "Glob" ? input.pattern : input.glob;
  if (typeof pattern !== "string" || !pattern) return baseGate;
  const filter = globGate(workspace, base ?? workspace.path, pattern);
  return filter.kind === "allow" ? baseGate : filter;
}

function writeGate(workspace: WorkspaceState, raw: unknown): Gate {
  if (typeof raw !== "string" || !raw) return { kind: "allow" };
  const expanded = expand(raw);
  const path = resolve(workspace.path, expanded);
  const { real } = resolveReal(expanded, workspace.path);
  if (protectedPath(path) || protectedPath(real)) return protectedDeny(workspace, path);
  if (blocked(path) || blocked(real)) return blockedDeny(workspace, path);
  if (inWorkspace(workspace, real)) return { kind: "allow" };
  if (outsideRepos(workspace, real) || outsideRepos(workspace, path)) return outsideDeny(workspace, path);
  return {
    kind: "human",
    prompt: `Editar ${shownPath(workspace, path)}, fora da tarefa?`,
    reason: "Edição fora da worktree da tarefa.",
    hard: true,
  };
}

export function gateNative(tool: string, input: Record<string, unknown>, workspace: WorkspaceState): Gate {
  if (tool === "Read") return readGate(workspace, input.file_path);
  if (tool === "Glob" || tool === "Grep") return searchGate(tool, input, workspace);
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") return writeGate(workspace, input.file_path);
  if (tool === "NotebookEdit") return writeGate(workspace, input.notebook_path);
  if (tool === "Bash") return gateCommand(String(input.command ?? ""), workspace);
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
  opaque: boolean;
  obfuscated: boolean;
}

export class ParseError extends Error {}

function heredocString(body: string) {
  let out = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    const next = body[index + 1];
    if (char === "\\" && next !== undefined && "$`\\\n".includes(next)) {
      out += char + next;
      index++;
    } else if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else out += char;
  }
  return `<<< "${out}"`;
}

const heredocMarker = /(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/g;

function stripHeredocs(command: string) {
  const lines = command.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const replacements: string[] = [];
    for (const marker of line.matchAll(heredocMarker)) {
      const dash = marker[1] === "-";
      const quoted = marker[2] !== "";
      const word = marker[3];
      const body: string[] = [];
      let found = false;
      while (++index < lines.length) {
        const text = dash ? lines[index].replace(/^\t+/, "") : lines[index];
        if (text === word || text.trim() === word) {
          found = true;
          break;
        }
        body.push(text);
      }
      if (!found) throw new ParseError("heredoc sem fim");
      replacements.push(quoted ? "" : heredocString(body.join("\n")));
    }
    let position = 0;
    out.push(line.replace(heredocMarker, () => replacements[position++] ?? ""));
  }
  return out.join("\n");
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

const ansiEscapes: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

export function decodeAnsiC(body: string) {
  let out = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char !== "\\" || index + 1 >= body.length) {
      out += char;
      continue;
    }
    const next = body[++index];
    const simple = ansiEscapes[next];
    if (simple !== undefined) {
      out += simple;
      continue;
    }
    const rest = body.slice(index + 1);
    const hex =
      next === "x"
        ? rest.match(/^[0-9a-fA-F]{1,2}/)
        : next === "u"
          ? rest.match(/^[0-9a-fA-F]{1,4}/)
          : next === "U"
            ? rest.match(/^[0-9a-fA-F]{1,8}/)
            : null;
    if (hex) {
      const code = Number.parseInt(hex[0], 16);
      out += code <= 0x10ffff ? String.fromCodePoint(code) : "";
      index += hex[0].length;
      continue;
    }
    const octal = body.slice(index).match(/^[0-7]{1,3}/);
    if (octal) {
      out += String.fromCharCode(Number.parseInt(octal[0], 8));
      index += octal[0].length - 1;
      continue;
    }
    if (next === "c" && index + 1 < body.length) {
      out += String.fromCharCode(body.charCodeAt(++index) & 31);
      continue;
    }
    out += `\\${next}`;
  }
  return out;
}

const braceLimit = 256;

function braceSequence(body: string) {
  const match = body.match(/^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/);
  if (!match) return null;
  const numeric = /\d/.test(match[1]) && /\d/.test(match[2]);
  if (!numeric && (/\d/.test(match[1]) || /\d/.test(match[2]))) return null;
  const from = numeric ? Number(match[1]) : match[1].charCodeAt(0);
  const to = numeric ? Number(match[2]) : match[2].charCodeAt(0);
  const step = Math.abs(Number(match[3] ?? 1)) || 1;
  if (Math.abs(to - from) / step >= braceLimit) return [];
  const out: string[] = [];
  for (let value = from; from <= to ? value <= to : value >= to; value += from <= to ? step : -step)
    out.push(numeric ? String(value) : String.fromCharCode(value));
  return out;
}

export function expandBraces(word: string): string[] | null {
  for (let start = 0; start < word.length; start++) {
    if (word[start] !== "{") continue;
    let depth = 0;
    let end = -1;
    const commas: number[] = [];
    for (let index = start; index < word.length; index++) {
      const char = word[index];
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          end = index;
          break;
        }
      } else if (char === "," && depth === 1) commas.push(index);
    }
    if (end < 0) break;
    let options: string[] | null = null;
    if (commas.length > 0) {
      options = [];
      let last = start + 1;
      for (const comma of commas) {
        options.push(word.slice(last, comma));
        last = comma + 1;
      }
      options.push(word.slice(last, end));
    } else options = braceSequence(word.slice(start + 1, end));
    if (!options) continue;
    if (options.length === 0) return null;
    const out: string[] = [];
    for (const option of options) {
      const expanded = expandBraces(`${word.slice(0, start)}${option}${word.slice(end + 1)}`);
      if (!expanded) return null;
      out.push(...expanded);
      if (out.length > braceLimit) return null;
    }
    return out;
  }
  return [word];
}

const bracePattern = /\{[^{}\s]*(,|\.\.)[^{}\s]*\}/;

export function parseShell(source: string): Segment[] {
  const text = stripHeredocs(source);
  const segments: Segment[] = [];
  let words: string[] = [];
  let redirects: Redirect[] = [];
  let word = "";
  let raw = "";
  let hasWord = false;
  let dynamic = false;
  let opaque = false;
  let obfuscated = false;
  let pendingRedirect: string | null = null;
  let pipedNext = false;
  let piped = false;
  const quoted = (value: string) => {
    word += value;
    raw += "\u0000".repeat(Math.max(1, value.length));
    hasWord = true;
  };
  const pushWord = () => {
    if (!hasWord) return;
    if (/\$\{?IFS\b/.test(word)) obfuscated = true;
    if (pendingRedirect) {
      redirects.push({ op: pendingRedirect, target: word });
      pendingRedirect = null;
    } else if (bracePattern.test(raw)) {
      const expanded = raw === word ? expandBraces(word) : null;
      if (!expanded || words.length === 0) obfuscated = true;
      words.push(...(expanded ?? [word]));
    } else words.push(word);
    word = "";
    raw = "";
    hasWord = false;
  };
  const endSegment = (background = false) => {
    pushWord();
    if (pendingRedirect) throw new ParseError("redirecionamento sem destino");
    if (words.length > 0 || redirects.length > 0)
      segments.push({ words, redirects, piped, background, dynamic, opaque, obfuscated });
    else if (background) throw new ParseError("& solto");
    words = [];
    redirects = [];
    dynamic = false;
    opaque = false;
    obfuscated = false;
    piped = pipedNext;
    pipedNext = false;
  };
  const nested = (inner: string) => {
    for (const segment of parseShell(inner)) segments.push(segment);
  };
  const arithmetic = (inner: string) => {
    if (/\$\(|`/.test(inner)) opaque = true;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) throw new ParseError("aspas sem fim");
      quoted(text.slice(index + 1, end));
      index = end;
      continue;
    }
    if (char === "$" && next === "'") {
      let end = index + 2;
      for (; end < text.length && text[end] !== "'"; end++) if (text[end] === "\\") end++;
      if (end >= text.length) throw new ParseError("aspas sem fim");
      quoted(decodeAnsiC(text.slice(index + 2, end)));
      obfuscated = true;
      index = end;
      continue;
    }
    if (char === "$" && next === '"') {
      obfuscated = true;
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
          else arithmetic(text.slice(end + 3, close));
          dynamic = true;
          value += "$SUB";
          end = close;
          continue;
        }
        value += inner;
      }
      if (end >= text.length) throw new ParseError("aspas sem fim");
      quoted(value);
      index = end;
      continue;
    }
    if (char === "\\") {
      if (next === "\n") {
        index++;
        continue;
      }
      if (next !== undefined) {
        if (words.length === 0 && !pendingRedirect) obfuscated = true;
        quoted(next);
        index++;
      }
      continue;
    }
    if (char === "`") {
      const close = text.indexOf("`", index + 1);
      if (close < 0) throw new ParseError("crase sem fim");
      nested(text.slice(index + 1, close));
      quoted("$SUB");
      dynamic = true;
      index = close;
      continue;
    }
    if (char === "$" && next === "(") {
      const close = matching(text, index + 1, "(", ")");
      if (text[index + 2] !== "(") nested(text.slice(index + 2, close));
      else arithmetic(text.slice(index + 3, close));
      quoted("$SUB");
      dynamic = true;
      index = close;
      continue;
    }
    if ((char === "<" || char === ">") && next === "(") {
      const close = matching(text, index + 1, "(", ")");
      nested(text.slice(index + 2, close));
      quoted("$SUB");
      dynamic = true;
      index = close;
      continue;
    }
    if (char === "$" && next === "{") {
      const close = matching(text, index + 1, "{", "}");
      const inner = text.slice(index, close + 1);
      if (/\$\(|`/.test(inner.slice(2))) opaque = true;
      quoted(inner);
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
        raw = "";
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
    if (
      char === "(" ||
      char === ")" ||
      ((char === "{" || char === "}") && !hasWord && (next === undefined || /\s|;/.test(next)))
    ) {
      endSegment();
      continue;
    }
    word += char;
    raw += char;
    hasWord = true;
  }
  endSegment();
  return segments;
}

const readOnlyCommands = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "fd",
  "tree",
  "pwd",
  "echo",
  "printf",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "cmp",
  "jq",
  "yq",
  "which",
  "type",
  "file",
  "stat",
  "du",
  "df",
  "date",
  "true",
  "false",
  "test",
  "[",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "seq",
  "column",
  "nl",
  "od",
  "less",
  "more",
  "zcat",
  "shasum",
  "sha256sum",
  "md5sum",
  "base64",
  "lsof",
  "ps",
  "ss",
  "netstat",
  "uname",
  "whoami",
  "id",
  "hostname",
  "nproc",
  "free",
  "uptime",
  "sleep",
  "find",
  "set",
  "exit",
  "cd",
  "export",
  "unset",
  "wait",
]);

const devCommands = new Set([
  "mkdir",
  "touch",
  "cp",
  "mv",
  "rm",
  "ln",
  "chmod",
  "node",
  "tsx",
  "ts-node",
  "bun",
  "deno",
  "npm",
  "pnpm",
  "yarn",
  "tsc",
  "vitest",
  "jest",
  "biome",
  "eslint",
  "prettier",
  "make",
  "go",
  "cargo",
  "swift",
  "git",
  "tee",
  "vite",
  "next",
  "astro",
  "turbo",
  "nx",
  "wrangler",
  "playwright",
  "agent-browser",
  "openspec",
  "gh",
  "curl",
  "wget",
  "unzip",
  "tar",
  "gzip",
  "gunzip",
  "drizzle-kit",
  "tsup",
  "esbuild",
  "rollup",
  "webpack",
  "storybook",
  "sqlite3",
  "xargs",
  "patch",
  "python3",
  "python",
]);

const interpreters = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "node",
  "python",
  "python3",
  "perl",
  "ruby",
  "php",
  "deno",
  "bun",
]);

const shells = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

const commandRunners = new Set([
  "flock",
  "watch",
  "strace",
  "ltrace",
  "chroot",
  "unshare",
  "nsenter",
  "script",
  "parallel",
  "busybox",
  "xvfb-run",
  "systemd-run",
  "runuser",
  "setpriv",
  "taskset",
  "chrt",
  "prlimit",
  "firejail",
  "bwrap",
  "proot",
  "faketime",
  "valgrind",
  "gdb",
  "expect",
  "dbus-run-session",
  "catchsegv",
  "sg",
  "newgrp",
  "at",
  "batch",
  "unbuffer",
]);

const infraCommands = [
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
];

const remoteCommands = ["ssh", "scp", "sftp", "nc", "ncat", "netcat", "telnet", "ftp", "socat", "tailscale", "mosh"];

const systemCommands = [
  "kill",
  "pkill",
  "killall",
  "systemctl",
  "service",
  "reboot",
  "shutdown",
  "halt",
  "poweroff",
  "crontab",
  "launchctl",
  "useradd",
  "userdel",
  "usermod",
  "passwd",
  "mount",
  "umount",
  "iptables",
  "ufw",
  "apt",
  "apt-get",
  "dpkg",
  "dnf",
  "yum",
  "snap",
  "brew",
  "chsh",
  "visudo",
  "mkfs",
  "dd",
  "fdisk",
  "shred",
];

const databaseCommands = ["psql", "mysql", "redis-cli", "mongosh", "mongo", "pg_dump", "pg_restore", "pg_dumpall"];

const fileCommands = [
  "rm",
  "rmdir",
  "chmod",
  "chown",
  "ln",
  "mv",
  "cp",
  "touch",
  "mkdir",
  "tee",
  "truncate",
  "unlink",
  "install",
  "patch",
];

const prefixCommands: Record<string, { short: string; long: string[] }> = {
  env: { short: "uCS", long: ["unset", "chdir", "split-string"] },
  time: { short: "fo", long: ["format", "output"] },
  command: { short: "", long: [] },
  builtin: { short: "", long: [] },
  nice: { short: "n", long: ["adjustment"] },
  ionice: { short: "cnpPut", long: ["class", "classdata", "pid", "pgid", "uid"] },
  stdbuf: { short: "ioe", long: ["input", "output", "error"] },
  timeout: { short: "sk", long: ["signal", "kill-after"] },
};

const knownNames = new Set<string>([
  ...readOnlyCommands,
  ...devCommands,
  ...interpreters,
  ...commandRunners,
  ...infraCommands,
  ...remoteCommands,
  ...systemCommands,
  ...databaseCommands,
  ...fileCommands,
  ...Object.keys(prefixCommands),
  "sudo",
  "su",
  "doas",
  "pkexec",
  "eval",
  "exec",
  "source",
  "nohup",
  "setsid",
  "screen",
  "tmux",
  "disown",
  "docker",
  "podman",
  "supabase",
  "rsync",
  "sed",
  "awk",
  "gawk",
  "mawk",
  "npx",
  "bunx",
]);

function normalizeCommand(word: string) {
  if (/^\/(usr\/)?(local\/)?s?bin\/[^/]+$/.test(word) && knownNames.has(basename(word))) return basename(word);
  return word;
}

function splitWords(value: string) {
  try {
    return parseShell(value).flatMap((segment) => segment.words);
  } catch {
    return value.split(/\s+/).filter(Boolean);
  }
}

interface Unwrapped {
  tokens: string[];
  assignments: string[];
  env: boolean;
  chdir: string | null;
}

function optionValue(rest: string[], flag: string, spec: { short: string; long: string[] }) {
  if (flag.startsWith("--")) {
    const [name, inline] = flag.slice(2).split(/=(.*)/s);
    if (!spec.long.includes(name)) return { name, value: null };
    return { name, value: inline !== undefined ? inline : (rest.shift() ?? "") };
  }
  for (let index = 1; index < flag.length; index++) {
    const letter = flag[index];
    if (!spec.short.includes(letter)) continue;
    const inline = flag.slice(index + 1);
    return { name: letter, value: inline || (rest.shift() ?? "") };
  }
  return { name: flag.slice(1), value: null };
}

function unwrap(input: string[]): Unwrapped {
  let rest = [...input];
  const assignments: string[] = [];
  let env = false;
  let chdir: string | null = null;
  while (rest.length > 0) {
    const first = normalizeCommand(rest[0]);
    rest[0] = first;
    if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(first)) {
      assignments.push(first);
      rest.shift();
      continue;
    }
    if (first === "!") {
      rest.shift();
      continue;
    }
    const spec = prefixCommands[first];
    if (!spec) break;
    rest.shift();
    if (first === "env") env = true;
    while (rest.length > 0 && rest[0].startsWith("-") && rest[0] !== "-") {
      const flag = rest.shift() ?? "";
      if (flag === "--") break;
      const option = optionValue(rest, flag, spec);
      if (first === "env" && (option.name === "S" || option.name === "split-string") && option.value !== null)
        rest = [...splitWords(option.value), ...rest];
      else if (first === "env" && (option.name === "C" || option.name === "chdir") && option.value !== null)
        chdir = option.value;
    }
    if (first === "env" && rest[0] === "-") rest.shift();
    if (first === "timeout") rest.shift();
  }
  if ((rest[0] === "npx" || rest[0] === "bunx") && rest.length > 1) {
    rest.shift();
    while (rest[0]?.startsWith("-")) rest.shift();
  } else if (
    (rest[0] === "pnpm" || rest[0] === "yarn" || rest[0] === "bun") &&
    (rest[1] === "exec" || rest[1] === "dlx" || rest[1] === "x")
  ) {
    rest.splice(0, 2);
  }
  if (rest[0]) rest[0] = normalizeCommand(rest[0]);
  return { tokens: rest, assignments, env, chdir };
}

function stripPrefix(tokens: string[]) {
  return unwrap(tokens).tokens;
}

function hostsIn(tokens: string[]) {
  const hosts: string[] = [];
  for (const token of tokens) {
    const match = token.match(/^(?:https?|wss?|ftp):\/\/([^/:?#\s]+|\[[^\]]+\])/i);
    if (match) hosts.push(match[1].toLowerCase());
    else if (/^[\w.-]+\.[a-z]{2,}(?:[:/]|$)/i.test(token) && !token.startsWith("-") && !token.includes("="))
      hosts.push(token.split(/[:/]/)[0].toLowerCase());
  }
  return hosts;
}

type Verdict =
  | { level: "read" }
  | { level: "dev" }
  | { level: "unknown"; key: string }
  | Exclude<Gate, { kind: "allow" } | { kind: "jev" }>;

function hard(prompt: string, reason: string): Verdict {
  return { kind: "human", prompt, reason, hard: true };
}

function pathVerdict(workspace: WorkspaceState, cwd: string, target: string, verb: string): Verdict | null {
  if (!target || target === "-" || target.startsWith("$SUB")) return null;
  const expanded = expand(target);
  const lexical = resolve(cwd, expanded);
  if (safeDevice(lexical)) return null;
  if (
    /[*?]/.test(target) &&
    /^(\/|~)/.test(target) &&
    !inWorkspace(workspace, resolve(cwd, expanded.replace(/[*?].*$/, "")))
  )
    return hard(`${verb} ${target}, fora da tarefa?`, "Fora da worktree.");
  const { real } = resolveReal(expanded, cwd);
  if (protectedPath(lexical) || protectedPath(real)) return protectedDeny(workspace, lexical) as Verdict;
  if (blocked(lexical) || blocked(real)) return blockedDeny(workspace, lexical) as Verdict;
  if (inWorkspace(workspace, real) || within("/tmp", real)) return null;
  if (outsideRepos(workspace, real) || outsideRepos(workspace, lexical))
    return outsideDeny(workspace, lexical) as Verdict;
  return hard(`${verb} ${shownPath(workspace, lexical)}, fora da tarefa?`, "Fora da worktree.");
}

function linkVerdict(workspace: WorkspaceState, cwd: string, args: string[]): Verdict | null {
  const symbolic = args.some((arg) => /^-[a-zA-Z]*s[a-zA-Z]*$/.test(arg) || arg === "--symbolic");
  const targets = args.filter((arg) => !arg.startsWith("-"));
  if (targets.length === 0) return null;
  const sources = targets.length === 1 ? targets : targets.slice(0, -1);
  const destination = resolve(cwd, expand(targets.at(-1) ?? ""));
  const { real: destinationReal, exists } = resolveReal(destination);
  const base =
    targets.length === 1
      ? resolveReal(cwd).real
      : targets.length > 2 || exists
        ? destinationReal
        : dirname(destinationReal);
  for (const source of sources) {
    if (source.includes("$"))
      return hard(`Criar link para um destino montado na hora: ${source}?`, "Link para fora da worktree.");
    const from = symbolic
      ? isAbsolute(expand(source))
        ? expand(source)
        : join(base, source)
      : resolve(cwd, expand(source));
    const { real } = resolveReal(from);
    if (blocked(from) || blocked(real)) return blockedDeny(workspace, from) as Verdict;
    if (protectedPath(real)) return protectedDeny(workspace, from) as Verdict;
    if (!inWorkspace(workspace, real) && !within("/tmp", real))
      return hard(`Criar link para ${shownPath(workspace, real)}, fora da tarefa?`, "Link para fora da worktree.");
  }
  return null;
}

const safeGitConfig =
  /^(color\.[\w.-]+|core\.quotepath|core\.pager=(cat|less)|log\.[\w-]+|user\.(name|email)|commit\.gpgsign|advice\.[\w-]+|init\.defaultbranch|diff\.noprefix|pager\.[\w-]+=(false|cat))(=|$)/i;
const gitReadSubcommands = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "blame",
  "grep",
  "describe",
  "shortlog",
  "reflog",
  "merge-base",
  "cat-file",
  "diff-tree",
  "show-ref",
  "for-each-ref",
  "version",
  "help",
  "check-ignore",
  "name-rev",
]);

interface GitCall {
  globals: string[];
  configs: string[];
  configEnv: boolean;
  sub: string;
  args: string[];
}

function parseGit(args: string[]): GitCall {
  const globals: string[] = [];
  const configs: string[] = [];
  let configEnv = false;
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("-")) break;
    globals.push(arg);
    if (arg === "-c" || arg === "-C" || arg === "--config-env" || arg === "--namespace") {
      const value = args[++index] ?? "";
      if (arg === "-c") configs.push(value);
      if (arg === "--config-env") configEnv = true;
      globals.push(value);
    } else if (arg.startsWith("--config-env=")) configEnv = true;
    else if (/^-c.+/.test(arg)) configs.push(arg.slice(2));
  }
  return { globals, configs, configEnv, sub: args[index] ?? "", args: args.slice(index + 1) };
}

function unsafeGitConfig(call: GitCall) {
  return call.configEnv || call.configs.some((config) => !safeGitConfig.test(config));
}

export function normalizeRef(ref: string) {
  return ref
    .replace(/^\+/, "")
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/[^/]+\//, "")
    .replace(/^heads\//, "");
}

const pushValueFlags = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
const pushForce =
  /^(-f|--force|--force-with-lease|--force-if-includes|--mirror|--delete|-d|--all|--branches|--prune)(=|$)|^-[a-zA-Z]*[fd][a-zA-Z]*$/;

function pushRefs(args: string[]) {
  const refs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (pushValueFlags.has(arg)) index++;
    else if (!arg.startsWith("-")) refs.push(arg);
  }
  return refs;
}

function pushTarget(refs: string[], branch: string) {
  const targets = refs.slice(1).map((ref) => normalizeRef(ref.includes(":") ? (ref.split(":").pop() ?? ref) : ref));
  const named = targets.find((ref) => protectedBranch.test(ref));
  if (named) return named;
  if (!protectedBranch.test(branch)) return null;
  if (targets.length === 0 || targets.some((ref) => ref === "HEAD" || ref === "@")) return branch;
  return null;
}

function unknownRef(ref: string) {
  return ref.includes("$") || ref.includes("{}") || ref.includes("*");
}

function pushVerdict(call: GitCall, line: string, branch: string, indirect: boolean): Verdict {
  if (
    call.args.some((arg) => pushForce.test(arg) || /^--(receive-pack|exec)(=|$)/.test(arg)) ||
    pushRefs(call.args).some((ref) => ref.startsWith("+") || ref.startsWith(":") || ref.includes(":+"))
  )
    return hard(`Forçar ou apagar no remote: ${line}?`, "Push forçado sempre passa por você.");
  const refs = pushRefs(call.args);
  if (indirect || refs.some(unknownRef))
    return hard(`Push com destino montado na hora: ${line}?`, "Não dá para saber para qual branch vai o push.");
  const target = pushTarget(refs, branch);
  if (target) return hard(`Push direto na ${target}?`, "Push direto em main, master ou develop sempre passa por você.");
  return { level: "dev" };
}

function gitVerdict(tokens: string[], workspace: WorkspaceState, indirect = false): Verdict {
  const branch = workspace.branch;
  const call = parseGit(tokens.slice(1));
  const line = short(tokens.join(" "));
  if (unsafeGitConfig(call))
    return hard(
      `Rodar git com configuração na linha de comando: ${line}?`,
      "Configuração do git pode mudar para onde vai o push ou rodar programas.",
    );
  const onProtected = protectedBranch.test(branch);
  const sub = call.sub;
  if (sub === "commit") {
    if (/co-authored-by|generated with/i.test(tokens.join(" ")))
      return {
        kind: "deny",
        message: "Sem assinatura de IA no commit (Co-Authored-By, Generated with). Refaça a mensagem sem ela.",
      };
    return { level: "dev" };
  }
  if (sub === "push") return pushVerdict(call, line, branch, indirect);
  if (["send-pack", "http-push", "receive-pack", "upload-pack"].includes(sub))
    return hard(`Mandar objetos direto para o remote: ${line}?`, "Push forçado sempre passa por você.");
  if (["merge", "pull", "rebase", "cherry-pick", "revert", "am"].includes(sub) && onProtected)
    return hard(
      `Rodar git ${sub} direto na ${branch}?`,
      "Mexer direto em main, master ou develop sempre passa por você.",
    );
  if (
    sub === "config" &&
    !call.args.some((arg) => ["--get", "--list", "-l", "--get-all", "--get-regexp", "--show-origin"].includes(arg))
  )
    return { kind: "deny", message: "Configuração do git é protegida: bots não mudam git config." };
  if (sub === "worktree" && call.args.some((arg) => ["remove", "prune", "move"].includes(arg)))
    return hard(`Mexer nas worktrees: ${line}?`, "Pode apagar trabalho de outro bot.");
  return gitReadSubcommands.has(sub) ? { level: "read" } : { level: "dev" };
}

const ghWritePaths =
  /(\/merges?\b|\/git\/refs\b|\/contents\/|\/branches\/|\/rulesets\b|\/actions\/secrets\b|\/collaborators\b|\/hooks\b)/;
const ghMutations =
  /(mergePullRequest|enablePullRequestAutoMerge|updateRef|updateRefs|createCommitOnBranch|deleteRef|updateBranchProtectionRule|deleteBranchProtectionRule|mergeBranch)/i;

function ghMethod(args: string[]) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-X" || arg === "--method") return args[index + 1] ?? "";
    if (arg.startsWith("--method=")) return arg.slice(9);
    if (/^-X.+/.test(arg)) return arg.slice(2);
  }
  return null;
}

function ghVerdict(tokens: string[]): Verdict {
  const args = tokens.slice(1);
  const line = short(tokens.join(" "));
  const text = tokens.join(" ");
  const action = args.filter((arg) => !arg.startsWith("-"));
  if (action[0] === "pr" && action[1] === "merge") return hard(`Fazer merge do PR: ${line}?`, "Merge só com o seu ok.");
  if (action[0] === "pr" && ["create", "edit"].includes(action[1] ?? "") && /co-authored-by|generated with/i.test(text))
    return {
      kind: "deny",
      message: "Sem assinatura de IA no PR (Co-Authored-By, Generated with). Refaça o texto sem ela.",
    };
  if (action[0] === "api") {
    const method = ghMethod(args);
    const fields = args.some((arg) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(arg) || /^-[fF].+/.test(arg));
    const writes = fields || (method !== null && method.toUpperCase() !== "GET");
    const graphql = action.includes("graphql");
    if (
      graphql &&
      (ghMutations.test(text) || args.some((arg) => arg === "--input" || arg.startsWith("--input=") || /=@/.test(arg)))
    )
      return hard(`Fazer merge ou mudar branch pelo GitHub: ${line}?`, "Merge só com o seu ok.");
    if (writes && ghWritePaths.test(text)) return hard(`Fazer merge pelo GitHub: ${line}?`, "Merge só com o seu ok.");
  }
  if (action[0] === "release" && ["create", "delete", "upload", "edit"].includes(action[1] ?? ""))
    return hard(`Publicar release: ${line}?`, "Publicação sempre passa por você.");
  if (action[0] === "repo" && ["delete", "archive", "rename", "edit"].includes(action[1] ?? ""))
    return hard(`Mexer no repositório do GitHub: ${line}?`, "Apaga ou muda o repositório.");
  if (
    ["auth", "secret", "ssh-key", "gpg-key", "variable"].includes(action[0] ?? "") &&
    !["view", "list", "status"].includes(action[1] ?? "")
  )
    return hard(`Mexer na conta do GitHub: ${line}?`, "Conta e segredos do GitHub.");
  if (action[0] === "workflow" && action[1] === "run" && /deploy|prod|release/i.test(text))
    return hard(`Isso parece um deploy: ${line}?`, "Deploy só com o seu ok.");
  return { level: "dev" };
}

const xargsValueFlags = new Set([
  "-I",
  "-n",
  "-P",
  "-d",
  "-L",
  "-s",
  "-a",
  "-E",
  "--arg-file",
  "--delimiter",
  "--max-args",
  "--max-procs",
  "--max-lines",
  "--max-chars",
]);

function xargsInner(args: string[]) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (xargsValueFlags.has(arg)) index++;
    else if (!arg.startsWith("-")) return stripPrefix(args.slice(index));
  }
  return [];
}

function findExecs(args: string[], roots: string[]) {
  const inner: string[][] = [];
  for (let index = 0; index < args.length; index++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[index])) continue;
    const end = args.findIndex((arg, at) => at > index && (arg === ";" || arg === "+"));
    inner.push(
      stripPrefix(
        args.slice(index + 1, end < 0 ? undefined : end).map((arg) => (arg === "{}" ? (roots[0] ?? ".") : arg)),
      ),
    );
    if (end < 0) break;
    index = end;
  }
  return inner;
}

function shellScript(args: string[]) {
  const at = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
  return at >= 0 ? (args[at + 1] ?? null) : null;
}

const subscriptCommands = new Set([
  "printf",
  "unset",
  "test",
  "[",
  "[[",
  "declare",
  "typeset",
  "local",
  "let",
  "read",
  "mapfile",
  "readarray",
  "export",
]);
const dangerousAssignment =
  /^(GIT_(CONFIG\w*|DIR|WORK_TREE|COMMON_DIR|EXEC_PATH|SSH|SSH_COMMAND|EXTERNAL_DIFF|ASKPASS|PROXY_COMMAND|NAMESPACE|ALTERNATE_OBJECT_DIRECTORIES)|LD_PRELOAD|LD_AUDIT|LD_LIBRARY_PATH|BASH_ENV|ENV|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|PS4|IFS)\+?=/;

function outputTargets(command: string, args: string[]) {
  const outputs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if ((command === "sort" || command === "tree") && (arg === "-o" || arg === "--output"))
      outputs.push(args[index + 1] ?? "");
    else if (command === "sort" && arg.startsWith("--output=")) outputs.push(arg.slice(9));
    else if (command === "sort" && /^-[a-zA-Z]*o.+/.test(arg)) outputs.push(arg.slice(arg.indexOf("o") + 1));
    else if (command === "find" && ["-fprint", "-fprint0", "-fls", "-fprintf"].includes(arg))
      outputs.push(args[index + 1] ?? "");
  }
  if (command === "uniq") {
    const positional = args.filter((arg) => !arg.startsWith("-"));
    if (positional.length >= 2) outputs.push(positional[1]);
  }
  if (command === "sed")
    for (const arg of args)
      for (const match of arg.matchAll(/(?:^|[;\n}]|\/[gpIiMme0-9]*)\s*[wW]\s+(\S+)/g)) outputs.push(match[1]);
  return outputs.filter(Boolean);
}

function inspect(segment: Segment, tokens: string[], cwd: string, workspace: WorkspaceState, depth: number): Verdict {
  const [command, ...args] = tokens;
  const line = short(tokens.join(" "));
  if (!command) return { level: "read" };
  if (command.includes("$"))
    return hard(`Rodar um comando montado na hora: ${line}?`, "Não dá para saber o que vai rodar.");
  if (segment.piped && interpreters.has(command) && !args.some((arg) => !arg.startsWith("-") && arg !== "-")) {
    return hard(`Rodar como script o que veio de outro comando: ${line}?`, "Script vindo de um pipe.");
  }
  const secret = args.find(
    (arg) =>
      !arg.startsWith("-") &&
      sensitivePath.test(resolve(cwd, expand(arg))) &&
      !/\.example$|\.sample$|\.template$/.test(arg),
  );
  if (secret)
    return hard(
      `Mexer em ${shownPath(workspace, resolve(cwd, expand(secret)))}? Parece um arquivo com segredo.`,
      "Arquivo de segredo.",
    );
  if (subscriptCommands.has(command) && args.some((arg) => /\[.*(\$\(|`)/.test(arg)))
    return hard(`Rodar ${line}?`, "Expressão que executa um comando escondido.");
  if (command === "eval" || command === "exec" || command === "source" || command === ".")
    return hard(`Rodar ${line}?`, "Executa código montado na hora.");
  if (command === "sudo" || command === "su" || command === "doas" || command === "pkexec")
    return hard(`Rodar como administrador: ${line}?`, "sudo sempre passa por você.");
  if (["nohup", "disown", "setsid", "screen", "tmux"].includes(command))
    return {
      kind: "deny",
      message: "Para deixar algo rodando (servidor, watcher), use a ferramenta dev_server_start.",
    };
  if (commandRunners.has(command))
    return hard(`Rodar um comando por dentro de ${command}: ${line}?`, "Comando que roda outro comando por dentro.");
  if (command === "git") return gitVerdict(tokens, workspace);
  if (!readOnlyCommands.has(command)) {
    const embedded = args.indexOf("git");
    if (embedded >= 0) {
      const inner = gitVerdict(args.slice(embedded), workspace, true);
      if ("kind" in inner) return inner;
    }
  }
  if (command === "gh") return ghVerdict(tokens);
  if (command === "wrangler") {
    if (
      args.some((arg) => ["deploy", "publish", "rollback", "secret", "delete", "login", "logout"].includes(arg)) ||
      (args.includes("versions") && args.includes("deploy")) ||
      ((args.includes("d1") || args.includes("kv") || args.includes("r2") || args.includes("queues")) &&
        !args.includes("--local"))
    ) {
      return hard(`Isso mexe em produção (Cloudflare): ${line}. Pode rodar?`, "Deploy e produção só com o seu ok.");
    }
    return { level: "dev" };
  }
  if (tokens.some((arg) => /^deploy(:|$)/i.test(arg)) && !readOnlyCommands.has(command))
    return hard(`Isso parece um deploy: ${line}. Pode rodar?`, "Deploy só com o seu ok.");
  if (infraCommands.includes(command))
    return hard(`Isso publica ou mexe em infraestrutura: ${line}. Pode rodar?`, "Deploy só com o seu ok.");
  if (command === "supabase") {
    if (
      args.includes("--linked") ||
      args.includes("--remote") ||
      args.includes("--db-url") ||
      args.includes("link") ||
      args.includes("secrets") ||
      (args.includes("db") && args.includes("push")) ||
      (args.includes("migration") && (args.includes("up") || args.includes("repair"))) ||
      args.includes("functions")
    ) {
      return hard(`Isso mexe no Supabase de verdade: ${line}. Pode rodar?`, "Banco e funções remotas só com o seu ok.");
    }
    return { level: "dev" };
  }
  if (
    (command === "drizzle-kit" || command === "prisma") &&
    args.some((arg) => ["push", "deploy", "migrate", "drop"].includes(arg)) &&
    /\b(prod|production)\b/i.test(tokens.join(" "))
  )
    return hard(`Aplicar migration em produção: ${line}?`, "Migration em produção só com o seu ok.");
  if (/migrat/i.test(tokens.join(" ")) && /\b(prod|production|--remote|remote)\b/i.test(tokens.join(" ")))
    return hard(`Migration em produção: ${line}?`, "Migration em produção só com o seu ok.");
  if (databaseCommands.includes(command) && !/(localhost|127\.0\.0\.1|::1)/.test(tokens.join(" ")))
    return hard(`Conectar num banco fora da VPS: ${line}?`, "Banco de produção sempre passa por você.");
  if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
    const sub = args.find((arg) => !arg.startsWith("-")) ?? "";
    if (
      [
        "publish",
        "unpublish",
        "deprecate",
        "login",
        "logout",
        "adduser",
        "token",
        "owner",
        "access",
        "dist-tag",
        "link",
        "config",
        "set",
      ].includes(sub)
    )
      return hard(`Isso publica ou mexe na conta do ${command}: ${line}?`, "Publicação de pacote.");
    const script = sub === "run" || sub === "run-script" ? (args[args.indexOf(sub) + 1] ?? "") : sub;
    if (/deploy|publish|release|prod/i.test(script))
      return hard(`Rodar o script ${script}? Parece publicar ou mexer em produção.`, "Script de deploy ou produção.");
    return { level: "dev" };
  }
  if (["curl", "wget", "http", "https", "xh", "httpie"].includes(command)) {
    const outside = hostsIn(args).filter((host) => !localHosts.has(host));
    const messaging = outside.find((host) => messagingHosts.test(host));
    if (
      messaging &&
      args.some((arg) => /^(-X|--request|-d|--data|--data-raw|--data-binary|-F|--form|--json)$/.test(arg))
    )
      return hard(`Mandar para ${messaging}: ${line}?`, "Mensagem para fora ou dinheiro sempre passa por você.");
    if (outside.length > 0) return { level: "dev" };
    if (args.some((arg) => /^(-o|--output|-O|--remote-name)$/.test(arg))) return { level: "dev" };
    return command === "curl" ? { level: "read" } : { level: "dev" };
  }
  if (remoteCommands.includes(command))
    return hard(`Conectar em outra máquina: ${line}?`, "Acesso à rede fora da VPS.");
  if (command === "rsync" && args.some((arg) => /^[\w.@-]+:/.test(arg)))
    return hard(`Copiar para outra máquina: ${line}?`, "Acesso à rede fora da VPS.");
  if (systemCommands.includes(command))
    return hard(
      `Mexer no sistema: ${line}?`,
      command.includes("kill") ? "Para parar servidor, use dev_server_stop." : "Comando de sistema.",
    );
  if (command === "docker" || command === "podman") {
    if (
      args.some((arg) =>
        [
          "rm",
          "rmi",
          "stop",
          "kill",
          "prune",
          "down",
          "push",
          "volume",
          "system",
          "exec",
          "run",
          "login",
          "network",
        ].includes(arg),
      )
    )
      return hard(`Mexer nos containers: ${line}?`, "Docker compartilhado da VPS.");
    const sub = args.find((arg) => !arg.startsWith("-")) ?? "";
    return ["ps", "images", "logs", "inspect", "version", "info", "stats", "top", "port", "history"].includes(sub)
      ? { level: "read" }
      : { level: "dev" };
  }
  if (command === "xargs") {
    const inner = xargsInner(args);
    if (inner.length === 0) return { level: "read" };
    return inspect({ ...segment, piped: false }, inner, cwd, workspace, depth + 1);
  }
  for (const output of outputTargets(command, args)) {
    const verdict = pathVerdict(workspace, cwd, output, "Escrever em");
    if (verdict) return verdict;
  }
  if (command === "find") {
    const firstFlag = args.findIndex((arg) => arg.startsWith("-"));
    const roots = args.slice(0, firstFlag === -1 ? args.length : firstFlag);
    if (args.includes("-delete")) {
      for (const root of roots.length > 0 ? roots : ["."]) {
        const verdict = pathVerdict(workspace, cwd, root, "Apagar arquivos em");
        if (verdict) return verdict;
      }
      return { level: "dev" };
    }
    const execs = findExecs(args, roots);
    for (const inner of execs) {
      const verdict =
        inner[0] === "git"
          ? gitVerdict(inner, workspace, true)
          : inspect({ ...segment, piped: false }, inner, cwd, workspace, depth + 1);
      if ("kind" in verdict) return verdict;
    }
    return execs.length > 0 ? { level: "dev" } : { level: "read" };
  }
  if (fileCommands.includes(command)) {
    const targets = args.filter((arg) => !arg.startsWith("-"));
    const checked =
      command === "cp" || command === "ln" || command === "install"
        ? targets.slice(-1)
        : command === "chmod" || command === "chown"
          ? targets.slice(1)
          : command === "patch"
            ? []
            : targets;
    const verb =
      command === "rm" || command === "rmdir" || command === "unlink"
        ? "Apagar"
        : command === "chmod" || command === "chown"
          ? "Mudar permissão de"
          : "Escrever em";
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
    if (command === "ln") {
      const verdict = linkVerdict(workspace, cwd, args);
      if (verdict) return verdict;
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
  if (["sed", "awk", "gawk", "mawk"].includes(command)) return { level: "unknown", key: command };
  if (interpreters.has(command)) {
    const script = shells.has(command) ? shellScript(args) : null;
    if (script !== null) {
      const inner = gateCommand(script, workspace, depth + 1);
      if (inner.kind !== "allow") return inner as Verdict;
      return { level: "unknown", key: `${command} -c` };
    }
    const inline = args.findIndex(
      (arg) => arg === "-c" || arg === "-lc" || arg === "-e" || arg === "--eval" || arg === "-p",
    );
    if (inline >= 0 && shells.has(command)) return { level: "unknown", key: `${command} -c` };
    if (inline >= 0) return { level: "unknown", key: `${command} ${args[inline]}` };
    return { level: "dev" };
  }
  if (readOnlyCommands.has(command)) return { level: "read" };
  if (
    devCommands.has(command) ||
    command.startsWith("./node_modules/.bin/") ||
    command.startsWith("node_modules/.bin/")
  )
    return { level: "dev" };
  if (command.startsWith("./") || command.startsWith("/")) {
    const path = resolve(cwd, command);
    if (inWorkspace(workspace, resolveReal(path).real) && !protectedPath(path))
      return { level: "unknown", key: relative(workspace.path, path) };
    return hard(`Rodar ${shownPath(workspace, path)}?`, "Programa fora da tarefa.");
  }
  return { level: "unknown", key: [command, args.find((arg) => !arg.startsWith("-"))].filter(Boolean).join(" ") };
}

function argPath(arg: string) {
  const value = arg.startsWith("-") ? (arg.match(/^--?[\w-]+=(.+)$/)?.[1] ?? null) : arg;
  if (value === null || !value || value.includes("$")) return null;
  if (/^file:\/\//i.test(value)) {
    try {
      return decodeURIComponent(value.replace(/^file:\/\/[^/]*/i, "")) || "/";
    } catch {
      return value.replace(/^file:\/\/[^/]*/i, "") || "/";
    }
  }
  if (value.includes("://")) return null;
  return value;
}

function argsGate(workspace: WorkspaceState, cwd: string, args: string[]): Gate | null {
  for (const arg of args) {
    const path = argPath(arg);
    if (path === null) continue;
    if (/[*?[\]]/.test(path) && /^(\/|~|\.\.)/.test(path)) {
      const expanded = expand(path);
      const fixed = expanded.slice(0, expanded.search(/[*?[\]]/));
      const dir = resolve(cwd, fixed.endsWith("/") ? fixed : dirname(fixed) || ".");
      if (!inWorkspace(workspace, dir) || !inWorkspace(workspace, resolveReal(dir).real))
        return {
          kind: "deny",
          message: `${short(path, 80)} usa curinga fora da tarefa. Diga o caminho exato, dentro da worktree.`,
        };
      continue;
    }
    const verdict = readVerdict(workspace, path, cwd, false);
    if (verdict) return verdict;
  }
  return null;
}

function humanGate(command: string, reason: string): Gate {
  return { kind: "human", prompt: `Rodar ${short(command, 160)}?`, reason, hard: true };
}

const obfuscationDeny: Gate = {
  kind: "deny",
  message:
    "Comando disfarçado ($'...', chaves {a,b} no nome, barra invertida no nome ou $IFS): reescreva o comando de forma direta.",
};

function cwdAllowed(workspace: WorkspaceState, path: string) {
  const { real } = resolveReal(path);
  if (blocked(path) || blocked(real)) return false;
  return (inWorkspace(workspace, path) && inWorkspace(workspace, real)) || within("/tmp", real);
}

function readCwdAllowed(path: string) {
  const { real, exists } = resolveReal(path);
  if (!exists || blocked(path) || blocked(real)) return false;
  return insideAllowedArea(path) && insideAllowedArea(real);
}

function readOnlyRepoDeny(workspace: WorkspaceState, path: string, line: string): Gate {
  return {
    kind: "deny",
    message: `${shownPath(workspace, path)} é um repositório liberado só para leitura fora da tarefa: ${short(line, 80)} mudaria algo nele. Para editar, abra com workspace_open.`,
  };
}

function exportAssignments(tokens: string[]) {
  return ["export", "declare", "typeset", "local", "readonly"].includes(tokens[0] ?? "") ? tokens.slice(1) : [];
}

export function gateCommand(command: string, workspace: WorkspaceState, depth = 0): Gate {
  const trimmed = command.trim();
  if (!trimmed) return { kind: "allow" };
  if (depth > 6) return humanGate(trimmed, "Comando aninhado demais para conferir.");
  let segments: Segment[];
  try {
    segments = parseShell(trimmed);
  } catch (error) {
    return {
      kind: "human",
      prompt: `Não consegui entender este comando com segurança. Posso rodar? ${short(trimmed, 160)}`,
      reason: `Comando que não deu para analisar (${error instanceof Error ? error.message : "erro"}).`,
      hard: true,
    };
  }
  if (segments.some((segment) => segment.background)) {
    return {
      kind: "deny",
      message:
        "Comandos com & não ficam vivos. Para servidor ou watcher, use a ferramenta dev_server_start; para ver a saída, dev_server_logs.",
    };
  }
  let cwd = workspace.path;
  let previous = cwd;
  let readOnlyCwd = false;
  let previousReadOnly = false;
  for (const segment of segments) {
    if (segment.opaque) return humanGate(trimmed, "Não dá para saber o que vai rodar.");
    const unwrapped = unwrap(segment.words);
    const tokens = unwrapped.tokens;
    if ([...unwrapped.assignments, ...exportAssignments(tokens)].some((item) => dangerousAssignment.test(item)))
      return humanGate(trimmed, "Variável de ambiente que muda o que o git ou o shell executam.");
    for (const redirect of segment.redirects) {
      if (redirect.op.includes(">")) {
        const verdict = pathVerdict(workspace, cwd, redirect.target, "Escrever em");
        if (verdict && "kind" in verdict) return verdict as Gate;
      } else if (redirect.op !== "<<<") {
        const path = argPath(redirect.target);
        const verdict = path === null ? null : readVerdict(workspace, path, cwd, true);
        if (verdict) return verdict;
      }
    }
    let segmentCwd = cwd;
    let segmentReadOnly = readOnlyCwd;
    if (unwrapped.chdir !== null) {
      segmentCwd = resolve(cwd, expand(unwrapped.chdir));
      if (unwrapped.chdir.includes("$")) return outsideDeny(workspace, segmentCwd);
      if (cwdAllowed(workspace, segmentCwd)) segmentReadOnly = false;
      else if (readCwdAllowed(segmentCwd)) segmentReadOnly = true;
      else return outsideDeny(workspace, segmentCwd);
    }
    if (tokens[0] === "git") {
      const call = parseGit(tokens.slice(1));
      const dirs = call.globals.filter((_, index) => call.globals[index - 1] === "-C");
      for (const dir of dirs) {
        const target = resolve(segmentCwd, expand(dir));
        if (cwdAllowed(workspace, target)) continue;
        if (!readCwdAllowed(target)) return outsideDeny(workspace, target);
        segmentReadOnly = true;
      }
    }
    if (tokens[0] === "cd" || tokens[0] === "pushd") {
      const target = tokens.slice(1).find((arg) => !/^-[LPe@]+$/.test(arg)) ?? home;
      if (target.includes("$SUB") || target.startsWith("$")) return humanGate(trimmed, "Pasta montada na hora.");
      if (target === "-") {
        [cwd, previous] = [previous, cwd];
        [readOnlyCwd, previousReadOnly] = [previousReadOnly, readOnlyCwd];
        continue;
      }
      const next = resolve(cwd, expand(target));
      const writable = cwdAllowed(workspace, next);
      if (!writable && !readCwdAllowed(next)) return outsideDeny(workspace, next);
      previous = cwd;
      previousReadOnly = readOnlyCwd;
      cwd = next;
      readOnlyCwd = !writable;
      continue;
    }
    const argGate = argsGate(workspace, segmentCwd, tokens.slice(1));
    if (argGate) return argGate;
    const verdict = inspect(segment, tokens, segmentCwd, workspace, depth);
    if (segment.obfuscated && !("level" in verdict && verdict.level === "read")) return obfuscationDeny;
    if ("kind" in verdict) return verdict;
    if (segmentReadOnly && (verdict.level !== "read" || !readShape(tokens)))
      return readOnlyRepoDeny(workspace, segmentCwd, tokens.join(" "));
  }
  return { kind: "allow" };
}

const curlReadFlags =
  /^(-[sSiILvfk]+|--silent|--show-error|--head|--include|--location|--fail|--verbose|--insecure|--compressed|--max-time|-m|--connect-timeout|-H|--header|-w|--write-out|-A|--user-agent)$/;
const curlValueFlags = new Set([
  "--max-time",
  "-m",
  "--connect-timeout",
  "-H",
  "--header",
  "-w",
  "--write-out",
  "-A",
  "--user-agent",
]);

function readShape(tokens: string[]): boolean {
  const [command, ...args] = tokens;
  if (command === "git") {
    const call = parseGit(args);
    if (call.configs.length > 0 || call.configEnv) return false;
    if (call.globals.some((arg) => /^(-p|--paginate|--exec-path|--git-dir|--work-tree|--namespace)(=|$)/.test(arg)))
      return false;
    if (
      call.args.some((arg) =>
        /^(--output|-O|--open-files-in-pager|--exec|--ext-diff|--textconv|--filters|--upload-pack|--receive-pack|-w|--web|-i|--info|-m|--man)(=|$)|^-O.+/.test(
          arg,
        ),
      )
    )
      return false;
    return gitReadSubcommands.has(call.sub);
  }
  if (command === "find")
    return !args.some((arg) =>
      ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(arg),
    );
  if (command === "sort")
    return !args.some((arg) => /^--(output|compress-program)(=|$)/.test(arg) || /^-[a-zA-Z]*o/.test(arg));
  if (command === "tree") return !args.some((arg) => /^-[a-zA-Z]*o/.test(arg) || arg === "--output");
  if (command === "uniq") return args.filter((arg) => !arg.startsWith("-")).length <= 1;
  if (command === "printf") return !args.includes("-v");
  if (command === "date") return !args.some((arg) => /^(-[a-zA-Z]*s|--set)/.test(arg));
  if (command === "hostname") return args.every((arg) => arg.startsWith("-"));
  if (command === "rg") return !args.some((arg) => /^--pre(=|$)/.test(arg));
  if (command === "fd") return !args.some((arg) => /^(-x|-X|--exec|--exec-batch)(=|$)/.test(arg));
  if (command === "yq") return !args.some((arg) => /^(-i|--inplace)(=|$)/.test(arg));
  if (command === "export" || command === "env") return false;
  if (command === "unset" || command === "test" || command === "[") return !args.some((arg) => arg.includes("["));
  if (command === "curl") {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (!arg.startsWith("-")) continue;
      if (!curlReadFlags.test(arg)) return false;
      if (curlValueFlags.has(arg)) index++;
    }
    return true;
  }
  if (command === "xargs") {
    const inner = xargsInner(args);
    return inner.length === 0 || readShape(inner);
  }
  return true;
}

export function commandIsReadOnly(command: string, workspace: WorkspaceState, depth = 0): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  if (depth > 6) return false;
  let segments: Segment[];
  try {
    segments = parseShell(trimmed);
  } catch {
    return false;
  }
  let cwd = workspace.path;
  for (const segment of segments) {
    if (segment.background || segment.dynamic || segment.opaque || segment.obfuscated) return false;
    if (
      segment.redirects.some(
        (redirect) => redirect.op.includes(">") && redirect.target !== "/dev/null" && !/^&\d$/.test(redirect.target),
      )
    )
      return false;
    if (segment.redirects.some((redirect) => redirect.op === "<<<" || redirect.op.includes("<"))) {
      for (const redirect of segment.redirects) {
        if (redirect.op === "<<<" || !redirect.op.includes("<")) continue;
        if (readVerdict(workspace, redirect.target, cwd, true)) return false;
      }
    }
    const unwrapped = unwrap(segment.words);
    if (unwrapped.assignments.length > 0 || unwrapped.env || unwrapped.chdir !== null) return false;
    const tokens = unwrapped.tokens;
    if (tokens[0] === "cd" || tokens[0] === "pushd") {
      const next = resolve(cwd, expand(tokens.slice(1).find((arg) => !/^-[LPe@]+$/.test(arg)) ?? home));
      if (!cwdAllowed(workspace, next) && !readCwdAllowed(next)) return false;
      cwd = next;
      continue;
    }
    if (argsGate(workspace, cwd, tokens.slice(1))) return false;
    if (shells.has(tokens[0] ?? "")) {
      const script = shellScript(tokens.slice(1));
      if (script !== null) {
        if (!commandIsReadOnly(script, workspace, depth + 1)) return false;
        continue;
      }
    }
    const verdict = inspect(segment, tokens, cwd, workspace, depth);
    if ("kind" in verdict || verdict.level !== "read") return false;
    if (!readShape(tokens)) return false;
  }
  return true;
}

interface CommandList {
  tokens: string[];
  indirect: boolean;
}

function commandLists(command: string, depth: number): CommandList[] | null {
  if (depth > 6) return null;
  let segments: Segment[];
  try {
    segments = parseShell(command.trim());
  } catch {
    return null;
  }
  const lists: CommandList[] = [];
  const visit = (tokens: string[], indirect: boolean): boolean => {
    if (tokens.length === 0) return true;
    lists.push({ tokens, indirect });
    const [head, ...args] = tokens;
    if (shells.has(head)) {
      const script = shellScript(args);
      if (script !== null) {
        const inner = commandLists(script, depth + 1);
        if (!inner) return false;
        lists.push(...inner.map((item) => ({ ...item, indirect: item.indirect || indirect })));
      }
    }
    if (head === "xargs" && !visit(xargsInner(args), true)) return false;
    if (head === "find") {
      const firstFlag = args.findIndex((arg) => arg.startsWith("-"));
      for (const inner of findExecs(args, args.slice(0, firstFlag === -1 ? args.length : firstFlag)))
        if (!visit(inner, true)) return false;
    }
    if (head !== "git" && head !== "xargs") {
      const embedded = args.indexOf("git");
      if (embedded >= 0) lists.push({ tokens: args.slice(embedded), indirect: true });
    }
    return true;
  };
  for (const segment of segments) if (!visit(unwrap(segment.words).tokens, false)) return null;
  return lists;
}

export function fixedRuleViolation(command: string, workspace: WorkspaceState): string | null {
  const lists = commandLists(command, 0);
  if (!lists)
    return /\bpush\b/.test(command) && /(\s-[a-zA-Z]*f|--force|--mirror|\s\+)/.test(command)
      ? "push --force num comando que não dá para conferir é proibido pelas regras fixas da pessoa, em qualquer modo."
      : null;
  for (const { tokens, indirect } of lists) {
    if (tokens[0] !== "git") continue;
    const call = parseGit(tokens.slice(1));
    if (call.sub !== "push" && call.sub !== "send-pack") continue;
    const refs = pushRefs(call.args);
    const forced =
      call.sub === "send-pack" ||
      call.args.some((arg) => pushForce.test(arg)) ||
      refs.some((ref) => ref.startsWith("+") || ref.startsWith(":") || ref.includes(":+")) ||
      unsafeGitConfig(call);
    if (!forced) continue;
    if (indirect || unsafeGitConfig(call) || refs.some(unknownRef))
      return "push --force para um destino que não dá para conferir é proibido pelas regras fixas da pessoa, em qualquer modo.";
    const target = pushTarget(refs, workspace.branch);
    if (target) return `push --force em ${target} é proibido pelas regras fixas da pessoa, em qualquer modo.`;
  }
  return null;
}
