import { join } from "node:path";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const UNRELEASED = "## Unreleased";

export function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) throw new Error(`invalid version: ${version}`);
}

function replaceOnce(source: string, pattern: RegExp, replacement: string, label: string): string {
  if (!pattern.test(source)) throw new Error(`${label}: version not found`);
  return source.replace(pattern, replacement);
}

export function bumpPackageJson(source: string, version: string): string {
  return replaceOnce(source, /("version":\s*")[^"]*(")/, `$1${version}$2`, "package.json");
}

export function bumpLockfile(source: string, version: string, names: string[]): string {
  return names.reduce((lock, name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const pattern = new RegExp(`("name":\\s*"${escaped}",\\s*"version":\\s*")[^"]*(")`);
    return replaceOnce(lock, pattern, `$1${version}$2`, `bun.lock ${name}`);
  }, source);
}

export function bumpIosProject(source: string, version: string): string {
  return replaceOnce(source, /(CFBundleShortVersionString:\s*")[^"]*(")/, `$1${version}$2`, "project.yml");
}

export function bumpInfoPlist(source: string, version: string): string {
  return replaceOnce(
    source,
    /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${version}$2`,
    "Info.plist",
  );
}

export function releaseChangelog(source: string, version: string): string {
  const heading = `## v${version}`;
  const lines = source.split("\n");
  if (lines.includes(heading)) throw new Error(`CHANGELOG.md already has ${heading}`);
  const start = lines.indexOf(UNRELEASED);
  if (start === -1) throw new Error(`CHANGELOG.md has no ${UNRELEASED}`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const end = next === -1 ? lines.length : next;
  const entries = lines.slice(start + 1, end).join("\n").trim();
  if (entries === "") throw new Error(`${UNRELEASED} is empty`);
  const rest = lines.slice(end).join("\n");
  return [...lines.slice(0, start), UNRELEASED, "", heading, "", entries, "", rest].join("\n").trimEnd().concat("\n");
}

async function workspaceManifests(root: string): Promise<string[]> {
  const manifest = (await Bun.file(join(root, "package.json")).json()) as { workspaces: string[] };
  const found = await Promise.all(
    manifest.workspaces.map((pattern) => Array.fromAsync(new Bun.Glob(`${pattern}/package.json`).scan({ cwd: root }))),
  );
  return ["package.json", ...found.flat().sort()];
}

async function rewrite(path: string, change: (source: string) => string): Promise<void> {
  await Bun.write(path, change(await Bun.file(path).text()));
}

export async function bump(root: string, version: string): Promise<string[]> {
  assertVersion(version);
  const manifests = await workspaceManifests(root);
  const names: string[] = [];
  for (const manifest of manifests) {
    const path = join(root, manifest);
    await rewrite(path, (source) => bumpPackageJson(source, version));
    if (manifest !== "package.json") names.push(((await Bun.file(path).json()) as { name: string }).name);
  }
  await rewrite(join(root, "bun.lock"), (source) => bumpLockfile(source, version, names));
  await rewrite(join(root, "apps/ios/project.yml"), (source) => bumpIosProject(source, version));
  await rewrite(join(root, "apps/ios/Sources/App/Info.plist"), (source) => bumpInfoPlist(source, version));
  await rewrite(join(root, "CHANGELOG.md"), (source) => releaseChangelog(source, version));
  return [...manifests, "bun.lock", "apps/ios/project.yml", "apps/ios/Sources/App/Info.plist", "CHANGELOG.md"];
}

if (import.meta.main) {
  const version = (Bun.argv[2] ?? "").replace(/^v/, "");
  if (!version) throw new Error("usage: bun scripts/release/bump.ts <x.y.z>");
  const root = join(import.meta.dir, "../..");
  for (const file of await bump(root, version)) console.log(file);
}
