import { run } from "@runelay-bots/providers/proc";

const contyApiDir = process.env.CONTY_API_DIR?.trim();
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

export async function runProdQuery(sql: string, signal?: AbortSignal) {
  if (!contyApiDir)
    throw new Error("Consulta em produção desligada: defina CONTY_API_DIR com o projeto do supabase CLI.");
  const statement = assertReadOnlySql(sql);
  const { code, stdout, stderr } = await run(
    "supabase",
    ["db", "query", "--remote", "--read-only", "--output-format", "json", statement],
    { cwd: contyApiDir, timeoutMs: 90_000, signal },
  );
  if (code !== 0)
    throw new Error(`Falha na consulta: ${(stderr || `supabase saiu com código ${code}`).slice(0, 2000)}`);
  const start = stdout.indexOf("{");
  try {
    const parsed = JSON.parse(stdout.slice(start)) as { rows?: unknown };
    const text = JSON.stringify(parsed.rows ?? parsed);
    if (text.length <= maxOutputChars) return { rows: parsed.rows ?? parsed, truncated: false };
    return { rows: text.slice(0, maxOutputChars), truncated: true };
  } catch {
    return { rows: stdout.slice(0, maxOutputChars), truncated: stdout.length > maxOutputChars };
  }
}
