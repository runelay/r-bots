import { VaultError } from "./vault.service";

export type Part = { text: string } | { secret: string };
export type Word = Part[];

export interface ParsedCommand {
  assignments: { name: string; value: Word }[];
  words: Word[];
}

export interface CommandPlan {
  binary: "curl" | "gh" | "git";
  secrets: string[];
  urls: URL[];
  implicitHosts: string[];
  parsed: ParsedCommand;
}

export interface CommandSpec {
  argv: string[];
  env: Record<string, string>;
  stdin: string | null;
  tempHome: boolean;
}

const secretRef = /segredo:([a-z0-9][a-z0-9_-]{0,63})/g;
const forbiddenBare = new Set(["|", "&", ";", "<", ">", "(", ")", "`", "\n", "\r"]);

function reject(message: string): never {
  throw new VaultError("unsafe_command", message);
}

function pushText(word: Word, text: string) {
  const last = word.at(-1);
  if (last && "text" in last) last.text += text;
  else word.push({ text });
}

function readVariable(command: string, start: number, byEnv: Map<string, string>, word: Word) {
  const braced = command[start + 1] === "{";
  const match = braced
    ? /^\{([A-Z0-9_]+)\}/.exec(command.slice(start + 1))
    : /^([A-Za-z0-9_]+)/.exec(command.slice(start + 1));
  const name = match ? match[1] : null;
  const secret = name ? byEnv.get(name) : undefined;
  if (!match || !secret)
    reject(
      "No comando com segredo só vale $SEGREDO_NOME ou ${SEGREDO_NOME} puro: sem outras variáveis, recortes como ${X:0:4} ou substituições.",
    );
  word.push({ secret });
  return start + 1 + match[0].length;
}

function splitRefs(word: Word): Word {
  const out: Word = [];
  for (const part of word) {
    if ("secret" in part) {
      out.push(part);
      continue;
    }
    let last = 0;
    for (const match of part.text.matchAll(secretRef)) {
      const index = match.index ?? 0;
      if (index > last) pushText(out, part.text.slice(last, index));
      out.push({ secret: match[1] });
      last = index + match[0].length;
    }
    if (last < part.text.length) pushText(out, part.text.slice(last));
  }
  return out;
}

export function parseSecretCommand(command: string, byEnv: Map<string, string>): ParsedCommand {
  const words: Word[] = [];
  let word: Word | null = null;
  let i = 0;
  const current = () => {
    if (!word) word = [];
    return word;
  };
  while (i < command.length) {
    const char = command[i];
    if (char === " " || char === "\t") {
      if (word) words.push(word);
      word = null;
      i++;
      continue;
    }
    if (forbiddenBare.has(char) || (char === "#" && !word) || (char === "$" && command[i + 1] === "("))
      reject(
        "No comando com segredo não vale pipe, redirecionamento, subshell, ; && || nem várias linhas. Rode um único programa (curl, gh ou git) com os argumentos.",
      );
    if (char === "\\") {
      if (i + 1 >= command.length) reject("O comando termina com uma barra solta.");
      pushText(current(), command[i + 1]);
      i += 2;
      continue;
    }
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) reject("Aspas simples sem fechar no comando.");
      pushText(current(), command.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (char === '"') {
      const target = current();
      target.push({ text: "" });
      i++;
      while (i < command.length && command[i] !== '"') {
        const inner = command[i];
        if (inner === "`" || (inner === "$" && command[i + 1] === "("))
          reject("Substituição de comando não vale em comando com segredo.");
        if (inner === "\\" && i + 1 < command.length && '$`"\\'.includes(command[i + 1])) {
          pushText(target, command[i + 1]);
          i += 2;
          continue;
        }
        if (inner === "$") {
          i = readVariable(command, i, byEnv, target);
          continue;
        }
        pushText(target, inner);
        i++;
      }
      if (i >= command.length) reject("Aspas duplas sem fechar no comando.");
      i++;
      continue;
    }
    if (char === "$") {
      i = readVariable(command, i, byEnv, current());
      continue;
    }
    pushText(current(), char);
    i++;
  }
  if (word) words.push(word);
  const cleaned = words.map(splitRefs).map((item) => item.filter((part) => !("text" in part) || part.text !== ""));
  const assignments: ParsedCommand["assignments"] = [];
  while (cleaned.length > 0) {
    const first = cleaned[0][0];
    const match = first && "text" in first ? /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(first.text) : null;
    if (!match) break;
    const value: Word = [{ text: (first as { text: string }).text.slice(match[0].length) }, ...cleaned[0].slice(1)];
    assignments.push({ name: match[1], value: value.filter((part) => !("text" in part) || part.text !== "") });
    cleaned.shift();
  }
  return { assignments, words: cleaned.map((item) => (item.length === 0 ? [{ text: "" }] : item)) };
}

