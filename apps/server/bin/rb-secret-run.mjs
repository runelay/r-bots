import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const [port] = process.argv.slice(2);
const mask = "••••";
const binaries = new Set(["curl", "gh", "git"]);
const keptEnv = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR"];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(126);
}

if (!port || !/^\d{1,5}$/.test(port)) fail("Uso interno do cofre: falta a porta.");

let ticket = "";
try {
  ticket = readFileSync(3, "utf8").trim();
  closeSync(3);
} catch {
  fail("Uso interno do cofre: o tíquete não chegou.");
}
if (!/^[A-Za-z0-9_-]{20,128}$/.test(ticket)) fail("Uso interno do cofre: tíquete inválido.");

let grant;
try {
  const response = await fetch(`http://127.0.0.1:${port}/vault/exec/${ticket}`, { method: "POST" });
  if (!response.ok) fail("O cofre não liberou o segredo (o tíquete venceu ou já foi usado). Rode o comando de novo.");
  grant = await response.json();
} catch {
  fail("Não consegui falar com o cofre do runelay bots.");
}
ticket = "";

const argv = Array.isArray(grant.argv) ? grant.argv.map(String) : [];
if (!binaries.has(argv[0])) fail("O cofre devolveu um programa que não é permitido.");

function locate(name, path) {
  for (const dir of path.split(":")) {
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

const path = typeof grant.path === "string" ? grant.path : "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const binary = locate(argv[0], path);
if (!binary) fail(`Não encontrei o programa ${argv[0]} no servidor.`);

const env = { PATH: path };
for (const key of keptEnv) if (process.env[key]) env[key] = process.env[key];
const home = grant.tempHome ? mkdtempSync(join(tmpdir(), "rb-secret-")) : null;
if (home)
  for (const key of ["GH_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = home;
Object.assign(env, grant.env ?? {});

const patterns = [...new Set(grant.redact ?? [])]
  .filter((item) => typeof item === "string" && item.length >= 4)
  .sort((a, b) => b.length - a.length);
const keep = Math.max(0, ...patterns.map((item) => item.length)) - 1;
const clean = (text) => patterns.reduce((acc, pattern) => (acc.includes(pattern) ? acc.split(pattern).join(mask) : acc), text);
const stdin = typeof grant.stdin === "string" ? grant.stdin : null;
grant = null;

const child = spawn(binary, argv.slice(1), { env, stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"] });
if (stdin !== null) {
  child.stdin.on("error", () => undefined);
  child.stdin.end(stdin);
}

function pipe(stream, out) {
  return new Promise((resolve) => {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer = clean(buffer + decoder.write(chunk));
      if (buffer.length > keep) {
        out.write(buffer.slice(0, buffer.length - keep));
        buffer = buffer.slice(buffer.length - keep);
      }
    });
    stream.on("end", () => {
      buffer = clean(buffer + decoder.end());
      if (buffer) out.write(buffer);
      buffer = "";
      resolve();
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));

const streams = Promise.all([pipe(child.stdout, process.stdout), pipe(child.stderr, process.stderr)]);
const code = await new Promise((resolve) => {
  child.on("error", () => resolve(127));
  child.on("close", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1)));
});
await streams;
if (home) rmSync(home, { recursive: true, force: true });
process.exitCode = code;
