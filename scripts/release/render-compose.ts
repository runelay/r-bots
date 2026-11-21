const DEV_DEFAULT = "${RBOTS_VERSION:-dev}";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const BUILD_KEY = /^(\s*)build:(?:\s.*)?$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlank(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function stripBuildKeys(source: string): string {
  const lines = source.split("\n");
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    const match = BUILD_KEY.exec(line);
    if (!match) {
      kept.push(line);
      index += 1;
      continue;
    }
    const keyIndent = (match[1] as string).length;
    let end = index + 1;
    let lastNested = index;
    while (end < lines.length) {
      const next = lines[end] as string;
      if (isBlank(next)) {
        end += 1;
        continue;
      }
      if (indentOf(next) <= keyIndent) break;
      lastNested = end;
      end += 1;
    }
    index = lastNested + 1;
  }
  return kept.join("\n");
}

function findBuildKeys(node: unknown, path: string[] = []): string[] {
  if (Array.isArray(node)) return node.flatMap((item, position) => findBuildKeys(item, [...path, String(position)]));
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => {
    const here = [...path, key];
    const nested = findBuildKeys(value, here);
    return key === "build" ? [here.join("."), ...nested] : nested;
  });
}

export function renderCompose(source: string, version: string): string {
  if (!VERSION_PATTERN.test(version)) throw new Error(`invalid version: ${version}`);
  if (!source.includes(DEV_DEFAULT)) throw new Error(`compose has no ${DEV_DEFAULT}`);
  const rendered = stripBuildKeys(source).replaceAll(DEV_DEFAULT, `\${RBOTS_VERSION:-${version}}`);
  const leftovers = findBuildKeys(Bun.YAML.parse(rendered));
  if (leftovers.length > 0) throw new Error(`build keys left: ${leftovers.join(", ")}`);
  return rendered;
}

async function main(args: string[]): Promise<void> {
  const [sourcePath, targetPath, version] = args;
  if (!sourcePath || !targetPath || !version) {
    throw new Error("usage: bun scripts/release/render-compose.ts <compose.yaml> <output> <version>");
  }
  const source = await Bun.file(sourcePath).text();
  await Bun.write(targetPath, renderCompose(source, version));
}

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}