export function wordText(word: Word) {
  return word.map((part) => ("text" in part ? part.text : `segredo:${part.secret}`)).join("");
}

function secretsIn(word: Word) {
  return word.flatMap((part) => ("secret" in part ? [part.secret] : []));
}

function plainOf(word: Word, what: string) {
  if (secretsIn(word).length > 0) reject(`O segredo não pode ir em ${what}.`);
  return wordText(word);
}

function parseUrl(text: string) {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return reject(`“${text.slice(0, 80)}” não é uma URL completa. Escreva https://site/caminho.`);
  }
  if (url.protocol !== "https:") reject("Segredo só vai por https. Use https:// na URL.");
  if (url.username || url.password) reject("Não coloque usuário ou senha dentro da URL.");
  return url;
}

const curlValueShort = new Map([
  ["H", "header"],
  ["d", "data"],
  ["X", "request"],
  ["o", "output"],
  ["u", "user"],
  ["A", "user-agent"],
  ["e", "referer"],
  ["b", "cookie"],
  ["c", "cookie-jar"],
  ["F", "form"],
  ["m", "max-time"],
  ["w", "write-out"],
  ["T", "upload-file"],
  ["r", "range"],
  ["D", "dump-header"],
  ["z", "time-cond"],
  ["Y", "speed-limit"],
  ["y", "speed-time"],
]);
const curlFlagShort = new Set(["s", "S", "f", "i", "I", "G", "v", "N", "g", "#", "O", "4", "6", "n"]);
const curlValueLong = new Set([
  "header",
  "data",
  "data-raw",
  "data-binary",
  "data-ascii",
  "data-urlencode",
  "json",
  "request",
  "output",
  "user",
  "user-agent",
  "referer",
  "cookie",
  "cookie-jar",
  "form",
  "form-string",
  "max-time",
  "connect-timeout",
  "write-out",
  "oauth2-bearer",
  "upload-file",
  "retry",
  "retry-delay",
  "retry-max-time",
  "range",
  "url",
  "url-query",
  "dump-header",
  "output-dir",
  "time-cond",
  "limit-rate",
  "max-filesize",
  "speed-limit",
  "speed-time",
]);
const curlFlagLong = new Set([
  "silent",
  "show-error",
  "fail",
  "fail-with-body",
  "include",
  "head",
  "get",
  "compressed",
  "verbose",
  "no-buffer",
  "globoff",
  "progress-bar",
  "remote-name",
  "http1.0",
  "http1.1",
  "http2",
  "create-dirs",
  "no-progress-meter",
  "ipv4",
  "ipv6",
  "netrc",
]);
const curlConfigOptions = new Set([
  "header",
  "user",
  "oauth2-bearer",
  "data",
  "data-raw",
  "data-binary",
  "data-ascii",
  "data-urlencode",
  "json",
  "form",
  "form-string",
  "cookie",
  "url",
  "url-query",
]);

interface CurlArg {
  option: string | null;
  value: Word | null;
}

function curlArgs(words: Word[]) {
  const out: CurlArg[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const head = word[0];
    const text = head && "text" in head ? head.text : "";
    const takeValue = (option: string) => {
      const next = words[i + 1];
      if (!next) reject(`A opção --${option} do curl precisa de um valor.`);
      i++;
      return next;
    };
    if (text.startsWith("--") && text.length > 2) {
      const option = plainOf(word, "o nome de uma opção");
      const name = option.slice(2);
      if (curlValueLong.has(name)) out.push({ option: name, value: takeValue(name) });
      else if (curlFlagLong.has(name)) out.push({ option: name, value: null });
      else
        reject(
          `A opção ${option} do curl não é permitida com segredo (proxy, resolve, config, redirecionamento, trace e parecidas ficam de fora).`,
        );
      continue;
    }
    if (text.startsWith("-") && text.length > 1) {
      const option = plainOf([word[0]], "o nome de uma opção");
      const letters = option.slice(1);
      let j = 0;
      for (; j < letters.length; j++) {
        const letter = letters[j];
        if (curlFlagShort.has(letter)) {
          out.push({ option: letter, value: null });
          continue;
        }
        const long = curlValueShort.get(letter);
        if (!long) reject(`A opção -${letter} do curl não é permitida com segredo.`);
        const rest = letters.slice(j + 1);
        const inline: Word = [...(rest ? [{ text: rest }] : []), ...word.slice(1)];
        out.push({ option: long, value: inline.length > 0 ? inline : takeValue(long) });
        break;
      }
      if (j === letters.length && word.length > 1) reject("Opção do curl misturada com segredo.");
      continue;
    }
    out.push({ option: null, value: word });
  }
  return out;
}

