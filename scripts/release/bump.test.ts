import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertVersion,
  bump,
  bumpInfoPlist,
  bumpIosProject,
  bumpLockfile,
  bumpPackageJson,
  releaseChangelog,
} from "./bump";

const changelog = `# Changelog

## Unreleased

### Mac

- New thing.

## v0.1.9

- Old thing.
`;

const lock = `{
  "workspaces": {
    "": {
      "name": "runelay-bots",
    },
    "apps/server": {
      "name": "@runelay-bots/server",
      "version": "0.0.0",
    },
    "packages/runner": {
      "name": "@runelay-bots/runner",
      "version": "0.1.0",
    },
  },
}
`;

const plist = `<dict>
\t<key>CFBundleShortVersionString</key>
\t<string>0.1.0</string>
\t<key>CFBundleVersion</key>
\t<string>1</string>
</dict>
`;

describe("assertVersion", () => {
  test("accepts semver with an optional pre-release", () => {
    expect(() => assertVersion("0.2.0")).not.toThrow();
    expect(() => assertVersion("0.2.0-beta.1")).not.toThrow();
  });

  test("rejects anything else", () => {
    expect(() => assertVersion("v0.2.0")).toThrow("invalid version: v0.2.0");
    expect(() => assertVersion("0.2")).toThrow("invalid version");
  });
});

describe("bumpPackageJson", () => {
  test("replaces the version field", () => {
    expect(bumpPackageJson('{\n  "name": "x",\n  "version": "0.0.0"\n}\n', "0.2.0")).toBe(
      '{\n  "name": "x",\n  "version": "0.2.0"\n}\n',
    );
  });

  test("fails without a version field", () => {
    expect(() => bumpPackageJson('{ "name": "x" }', "0.2.0")).toThrow("package.json: version not found");
  });
});

describe("bumpLockfile", () => {
  test("bumps each named workspace and leaves the root alone", () => {
    const bumped = bumpLockfile(lock, "0.2.0", ["@runelay-bots/server", "@runelay-bots/runner"]);
    expect(bumped.match(/"version": "0\.2\.0"/g)).toHaveLength(2);
    expect(bumped).not.toContain('"version": "0.0.0"');
    expect(bumped).toContain('"name": "runelay-bots",\n    },');
  });

  test("fails when a workspace is missing", () => {
    expect(() => bumpLockfile(lock, "0.2.0", ["@runelay-bots/protocol"])).toThrow(
      "bun.lock @runelay-bots/protocol: version not found",
    );
  });
});

describe("iOS version", () => {
  test("bumps project.yml", () => {
    expect(bumpIosProject('        CFBundleShortVersionString: "0.1.0"\n        CFBundleVersion: "1"\n', "0.2.0")).toBe(
      '        CFBundleShortVersionString: "0.2.0"\n        CFBundleVersion: "1"\n',
    );
  });

  test("bumps Info.plist and keeps the build number", () => {
    const bumped = bumpInfoPlist(plist, "0.2.0");
    expect(bumped).toContain("<string>0.2.0</string>");
    expect(bumped).toContain("<string>1</string>");
  });

  test("fails without the key", () => {
    expect(() => bumpIosProject("name: x\n", "0.2.0")).toThrow("project.yml: version not found");
    expect(() => bumpInfoPlist("<dict/>", "0.2.0")).toThrow("Info.plist: version not found");
  });
});

describe("releaseChangelog", () => {
  test("moves Unreleased under the new heading and leaves Unreleased empty", () => {
    expect(releaseChangelog(changelog, "0.2.0")).toBe(`# Changelog

## Unreleased

## v0.2.0

### Mac

- New thing.

## v0.1.9

- Old thing.
`);
  });

  test("works when Unreleased is the last section", () => {
    expect(releaseChangelog("# Changelog\n\n## Unreleased\n\n- First.\n", "0.1.0")).toBe(
      "# Changelog\n\n## Unreleased\n\n## v0.1.0\n\n- First.\n",
    );
  });

  test("refuses an empty Unreleased", () => {
    expect(() => releaseChangelog("# Changelog\n\n## Unreleased\n\n## v0.1.9\n", "0.2.0")).toThrow(
      "## Unreleased is empty",
    );
  });

  test("refuses a version that is already there", () => {
    expect(() => releaseChangelog(changelog, "0.1.9")).toThrow("CHANGELOG.md already has ## v0.1.9");
  });

  test("refuses a changelog without Unreleased", () => {
    expect(() => releaseChangelog("# Changelog\n", "0.2.0")).toThrow("CHANGELOG.md has no ## Unreleased");
  });
});

describe("bump", () => {
  const root = mkdtempSync(join(tmpdir(), "rbots-bump-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("updates every versioned file of the repo", async () => {
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ name: "runelay-bots", version: "0.1.9", workspaces: ["apps/server", "packages/*"] }, null, 2),
    );
    await Bun.write(
      join(root, "apps/server/package.json"),
      JSON.stringify({ name: "@runelay-bots/server", version: "0.0.0" }, null, 2),
    );
    await Bun.write(
      join(root, "packages/runner/package.json"),
      JSON.stringify({ name: "@runelay-bots/runner", version: "0.1.0" }, null, 2),
    );
    await Bun.write(join(root, "bun.lock"), lock);
    await Bun.write(join(root, "apps/ios/project.yml"), '        CFBundleShortVersionString: "0.1.0"\n');
    await Bun.write(join(root, "apps/ios/Sources/App/Info.plist"), plist);
    await Bun.write(join(root, "CHANGELOG.md"), changelog);

    const files = await bump(root, "0.2.0");

    expect(files).toEqual([
      "package.json",
      "apps/server/package.json",
      "packages/runner/package.json",
      "bun.lock",
      "apps/ios/project.yml",
      "apps/ios/Sources/App/Info.plist",
      "CHANGELOG.md",
    ]);
    for (const manifest of files.slice(0, 3)) {
      expect(((await Bun.file(join(root, manifest)).json()) as { version: string }).version).toBe("0.2.0");
    }
    expect(await Bun.file(join(root, "bun.lock")).text()).not.toContain('"version": "0.0.0"');
    expect(await Bun.file(join(root, "apps/ios/project.yml")).text()).toContain('"0.2.0"');
    expect(await Bun.file(join(root, "apps/ios/Sources/App/Info.plist")).text()).toContain("<string>0.2.0</string>");
    expect(await Bun.file(join(root, "CHANGELOG.md")).text()).toContain("## v0.2.0\n\n### Mac");
  });

  test("rejects an invalid version before touching files", async () => {
    await expect(bump(root, "latest")).rejects.toThrow("invalid version: latest");
  });
});
