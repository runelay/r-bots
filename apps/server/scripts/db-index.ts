import { join } from "node:path";

const dir = join(import.meta.dir, "..", "src", "db", "migrations");
const journal = (await Bun.file(join(dir, "meta", "_journal.json")).json()) as { entries: { tag: string }[] };
const names = journal.entries.map((entry, position) => ({ tag: entry.tag, name: `m${position}` }));
const lines = [
  'import journal from "./meta/_journal.json";',
  ...names.map(({ tag, name }) => `import ${name} from "./${tag}.sql" with { type: "file" };`),
  "",
  "export const migrationFiles: Record<string, string> = {",
  ...names.map(({ tag, name }) => `  "${tag}": ${name},`),
  "};",
  "",
  "export { journal };",
  "",
];
await Bun.write(join(dir, "index.ts"), lines.join("\n"));
