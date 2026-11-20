import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { factsOfType, makeBot } from "../../../../test/engine-helpers";
import { request, resetData, startTestServer, type TestServer } from "../../../../test/helpers";
import type { BotDefinition } from "../../bots/services/bots.service";
import * as canvas from "../../canvas/services/canvas.service";
import { getStoredSession } from "../../conversations/services/sessions.service";
import { ensureThread } from "../../conversations/services/threads.service";
import {
  artifactContentKey,
  artifactExtension,
  listArtifactRows,
  readArtifactRow,
} from "../repositories/artifacts.repository";
import {
  artifactCsp,
  artifactEventOf,
  artifactGuide,
  artifactTools,
  createArtifact,
  eventOf,
  isArtifactId,
  listArtifacts,
  publicArtifact,
  readArtifact,
  readArtifactContent,
  readArtifactHtml,
  saveArtifactMeta,
  updateArtifact,
} from "../services/artifacts.service";

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

interface PublicArtifact {
  id: string;
  title: string;
  kind: string;
  version: number;
  url: string;
  versions: Array<{ n: number; author: string; url: string }>;
}

let server: TestServer;
let bot: BotDefinition;
const spies: Mock<(...args: never[]) => unknown>[] = [];

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await resetData();
  bot = await makeBot();
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("artifacts service", () => {
  test("creates, reads and versions an html artifact", async () => {
    const meta = await createArtifact(bot.id, "Relatório", "page", page("<h1>v1</h1>"));
    expect(isArtifactId(meta.id)).toBe(true);
    expect(meta.versions).toEqual([{ n: 1, createdAt: meta.createdAt, size: Buffer.byteLength(page("<h1>v1</h1>")) }]);
    expect(await readArtifactHtml(bot.id, meta.id, 1)).toBe(page("<h1>v1</h1>"));
    expect(await readArtifact(bot.id, meta.id)).toEqual(meta);
    expect(await readArtifact(bot.id, "not-an-id")).toBeNull();
    expect(await readArtifact("other-bot", meta.id)).toBeNull();

    const edited = await updateArtifact(bot.id, meta.id, {
      edits: [{ old: "<h1>v1</h1>", new: "<h1>v2</h1>" }],
      title: "  ",
    });
    expect(edited.title).toBe("Relatório");
    expect(edited.versions.map((item) => item.n)).toEqual([1, 2]);
    expect(await readArtifactHtml(bot.id, meta.id, 2)).toBe(page("<h1>v2</h1>"));

    const replaced = await updateArtifact(bot.id, meta.id, { html: page("novo"), title: " Novo título " });
    expect(replaced.title).toBe("Novo título");
    expect(await readArtifactHtml(bot.id, meta.id, 3)).toBe(page("novo"));

    const listed = await listArtifacts(bot.id);
    expect(listed.map((item) => item.id)).toEqual([meta.id]);
    expect(listed[0].versions).toHaveLength(3);
  });

  test("reads return null for bad ids, versions and missing artifacts", async () => {
    const meta = await createArtifact(bot.id, "Dash", "dashboard", page("x"));
    expect(await readArtifactHtml(bot.id, "bad", 1)).toBeNull();
    expect(await readArtifactHtml(bot.id, "art_missing00", 1)).toBeNull();
    expect(await readArtifactHtml(bot.id, meta.id, 0)).toBeNull();
    expect(await readArtifactHtml(bot.id, meta.id, 1.5)).toBeNull();
    expect(await readArtifactHtml(bot.id, meta.id, 9)).toBeNull();
    expect(await readArtifactContent(meta, 1)).toBe(page("x"));
  });

  test("rejects bad html and bad updates", async () => {
    await expect(createArtifact(bot.id, "x", "page", "just text")).rejects.toThrow("documento HTML completo");
    await expect(createArtifact(bot.id, "x", "page", `<html>${"a".repeat(600_001)}`)).rejects.toThrow(
      "HTML grande demais",
    );
    await expect(updateArtifact(bot.id, "art_missing00", { html: page("x") })).rejects.toThrow(
      "Não existe artefato art_missing00",
    );
    const meta = await createArtifact(bot.id, "Slides", "slides", page("<p>a</p><p>a</p>"));
    await expect(updateArtifact(bot.id, meta.id, {})).rejects.toThrow("Mande html ou edits.");
    await expect(updateArtifact(bot.id, meta.id, { edits: [] })).rejects.toThrow("Mande html ou edits.");
    await expect(updateArtifact(bot.id, meta.id, { edits: [{ old: "zzz", new: "y" }] })).rejects.toThrow(
      'Edição 1: o trecho "old" não foi encontrado na versão 1.',
    );
    await expect(updateArtifact(bot.id, meta.id, { edits: [{ old: "<p>a</p>", new: "y" }] })).rejects.toThrow(
      "aparece mais de uma vez",
    );
    const { meta: drawing } = await canvas.createCanvas(bot.id, "Mapa", { nodes: [{ id: "a", text: "a" }], edges: [] });
    await expect(updateArtifact(bot.id, drawing.id, { html: page("x") })).rejects.toThrow("Esse artefato é um canvas");
  });

  test("public shape, events and guide", async () => {
    const meta = await createArtifact(bot.id, "Página", "page", page("x"));
    const view = publicArtifact(meta);
    expect(view).toMatchObject({
      id: meta.id,
      version: 1,
      url: `/bots/${bot.id}/artifacts/${meta.id}/v/1.html`,
      versions: [{ n: 1, author: "bot", url: `/bots/${bot.id}/artifacts/${meta.id}/v/1.html` }],
    });
    const empty = publicArtifact({ ...meta, kind: "canvas", versions: [] });
    expect(empty.version).toBe(1);
    expect(empty.url).toBe(`/bots/${bot.id}/artifacts/${meta.id}/v/1.json`);
    expect(eventOf("artifact.created", meta)).toEqual({
      type: "artifact.created",
      data: { artifactId: meta.id, title: "Página", kind: "page", version: 1, author: "bot" },
    });
    const event = eventOf("artifact.updated", meta);
    expect(artifactEventOf({ artifactEvent: event })).toBe(event);
    expect(artifactEventOf(null)).toBeNull();
    expect(artifactEventOf("x")).toBeNull();
    expect(artifactEventOf({ other: 1 })).toBeNull();
    expect(artifactGuide).toContain("artifact_create");
    expect(artifactCsp).toContain("connect-src 'none'");
    const directives = artifactCsp.split("; ");
    expect(directives).toContain("sandbox allow-scripts allow-downloads");
    expect(directives).toContain("frame-ancestors 'self'");
    expect(artifactCsp).not.toContain("allow-same-origin");
    expect(artifactCsp).not.toContain("allow-popups");
    expect(artifactCsp).not.toContain("allow-top-navigation");
    expect(artifactGuide).toContain("nada de localStorage");
  });

  test("tools create and update artifacts", async () => {
    const [create, update] = artifactTools(bot.id);
    expect(create.label({ kind: "slides", title: "Q3" })).toBe("Criar apresentação: Q3");
    expect(create.label({})).toBe("Criar página: ");
    expect(create.label({ kind: "weird" })).toBe("Criar página: ");
    expect(update.label({})).toBe("Atualizar artefato");
    const signal = new AbortController().signal;
    const created = (await create.run({ title: " Q3 ", kind: "dashboard", html: page("<b>1</b>") }, signal)) as {
      artifactId: string;
      title: string;
      version: number;
      artifactEvent: { type: string };
    };
    expect(created).toMatchObject({ title: "Q3", kind: "dashboard", version: 1 });
    expect(created.artifactEvent.type).toBe("artifact.created");
    const edited = (await update.run(
      { id: created.artifactId, edits: [{ old: "<b>1</b>", new: "<b>2</b>" }], title: "Q4" },
      signal,
    )) as { version: number; title: string; artifactEvent: { type: string } };
    expect(edited).toMatchObject({ version: 2, title: "Q4" });
    expect(edited.artifactEvent.type).toBe("artifact.updated");
    const replaced = (await update.run({ id: created.artifactId, html: page("<b>3</b>") }, signal)) as {
      version: number;
    };
    expect(replaced.version).toBe(3);
    expect(await readArtifactHtml(bot.id, created.artifactId, 3)).toBe(page("<b>3</b>"));
  });

  test("repository keys and rows", async () => {
    expect(artifactExtension("canvas")).toBe("json");
    expect(artifactExtension("page")).toBe("html");
    expect(artifactContentKey("b", "art_x", 2, "page")).toBe("bots/b/artifacts/art_x/v2.html");
    expect(await listArtifactRows("no-artifacts-bot")).toEqual([]);
    const meta = await createArtifact(bot.id, "Autor", "page", page("x"));
    await saveArtifactMeta({
      ...meta,
      versions: [{ ...meta.versions[0], author: "user" }],
      canvas: { seen: 1, notified: 0 },
    });
    expect(await readArtifactRow(bot.id, meta.id)).toMatchObject({
      versions: [{ n: 1, author: "user" }],
      canvas: { seen: 1, notified: 0 },
    });
    expect(await readArtifactRow(bot.id, "art_nothing00")).toBeNull();
  });
});

