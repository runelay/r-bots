import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import net from "node:net";
import { fakeAgentBrowser } from "../../../../test/browser-helpers";
import { resetData } from "../../../../test/helpers";
import { env } from "../../../config/env";
import { getDb, tables } from "../../../db";
import * as devServers from "../../code/services/dev-server.service";
import { browserOpen } from "../services/browser.service";
import {
  assertBrowsable,
  browserLaunchArgs,
  browserProxy,
  devPortAllowed,
  stopBrowserProxies,
} from "../services/browser-guard.service";

const botId = "guard-bot";
const devPort = 5173;
const restore: Array<{ mockRestore: () => void }> = [];

beforeEach(async () => {
  await resetData();
  await getDb().delete(tables.codeWorkspaces);
  const base = { repo: "r", repoName: "r", branch: "b", createdAt: new Date().toISOString() };
  await getDb()
    .insert(tables.codeWorkspaces)
    .values([
      { ...base, id: "ws-live", botId, path: "/w/live", status: "alive" },
      { ...base, id: "ws-closed", botId, path: "/w/closed", status: "closed" },
      { ...base, id: "ws-other", botId: "other-bot", path: "/w/other", status: "alive" },
    ]);
  restore.push(
    spyOn(devServers, "previewTarget").mockImplementation((workspaceId: string, port: number) =>
      ["ws-live", "ws-closed", "ws-other"].includes(workspaceId) &&
      [devPort, env.GATEWAY_PORT, 5432, 6379, 3900, 3903, 6000 + workspaceId.length].includes(port)
        ? { port, token: "t" }
        : null,
    ),
  );
});

afterEach(() => {
  for (const spy of restore.splice(0)) spy.mockRestore();
});

afterAll(async () => {
  await stopBrowserProxies();
});

async function refusal(url: string) {
  try {
    await assertBrowsable(botId, url);
  } catch (error) {
    return (error as Error).message;
  }
  return null;
}

describe("assertBrowsable", () => {
  test("only http and https", async () => {
    expect(await refusal("file:///etc/passwd")).toBe("O navegador do bot só abre endereços http ou https.");
    expect(await refusal("view-source:https://x.com")).toBe("O navegador do bot só abre endereços http ou https.");
    expect(await refusal("chrome://settings")).toBe("O navegador do bot só abre endereços http ou https.");
    expect(await refusal("não é url")).toBe("Endereço inválido.");
  });

  test("blocks loopback, private ranges, metadata and the tailnet", async () => {
    expect(await refusal("http://127.0.0.1:8080/")).toContain("interno");
    expect(await refusal("http://169.254.169.254/latest/meta-data")).toContain("interno");
    expect(await refusal("http://100.100.100.100/")).toContain("interno");
    expect(await refusal("https://[::1]/")).toContain("interno");
    expect(await refusal("http://vps.tail1234.ts.net/")).toContain("rede interna");
    expect(await refusal("http://localhost:3000/")).toContain("interno");
    expect(await refusal("http://intranet/")).toContain("não é um endereço público");
    expect(await refusal("https://93.184.216.34/")).toBeNull();
  });

  test("lets the bot reach only its own running dev servers, never internal service ports", async () => {
    expect(await refusal(`http://127.0.0.1:${devPort}/`)).toBeNull();
    expect(await refusal(`http://localhost:${devPort}/app`)).toBeNull();
    expect(await devPortAllowed(botId, devPort)).toBe(true);
    expect(await devPortAllowed(botId, 6000 + "ws-closed".length)).toBe(false);
    expect(await devPortAllowed(botId, 6000 + "ws-other".length)).toBe(false);
    for (const port of [env.GATEWAY_PORT, 3900, 3903, 5432, 6379]) {
      expect(await devPortAllowed(botId, port)).toBe(false);
      expect(await refusal(`http://127.0.0.1:${port}/`)).toContain("interno");
    }
  });

  test("lets the bot reach a running project server, but not a workspace server of another bot", async () => {
    restore.push(
      spyOn(devServers, "portOwner").mockImplementation(
        (port: number) =>
          (port === 7100
            ? { target: { kind: "project" } }
            : port === 6000 + "ws-other".length
              ? { target: { kind: "workspace" } }
              : null) as unknown as ReturnType<typeof devServers.portOwner>,
      ),
    );
    expect(await devPortAllowed(botId, 7100)).toBe(true);
    expect(await refusal("http://127.0.0.1:7100/")).toBeNull();
    expect(await devPortAllowed(botId, 6000 + "ws-other".length)).toBe(false);
    expect(await devPortAllowed(botId, 5432)).toBe(false);
  });
});

describe("browser launch", () => {
  test("every bot gets its own proxy and chromium is pointed at it", async () => {
    const first = await browserProxy(botId);
    expect(await browserProxy(botId)).toBe(first);
    expect((await browserLaunchArgs(botId)).split(",")).toContain(`--proxy-server=http://127.0.0.1:${first.port}`);
    const reply = await new Promise<string>((resolve) => {
      const socket = net.connect({ port: first.port, host: "127.0.0.1" });
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString();
      });
      socket.on("close", () => resolve(text));
      socket.write(`CONNECT 127.0.0.1:${env.GATEWAY_PORT} HTTP/1.1\r\n\r\n`);
    });
    expect(reply).toStartWith("HTTP/1.1 403 Forbidden");
    await stopBrowserProxies();
    expect(await browserProxy(botId)).not.toBe(first);
  });

  test("a bot cannot open internal pages, a person still can", async () => {
    const fake = fakeAgentBrowser();
    try {
      await expect(browserOpen(botId, "file:///etc/passwd")).rejects.toThrow("só abre endereços http ou https");
      await expect(browserOpen(botId, "http://169.254.169.254/")).rejects.toThrow("interno");
      expect(fake.commands).toEqual([]);
      await browserOpen(botId, "about:blank", undefined, true);
      expect(fake.commands.some((command) => command[0] === "open" && command[1] === "about:blank")).toBe(true);
    } finally {
      fake.restore();
    }
  });

  test("a session left from before this process is relaunched behind the proxy", async () => {
    const id = `${botId}-stale`;
    const fake = fakeAgentBrowser();
    fake.page.sessions = [`runelay-${id}`];
    try {
      await browserOpen(id, "https://93.184.216.34/");
      expect(fake.commands.slice(0, 3)).toEqual([
        ["session", "list", "--json"],
        ["close"],
        ["set", "viewport", "1280", "800"],
      ]);
      const before = fake.commands.length;
      await browserOpen(id, "https://93.184.216.34/x");
      expect(fake.commands.slice(before).some((command) => command[0] === "close" || command[0] === "session")).toBe(
        false,
      );
    } finally {
      fake.restore();
    }
  });

  test("an unreadable session list counts as no session", async () => {
    const id = `${botId}-garbled`;
    const fake = fakeAgentBrowser((command) => (command[0] === "session" ? { stdout: "garbage" } : undefined));
    try {
      await browserOpen(id, "https://93.184.216.34/");
      expect(fake.commands.filter((command) => command[0] === "close")).toEqual([]);
    } finally {
      fake.restore();
    }
  });
});
