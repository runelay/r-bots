import { describe, expect, test } from "bun:test";
import { backoffDelay, connectUrl, upgradeStatus } from "../backoff";
import { realClock } from "../clock";
import { DockerDemuxer, muxFrame } from "../demux";
import { isBoxSpec, isProviderEvent, isToolGate, isTurnRequest } from "../guards";
import { isRecord, line, parseRecord, readLines, stringMap, stringOf } from "../json";
import { parseMeminfo, readMeminfo } from "../meminfo";
import { bindsOf, insideRoot, rejectedMount, specKey, usableMounts } from "../mounts";
import { boxSpec, tempDir, turnRequest } from "./helpers";

function streamOf(parts: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe("json", () => {
  test("narrows records and strings", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([1])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(parseRecord('{"a":1}')).toEqual({ a: 1 });
    expect(parseRecord("[1]")).toBeNull();
    expect(parseRecord("{nope")).toBeNull();
    expect(stringOf(3, "x")).toBe("x");
    expect(stringOf("y")).toBe("y");
    expect(stringMap({ a: "1", b: 2 })).toEqual({ a: "1" });
    expect(stringMap("no")).toEqual({});
    expect(line({ a: 1 })).toBe('{"a":1}\n');
  });

  test("splits a byte stream into trimmed non-empty lines", async () => {
    const lines: string[] = [];
    for await (const item of readLines(streamOf(['{"a"', ":1}\n\n  b  \n", "tail"]))) lines.push(item);
    expect(lines).toEqual(['{"a":1}', "b", "tail"]);
  });
});

describe("demux", () => {
  test("decodes docker multiplexed frames across chunk boundaries", () => {
    const seen: Array<[string, string]> = [];
    const demuxer = new DockerDemuxer((kind, chunk) => seen.push([kind, new TextDecoder().decode(chunk)]));
    const out = muxFrame(1, new TextEncoder().encode("hello"));
    const err = muxFrame(2, new TextEncoder().encode("oops"));
    const stdin = muxFrame(1, new TextEncoder().encode("x"));
    stdin[0] = 0;
    const odd = muxFrame(1, new TextEncoder().encode("z"));
    odd[0] = 3;
    const all = new Uint8Array([...out, ...err, ...stdin, ...odd]);
    demuxer.push(all.slice(0, 5));
    demuxer.push(all.slice(5, 14));
    demuxer.push(all.slice(14));
    expect(seen).toEqual([
      ["stdout", "hello"],
      ["stderr", "oops"],
      ["stdout", "x"],
    ]);
  });
});

describe("meminfo", () => {
  test("parses MemTotal and MemAvailable in MB", async () => {
    const text = "MemTotal:       8388608 kB\nMemFree:  1 kB\nMemAvailable:   2097152 kB\n";
    expect(parseMeminfo(text)).toEqual({ totalMb: 8192, availableMb: 2048 });
    expect(parseMeminfo("")).toEqual({ totalMb: 0, availableMb: 0 });
    const { dir, remove } = tempDir("rb-mem-");
    await Bun.write(`${dir}/meminfo`, text);
    expect(await readMeminfo(`${dir}/meminfo`)).toEqual({ totalMb: 8192, availableMb: 2048 });
    remove();
  });
});

describe("backoff", () => {
  test("doubles from 1 s and caps at 15 s", () => {
    expect([0, 1, 2, 3, 4, 10, -1].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000, 1000]);
  });

  test("builds the websocket url and reads upgrade statuses", () => {
    expect(connectUrl("https://bots.example/", "/runner/connect")).toBe("wss://bots.example/runner/connect");
    expect(connectUrl("http://127.0.0.1:2100", "/runner/connect")).toBe("ws://127.0.0.1:2100/runner/connect");
    expect(connectUrl("wss://x", "/runner/connect")).toBe("wss://x/runner/connect");
    expect(upgradeStatus("failed: Expected 101 status code: 401")).toBe(401);
    expect(upgradeStatus("closed")).toBeNull();
  });
});

