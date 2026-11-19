import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const [port, ticket, encoded] = process.argv.slice(2);
const mask = "••••";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(126);
}

if (!port || !ticket || !encoded) fail("Uso interno do cofre: faltam argumentos.");

let grant;
try {
  const response = await fetch(`http://127.0.0.1:${port}/vault/exec/${encodeURIComponent(ticket)}`, { method: "POST" });
  if (!response.ok) fail("O cofre não liberou o segredo (o tíquete venceu ou já foi usado). Rode o comando de novo.");
  grant = await response.json();
} catch {
  fail("Não consegui falar com o cofre do runelay bots.");
}

const patterns = [...new Set(grant.redact ?? [])].filter((item) => typeof item === "string" && item.length >= 4).sort((a, b) => b.length - a.length);
const keep = Math.max(0, ...patterns.map((item) => item.length)) - 1;
const clean = (text) => patterns.reduce((acc, pattern) => (acc.includes(pattern) ? acc.split(pattern).join(mask) : acc), text);
const command = Buffer.from(encoded, "base64").toString("utf8");

const child = spawn("bash", ["-c", command], { env: { ...process.env, ...grant.env }, stdio: ["inherit", "pipe", "pipe"] });
grant = null;

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
const code = await new Promise((resolve) => child.on("close", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1))));
await streams;
process.exitCode = code;