describe("artifacts routes", () => {
  test("lists, reads metadata and serves html versions", async () => {
    const meta = await createArtifact(bot.id, "Servido", "page", page("<i>oi</i>"));
    const list = await request<PublicArtifact[]>(`/bots/${bot.id}/artifacts`);
    expect(list.status).toBe(200);
    expect(list.body.map((item) => item.id)).toEqual([meta.id]);

    const one = await request<PublicArtifact>(`/bots/${bot.id}/artifacts/${meta.id}`);
    expect(one.status).toBe(200);
    expect(one.body.url).toBe(`/bots/${bot.id}/artifacts/${meta.id}/v/1.html`);

    const html = await request(`/bots/${bot.id}/artifacts/${meta.id}/v/1.html`);
    expect(html.status).toBe(200);
    expect(html.text).toBe(page("<i>oi</i>"));
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html.headers.get("content-security-policy")).toBe(artifactCsp);
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");

    const missingVersion = await request<{ error: string }>(`/bots/${bot.id}/artifacts/${meta.id}/v/7.html`);
    expect(missingVersion.status).toBe(404);
    expect(missingVersion.body.error).toBe("Versão não encontrada.");
    const wrongShape = await request(`/bots/${bot.id}/artifacts/${meta.id}/v/1.json`);
    expect(wrongShape.status).toBe(404);
    const missing = await request<{ error: string }>(`/bots/${bot.id}/artifacts/art_nothing00`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("Artefato não encontrado.");
    const otherMethod = await request(`/bots/${bot.id}/artifacts/${meta.id}`, { method: "DELETE" });
    expect(otherMethod.status).toBe(404);
  });

  test("serves canvas documents by version", async () => {
    const { meta, doc } = await canvas.createCanvas(bot.id, "Fluxo", {
      layout: "flow",
      nodes: [
        { id: "a", text: "a" },
        { id: "b", text: "b" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const latest = await request<{ version: number; nodes: unknown[] }>(`/bots/${bot.id}/artifacts/${meta.id}/doc`);
    expect(latest.status).toBe(200);
    expect(latest.headers.get("cache-control")).toBe("no-cache");
    expect(latest.body).toEqual({ ...doc, version: 1 } as never);
    const byVersion = await request<{ version: number }>(`/bots/${bot.id}/artifacts/${meta.id}/v/1.json`);
    expect(byVersion.body.version).toBe(1);
    const missing = await request<{ error: string }>(`/bots/${bot.id}/artifacts/${meta.id}/v/5.json`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("Versão não encontrada.");
    const wrong = await request(`/bots/${bot.id}/artifacts/${meta.id}/v/1.html`);
    expect(wrong.status).toBe(404);
    const elsewhere = await request(`/bots/${bot.id}/artifacts/${meta.id}/raw`);
    expect(elsewhere.status).toBe(404);
  });

  test("saves user canvas edits and reports conflicts", async () => {
    const { meta, doc } = await canvas.createCanvas(bot.id, "Edição", { nodes: [{ id: "a", text: "a" }], edges: [] });
    const path = `/bots/${bot.id}/artifacts/${meta.id}/doc`;
    const saved = await request<PublicArtifact>(path, {
      method: "PUT",
      body: { doc: { ...doc, nodes: [...doc.nodes, { id: "b", text: "b", x: 400, y: 0 }] }, baseVersion: 1 },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(2);
    expect(saved.body.versions[1].author).toBe("user");
    const thread = await ensureThread(bot.id);
    const events = await factsOfType(getStoredSession(thread.sessionId)!, "artifact.updated");
    expect(events.at(-1)?.data).toMatchObject({ artifactId: meta.id, version: 2, author: "user", botId: bot.id });

    const { meta: other } = await canvas.createCanvas(bot.id, "Velho", { nodes: [{ id: "a", text: "a" }], edges: [] });
    const stale = await request<{ code: string; version: number }>(`/bots/${bot.id}/artifacts/${other.id}/doc`, {
      method: "PUT",
      body: { doc, baseVersion: 0 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ ok: false, code: "stale", version: 1 });

    const html = await createArtifact(bot.id, "Não canvas", "page", page("x"));
    const notCanvas = await request<{ code: string; version?: number }>(`/bots/${bot.id}/artifacts/${html.id}/doc`, {
      method: "PUT",
      body: { doc },
    });
    expect(notCanvas.status).toBe(400);
    expect(notCanvas.body.code).toBe("not_canvas");
    expect(notCanvas.body.version).toBeUndefined();

    const broken = await request<{ field: string }>(path, { method: "PUT", body: "{broken" });
    expect(broken.status).toBe(400);
    expect(broken.body.field).toBe("body");
  });

  test("unexpected canvas failures surface as server errors", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    spies.push(
      logged as never,
      spyOn(canvas, "saveUserCanvas").mockImplementation(() => Promise.reject(new Error("disk gone"))) as never,
      spyOn(canvas, "layoutPreview").mockImplementation(() => {
        throw new Error("layout crashed");
      }) as never,
    );
    const put = await request<{ error: string }>(`/bots/${bot.id}/artifacts/art_whatever0/doc`, {
      method: "PUT",
      body: { doc: {} },
    });
    expect(put.status).toBe(500);
    expect(put.body.error).toBe("Algo deu errado no servidor. Tente de novo.");
    const layout = await request<{ error: string }>(`/bots/${bot.id}/artifacts/art_whatever0/layout`, {
      method: "POST",
      body: { doc: {} },
    });
    expect(layout.status).toBe(500);
    expect(layout.body.error).toBe("Algo deu errado no servidor. Tente de novo.");
    expect(logged).toHaveBeenCalledTimes(2);
  });

  test("lays out a preview without saving", async () => {
    const path = `/bots/${bot.id}/artifacts/art_anything0/layout`;
    const laid = await request<{ nodes: Array<{ id: string; x: number; y: number }> }>(path, {
      method: "POST",
      body: {
        doc: {
          layout: "flow",
          nodes: [
            { id: "a", text: "a" },
            { id: "b", text: "b" },
          ],
          edges: [{ from: "a", to: "b" }],
        },
      },
    });
    expect(laid.status).toBe(200);
    expect(laid.body.nodes.map((item) => item.id)).toEqual(["a", "b"]);
    expect(typeof laid.body.nodes[0].x).toBe("number");
    const invalid = await request<{ error: string }>(path, { method: "POST", body: {} });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("Mande o documento do canvas.");
    const syntax = await request<{ ok: boolean }>(path, { method: "POST", body: "{broken" });
    expect(syntax.status).toBe(400);
    expect(syntax.body.ok).toBe(false);
    const unknown = await request(`/bots/${bot.id}/artifacts/art_anything0/other`, { method: "POST" });
    expect(unknown.status).toBe(404);
  });
});
