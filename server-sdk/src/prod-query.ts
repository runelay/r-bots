import { execFile } from "node:child_process";

const contyApiDir = process.env.CONTY_API_DIR ?? "/home/anderson/projects/conty-dev/conty-api";
const maxOutputChars = 20_000;

function stripSqlNoise(sql: string) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''");
}

const forbidden =
  /\b(insert|update|delete|merge|upsert|truncate|drop|alter|create|grant|revoke|vacuum|reindex|cluster|copy|call|lock|refresh|reset|begin|commit|rollback|savepoint|prepare|execute|deallocate|listen|notify|unlisten|discard)\b/i;

export function assertReadOnlySql(sql: string) {
  const cleaned = stripSqlNoise(sql).trim().replace(/;\s*$/, "").trim();
  if (cleaned.length === 0) throw new Error("Consulta vazia.");
  if (cleaned.includes(";")) throw new Error("Só uma instrução por vez.");
  if (!/^(select|with)\b/i.test(cleaned)) throw new Error("Só SELECT ou WITH são permitidos.");
  const hit = cleaned.match(forbidden);
  if (hit) throw new Error(`Palavra proibida na consulta: ${hit[0]}.`);
  if (/\binto\b/i.test(cleaned)) throw new Error("SELECT INTO não é permitido.");
  if (/\bfor\s+(update|share|no\s+key|key)\b/i.test(cleaned)) throw new Error("Lock de linha não é permitido.");
  if (/\bpg_(terminate|cancel|reload|rotate|sleep|advisory|read_file|write|ls_dir|stat_file)/i.test(cleaned)) {
    throw new Error("Função administrativa não é permitida.");
  }
  if (/\b(lo_\w+|dblink\w*|set_config|nextval|setval)\s*\(/i.test(cleaned)) {
    throw new Error("Função com efeito colateral não é permitida.");
  }
  return sql.trim().replace(/;\s*$/, "");
}

export function runProdQuery(sql: string, signal?: AbortSignal) {
  const statement = assertReadOnlySql(sql);
  return new Promise<{ rows: unknown; truncated: boolean }>((resolve, reject) => {
    execFile(
      "supabase",
      ["db", "query", "--remote", "--read-only", "--output-format", "json", statement],
      { cwd: contyApiDir, timeout: 90_000, maxBuffer: 50 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Falha na consulta: ${(stderr || error.message).slice(0, 2000)}`));
          return;
        }
        const start = stdout.indexOf("{");
        try {
          const parsed = JSON.parse(stdout.slice(start)) as { rows?: unknown };
          const text = JSON.stringify(parsed.rows ?? parsed);
          if (text.length <= maxOutputChars) {
            resolve({ rows: parsed.rows ?? parsed, truncated: false });
            return;
          }
          resolve({ rows: text.slice(0, maxOutputChars), truncated: true });
        } catch {
          resolve({ rows: stdout.slice(0, maxOutputChars), truncated: stdout.length > maxOutputChars });
        }
      },
    );
  });
}
