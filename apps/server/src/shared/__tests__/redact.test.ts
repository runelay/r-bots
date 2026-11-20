import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import {
  forgetSecretValue,
  installConsoleRedaction,
  minSecretLength,
  redactText,
  rememberSecretValue,
  variantsOf,
} from "../redact";

afterEach(() => {
  for (const key of ["runner", "integration:x", "plain", "pinned"]) forgetSecretValue(key);
  setSystemTime();
});

describe("redact hardening", () => {
  test("variants cover hex, base64 at every alignment and url encodings", () => {
    const value = "sk live/é+1";
    const bytes = Buffer.from(value);
    const variants = variantsOf(value);
    expect(variants).toContain(bytes.toString("hex"));
    expect(variants).toContain(bytes.toString("hex").toUpperCase());
    expect(variants).toContain(encodeURIComponent(value).replace(/%20/g, "+"));
    expect(variants).toContain(encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (item) => item.toLowerCase()));
    expect(variants).toContain(encodeURI(value));
    for (const prefix of ["", "a", "ab", "abc"]) {
      const encoded = Buffer.from(`${prefix}${value}!`).toString("base64");
      expect([prefix, redactWith(value, `x${encoded}x`)]).toEqual([prefix, expect.stringContaining("••••")]);
    }
    expect(minSecretLength).toBe(4);
  });

  test("static secrets stay masked past the ttl, others expire", () => {
    const now = Date.now();
    rememberSecretValue("runner", "runner-token-value");
    rememberSecretValue("integration:x", "integration-key-value");
    rememberSecretValue("pinned", "pinned-value-123", { pinned: true });
    rememberSecretValue("plain", "plain-value-123");
    setSystemTime(new Date(now + 31 * 60_000));
    rememberSecretValue("plain", "plain-value-123");
    forgetSecretValue("plain");
    expect(redactText("runner-token-value integration-key-value pinned-value-123 plain-value-123")).toBe(
      "•••• •••• •••• plain-value-123",
    );
  });

  test("installing wraps every console method once", () => {
    installConsoleRedaction();
    const after = consoleMethods();
    installConsoleRedaction();
    expect(consoleMethods()).toEqual(after);
    rememberSecretValue("plain", "in-process-secret");
    console.debug("redacted in process: in-process-secret");
    expect(redactText("in-process-secret")).toBe("••••");
  });

  test("console.log and console.error output is masked in a real process", async () => {
    const script = join(import.meta.dir, "..", "redact.ts");
    const code = [
      `const { installConsoleRedaction, rememberSecretValue } = await import(${JSON.stringify(script)});`,
      "installConsoleRedaction();",
      'console.log("before", "console-secret-1");',
      'rememberSecretValue("x", "console-secret-1");',
      'console.log("plain", "console-secret-1", { nested: "console-secret-1" });',
      'console.error(new Error("boom console-secret-1"));',
      'console.warn(Buffer.from("console-secret-1").toString("hex"));',
      'console.info("%s", "console-secret-1"); console.debug("console-secret-1"); console.trace("console-secret-1");',
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(0);
    expect(stdout).toContain("before console-secret-1");
    const after = stdout.slice(stdout.indexOf("plain"));
    expect(after).toContain("plain ••••");
    expect(after).not.toContain("console-secret-1");
    expect(stderr).toContain("boom ••••");
    expect(stderr).not.toContain("console-secret-1");
    expect(stderr).not.toContain(Buffer.from("console-secret-1").toString("hex"));
  });
});

function consoleMethods() {
  return [console.log, console.info, console.warn, console.error, console.debug, console.trace];
}

function redactWith(value: string, text: string) {
  rememberSecretValue("plain", value);
  try {
    return redactText(text);
  } finally {
    forgetSecretValue("plain");
  }
}