describe("mounts", () => {
  test("accepts only host paths inside the workspace roots and outside the forbidden list", () => {
    const roots = ["/srv/rb", "/"];
    expect(insideRoot("/srv/rb", roots)).toBe(true);
    expect(insideRoot("/srv/rb/work/../x", roots)).toBe(true);
    expect(insideRoot("/srv/rbx", roots)).toBe(false);
    expect(insideRoot("/etc", roots)).toBe(false);
    const mounts = [
      { host: "/srv/rb/a", box: "/a", readOnly: true },
      { host: "/srv/rb/b", box: "/b", readOnly: false },
    ];
    expect(rejectedMount(mounts, roots, [])).toBeNull();
    expect(rejectedMount(mounts, roots, ["/srv/rb/b"])).toBe("/srv/rb/b");
    expect(rejectedMount([{ host: "/etc", box: "/etc", readOnly: true }], roots, [])).toBe("/etc");
    expect(bindsOf(mounts)).toEqual(["/srv/rb/a:/a:ro", "/srv/rb/b:/b"]);
  });

  test("drops optional mounts outside the roots and keeps the required ones for the check", () => {
    const roots = ["/srv/rb"];
    const required = { host: "/etc", box: "/etc", readOnly: true };
    const inside = { host: "/srv/rb/a", box: "/a", readOnly: true, optional: true };
    const outside = { host: "/home/x/.config/gh", box: "/gh", readOnly: true, optional: true };
    expect(usableMounts([required, inside, outside], roots, [])).toEqual([required, inside]);
    expect(usableMounts([inside], roots, ["/srv/rb/a"])).toEqual([]);
  });

  test("keys a spec independently of mount order", () => {
    const a = boxSpec({
      mounts: [
        { host: "/x", box: "/x", readOnly: true },
        { host: "/y", box: "/y", readOnly: false },
      ],
    });
    const b = boxSpec({ mounts: [...a.mounts].reverse() });
    expect(specKey(a)).toBe(specKey(b));
    expect(specKey(a)).not.toBe(specKey({ ...a, memMb: 1024 }));
    expect(specKey(a)).toHaveLength(16);
  });
});

describe("guards", () => {
  test("validates turn requests, box specs, events and gates", () => {
    expect(isTurnRequest(turnRequest())).toBe(true);
    expect(isTurnRequest({ ...turnRequest(), provider: "gpt" })).toBe(false);
    expect(isTurnRequest("x")).toBe(false);
    expect(isBoxSpec(boxSpec())).toBe(true);
    expect(isBoxSpec({ ...boxSpec(), memMb: 0 })).toBe(false);
    expect(isBoxSpec({ ...boxSpec(), mounts: [{ host: "/a" }] })).toBe(false);
    expect(isBoxSpec({ ...boxSpec(), mounts: ["/a"] })).toBe(false);
    const mount = { host: "/a", box: "/a", readOnly: true };
    expect(isBoxSpec({ ...boxSpec(), mounts: [{ ...mount, optional: true }] })).toBe(true);
    expect(isBoxSpec({ ...boxSpec(), mounts: [{ ...mount, optional: "yes" }] })).toBe(false);
    expect(isBoxSpec(null)).toBe(false);
    expect(isProviderEvent({ type: "done", ok: true })).toBe(true);
    expect(isProviderEvent({ type: "nope" })).toBe(false);
    expect(isToolGate({ allow: false })).toBe(true);
    expect(isToolGate({ allow: "yes" })).toBe(false);
  });
});

describe("realClock", () => {
  test("runs and cancels timers", async () => {
    const fired = await new Promise<string>((resolve) => {
      const cancelled = realClock.after(0, () => resolve("cancelled"));
      cancelled.cancel();
      realClock.after(0, () => resolve("after"));
    });
    expect(fired).toBe("after");
    const ticks = await new Promise<number>((resolve) => {
      let count = 0;
      const handle = realClock.every(1, () => {
        count += 1;
        if (count < 2) return;
        handle.cancel();
        resolve(count);
      });
    });
    expect(ticks).toBe(2);
  });
});
