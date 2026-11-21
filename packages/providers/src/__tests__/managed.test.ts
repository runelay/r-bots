import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clisDir, isManaged, managedBinary, managedClis } from "../managed";

const saved = { clis: process.env.RBOTS_CLIS_DIR, data: process.env.BOTS_DATA_DIR };
const scratch = mkdtempSync(join(tmpdir(), "rb-managed-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

afterEach(() => {
  process.env.RBOTS_CLIS_DIR = saved.clis;
  if (saved.data === undefined) delete process.env.BOTS_DATA_DIR;
  else process.env.BOTS_DATA_DIR = saved.data;
});

function install(dir: string, provider: "claude" | "codex", version: string) {
  const bin = join(dir, provider, version, "bin");
  mkdirSync(bin, { recursive: true });
  const file = join(bin, managedClis[provider].bin);
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o755);
  symlinkSync(version, join(dir, provider, "current"));
  return join(dir, provider, "current", "bin", managedClis[provider].bin);
}

describe("managed clis", () => {
  test("clisDir prefers RBOTS_CLIS_DIR, then the data dir, then /data/clis", () => {
    process.env.RBOTS_CLIS_DIR = " /srv/clis ";
    expect(clisDir()).toBe("/srv/clis");
    delete process.env.RBOTS_CLIS_DIR;
    process.env.BOTS_DATA_DIR = "/var/rbots";
    expect(clisDir()).toBe("/var/rbots/clis");
    delete process.env.BOTS_DATA_DIR;
    expect(clisDir()).toBe("/data/clis");
  });

  test("only claude and codex are managed", () => {
    expect(isManaged("claude")).toBe(true);
    expect(isManaged("codex")).toBe(true);
    expect(isManaged("cursor")).toBe(false);
    expect(isManaged("toString")).toBe(false);
    expect(managedBinary("grok", scratch)).toBeNull();
  });

  test("resolves current/bin/<bin> when it exists and null otherwise", () => {
    const dir = join(scratch, "resolve");
    expect(managedBinary("claude", dir)).toBeNull();
    const claude = install(dir, "claude", "2.1.330");
    expect(managedBinary("claude", dir)).toBe(claude);
    expect(managedBinary("codex", dir)).toBeNull();
    process.env.RBOTS_CLIS_DIR = dir;
    expect(managedBinary("claude")).toBe(claude);
    rmSync(join(dir, "claude", "2.1.330"), { recursive: true, force: true });
    expect(managedBinary("claude", dir)).toBeNull();
  });
});