function quoteConfig(value: string) {
  if (/[\r\n\0]/.test(value)) reject("Valor com quebra de linha não vale em comando com segredo.");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t")}"`;
}

function planCurl(parsed: ParsedCommand) {
  if (parsed.assignments.length > 0)
    reject("No curl, coloque o segredo num cabeçalho (-H), não numa variável antes do comando.");
  const urls: URL[] = [];
  for (const arg of curlArgs(parsed.words.slice(1))) {
    const value = arg.value ?? [];
    const secret = secretsIn(value).length > 0;
    if (secret && arg.option !== null && !curlConfigOptions.has(arg.option))
      reject(`O segredo não pode ir na opção --${arg.option} do curl.`);
    if (arg.option === null || arg.option === "url") urls.push(parseUrl(wordText(value)));
    if (arg.option && /^data|^json|^form/.test(arg.option) && wordText(value).startsWith("@-"))
      reject("Ler o corpo da entrada padrão (@-) não vale em comando com segredo.");
  }
  if (urls.length === 0) reject("Escreva a URL completa (https://…) no comando do curl.");
  return { urls, implicitHosts: [] as string[] };
}

const ghSubcommands = new Set([
  "api",
  "repo",
  "pr",
  "issue",
  "release",
  "run",
  "workflow",
  "search",
  "label",
  "gist",
  "cache",
  "project",
  "status",
  "variable",
  "secret",
]);
const tokenAssignments = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

function planGh(parsed: ParsedCommand) {
  for (const assignment of parsed.assignments)
    if (!tokenAssignments.has(assignment.name))
      reject(`Antes do gh só vale GH_TOKEN=… ou GITHUB_TOKEN=…, não ${assignment.name}.`);
  const sub = parsed.words[1] ? plainOf(parsed.words[1], "o subcomando") : "";
  if (!ghSubcommands.has(sub)) reject(`O subcomando gh ${sub || "(vazio)"} não é permitido com segredo.`);
  const urls: URL[] = [];
  const implicitHosts = ["github.com"];
  const args = parsed.words.slice(2).map((word) => plainOf(word, "um argumento do gh (use GH_TOKEN=$SEGREDO_X gh …)"));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.includes("://")) urls.push(parseUrl(arg));
    const host = /^--hostname=(.+)$/.exec(arg)?.[1] ?? (arg === "--hostname" ? args[i + 1] : null);
    if (host !== null) implicitHosts.push(host ?? "");
    const repo = /^--repo=(.+)$/.exec(arg)?.[1] ?? (arg === "--repo" || arg === "-R" ? args[i + 1] : null);
    const segments = repo?.split("/") ?? [];
    if (segments.length >= 3) implicitHosts.push(segments[0]);
  }
  return { urls, implicitHosts };
}

const gitSubcommands = new Set(["clone", "fetch", "push", "ls-remote"]);

function planGit(parsed: ParsedCommand) {
  if (parsed.assignments.length > 0) reject("Antes do git não vale variável. Use git -c http.extraHeader=… URL.");
  const urls: URL[] = [];
  let i = 1;
  for (; i < parsed.words.length; i++) {
    const head = parsed.words[i][0];
    const text = head && "text" in head ? head.text : "";
    if (text === "-c") {
      const value = parsed.words[i + 1];
      if (!value) reject("git -c precisa de um valor.");
      const key = wordText(value).split("=")[0].toLowerCase();
      if (key !== "http.extraheader") reject(`git -c ${key} não é permitido com segredo; só http.extraHeader.`);
      i++;
      continue;
    }
    if (secretsIn(parsed.words[i]).length > 0) reject("No git, o segredo só pode ir em -c http.extraHeader=….");
    if (text.startsWith("-")) reject(`A opção ${text} do git não é permitida antes do subcomando.`);
    break;
  }
  const sub = parsed.words[i] ? wordText(parsed.words[i]) : "";
  if (!gitSubcommands.has(sub)) reject(`O subcomando git ${sub || "(vazio)"} não é permitido com segredo.`);
  for (const word of parsed.words.slice(i + 1)) {
    const arg = plainOf(word, "um argumento do git (use git -c http.extraHeader=…)");
    if (/^--(upload-pack|receive-pack|exec|config|template|separate-git-dir)\b/.test(arg) || arg === "-u")
      reject(`A opção ${arg} do git não é permitida com segredo.`);
    if (arg.includes("://")) urls.push(parseUrl(arg));
    else if (/^[^/\s]+@[^/\s]+:/.test(arg)) reject("Com segredo, o git só fala https. Use https://host/dono/repo.git.");
  }
  if (urls.length === 0) reject("Escreva a URL https completa do repositório no comando do git.");
  return { urls, implicitHosts: [] as string[] };
}

export function planSecretCommand(parsed: ParsedCommand): CommandPlan {
  const binaryWord = parsed.words[0];
  if (!binaryWord) reject("Comando vazio.");
  const binary = plainOf(binaryWord, "o nome do programa");
  if (binary !== "curl" && binary !== "gh" && binary !== "git")
    reject(
      `Com segredo só dá para rodar curl, gh ou git direto (sem caminho, sem bash -c, env ou sudo), não “${binary.slice(0, 40)}”.`,
    );
  const planned = binary === "curl" ? planCurl(parsed) : binary === "gh" ? planGh(parsed) : planGit(parsed);
  const secrets = [
    ...new Set([
      ...parsed.assignments.flatMap((assignment) => secretsIn(assignment.value)),
      ...parsed.words.flatMap(secretsIn),
    ]),
  ];
  return { binary, secrets, parsed, ...planned };
}

function fill(word: Word, values: Map<string, string>) {
  return word.map((part) => ("text" in part ? part.text : (values.get(part.secret) ?? ""))).join("");
}

const pinnedGitConfig: [string, string][] = [
  ["http.proxy", ""],
  ["http.sslVerify", "true"],
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.askPass", ""],
  ["credential.helper", ""],
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  ["protocol.allow", "never"],
  ["protocol.https.allow", "always"],
];

export function buildCommandSpec(plan: CommandPlan, values: Map<string, string>): CommandSpec {
  const env: Record<string, string> = {};
  for (const assignment of plan.parsed.assignments) env[assignment.name] = fill(assignment.value, values);
  if (plan.binary === "curl") {
    const argv = ["curl", "--disable"];
    const config: string[] = [];
    for (const arg of curlArgs(plan.parsed.words.slice(1))) {
      const value = arg.value ?? [];
      const secret = secretsIn(value).length > 0;
      const option = arg.option ?? "url";
      if (secret) config.push(`${option} = ${quoteConfig(fill(value, values))}`);
      else if (arg.option === null) argv.push(wordText(value));
      else
        argv.push(
          arg.option.length === 1 ? `-${arg.option}` : `--${arg.option}`,
          ...(arg.value ? [wordText(value)] : []),
        );
    }
    if (config.length) argv.push("--config", "-");
    return { argv, env, stdin: config.length ? `${config.join("\n")}\n` : null, tempHome: false };
  }
  if (plan.binary === "gh") {
    return {
      argv: plan.parsed.words.map(wordText),
      env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1" },
      stdin: null,
      tempHome: true,
    };
  }
  const argv = ["git"];
  const config: [string, string][] = [...pinnedGitConfig];
  const words = plan.parsed.words;
  for (let i = 1; i < words.length; i++) {
    if (wordText([words[i][0] ?? { text: "" }]) === "-c") {
      const raw = fill(words[i + 1], values);
      const header = raw.slice(raw.indexOf("=") + 1);
      for (const url of plan.urls) config.push([`http.${url.origin}/.extraHeader`, header]);
      i++;
      continue;
    }
    argv.push(...words.slice(i).map(wordText));
    break;
  }
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(config.length);
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return { argv, env, stdin: null, tempHome: false };
}
