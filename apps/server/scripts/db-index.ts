import { join } from "node:path";

const dir = join(import.meta.dir, "..", "src", "db", "migrations");
const journal = (await Bun.file(join(dir, "meta", "_journal.json")).json()) as { entries: { tag: string }[] };
const names = journal.entries.map((entry, position) => ({ tag: entry.tag, name: `m${position}` }));
const lines = [
  ...names.map(({ tag, name }) => `import ${name} from "./${tag}.sql" with { type: "file" };`),
  'import journal from "./meta/_journal.json";',
  "",
  "export const migrationFiles: Record<string, string> = {",
  ...names.map(({ tag, name }) => `  "${tag}": ${name},`),
  "};",
  "",
  "export { journal };",
  "",
];
await Bun.write(join(dir, "index.ts"), lines.join("\n"));
