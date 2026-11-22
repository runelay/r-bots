import { beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { resetData } from "../../../../test/helpers";
import { withLanguage } from "../../../shared/i18n";
import { artifactContentKey } from "../../artifacts/repositories/artifacts.repository";
import * as artifacts from "../../artifacts/services/artifacts.service";
import { type ArtifactMeta, readArtifact, saveArtifactMeta } from "../../artifacts/services/artifacts.service";
import { getBlobStore } from "../../storage/services/storage.service";
import {
  type CanvasDoc,
  CanvasError,
  type CanvasNode,
  canvasEditNote,
  canvasGuide,
  canvasTools,
  createCanvas,
  layoutDoc,
  layoutPreview,
  readCanvasDoc,
  readCanvasForBot,
  saveUserCanvas,
  sizeFor,
  updateCanvas,
} from "../services/canvas.service";

let botId = "bot-canvas";
let botCounter = 0;
const signal = new AbortController().signal;

beforeEach(async () => {
  await resetData();
  setSystemTime();
  botCounter++;
  botId = `bot-canvas-${botCounter}-${Math.random().toString(36).slice(2, 8)}`;
});

function node(id: string, text = id, extra: Record<string, unknown> = {}) {
  return { id, text, ...extra };
}

function edge(from: string, to: string, extra: Record<string, unknown> = {}) {
  return { from, to, ...extra };
}

function byId(doc: CanvasDoc, id: string) {
  return doc.nodes.find((item) => item.id === id) as CanvasNode;
}

function overlap(a: CanvasNode, b: CanvasNode) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function noOverlaps(doc: CanvasDoc) {
  for (let i = 0; i < doc.nodes.length; i++)
    for (let j = i + 1; j < doc.nodes.length; j++) expect(overlap(doc.nodes[i], doc.nodes[j])).toBe(false);
}

async function writeMeta(meta: ArtifactMeta) {
  await saveArtifactMeta(meta);
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const failed = error as CanvasError;
    return { message: failed.message, status: failed.status, code: failed.code };
  }
  throw new Error("expected a rejection");
}

const html = "<!doctype html><html><head></head><body><p>oi</p></body></html>";

function tool(name: string) {
  const found = canvasTools(botId).find((item) => item.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe("sizeFor", () => {
  test("grows with text and differs by shape", () => {
    expect(sizeFor("", "box")).toEqual({ w: 120, h: 56 });
    expect(sizeFor("a", "diamond")).toEqual({ w: 150, h: 100 });
    expect(sizeFor("a", "ellipse")).toEqual({ w: 130, h: 60 });
    const long = sizeFor("uma frase bem comprida que precisa quebrar em varias linhas\nsegundo paragrafo", "round");
    expect(long.h).toBeGreaterThan(56);
    expect(long.w).toBeGreaterThanOrEqual(120);
  });
});

describe("layoutPreview and sanitize", () => {
  test("rejects a missing document", () => {
    expect(() => layoutPreview(undefined)).toThrow(CanvasError);
    expect(() => layoutPreview({ doc: "text" })).toThrow("Mande o documento do canvas.");
  });

  test("rejects too many nodes or edges", () => {
    const nodes = Array.from({ length: 401 }, (_, index) => node(`n${index}`));
    expect(() => layoutPreview({ doc: { nodes } })).toThrow("máximo 400 caixas");
    const edges = Array.from({ length: 801 }, () => edge("a", "b"));
    expect(() => layoutPreview({ doc: { nodes: [], edges } })).toThrow("máximo 800 conexões");
  });

  test("cleans nodes, edges and groups", () => {
    const doc = layoutPreview({
      doc: {
        layout: "weird",
        nodes: [
          null,
          node("a", "A\r", { shape: "diamond", color: "red", w: 5000, h: 1 }),
          node("a", "duplicate", { shape: "hexagon", color: "plaid" }),
          { text: "no id" },
          node("b", "B", { x: Number.NaN, y: 5_000_000 }),
        ],
        edges: [
          null,
          edge("a", "b", { id: "e1", label: "  go  ", style: "dashed" }),
          edge("a", "b", { id: "e1" }),
          edge("a", "a"),
          edge("a", "ghost"),
          edge("b", "a", { label: "   ", style: "solid" }),
        ],
        groups: [null, { label: "G", nodeIds: ["a", "ghost"] }, { id: "g2", label: "empty", nodeIds: ["ghost"] }, {}],
      },
    });
    expect(doc.layout).toBe("diagram");
    expect(doc.schema).toBe(1);
    expect(doc.nodes).toHaveLength(4);
    const a = byId(doc, "a");
    expect(a.text).toBe("A");
    expect(a.shape).toBe("diamond");
    expect(a.color).toBe("red");
    expect(a.w).toBe(1200);
    expect(a.h).toBe(28);
    const dup = doc.nodes[1];
    expect(dup.id).not.toBe("a");
    expect(dup.shape).toBe("box");
    expect(dup.color).toBeUndefined();
    expect(doc.nodes[2].id).toMatch(/^n[0-9a-f]{8}$/);
    expect(doc.edges).toHaveLength(3);
    expect(doc.edges[0]).toEqual({ id: "e1", from: "a", to: "b", label: "go", style: "dashed" });
    expect(doc.edges[1].id).not.toBe("e1");
    expect(doc.edges[2]).toEqual({ id: doc.edges[2].id, from: "b", to: "a" });
    expect(doc.groups).toEqual([{ id: expect.stringMatching(/^g/), label: "G", nodeIds: ["a"] }]);
  });

  test("drops groups when none survive and accepts non-array fields", () => {
    const doc = layoutPreview({ doc: { layout: "flow", nodes: "x", edges: "y", groups: [{ nodeIds: [] }] } });
    expect(doc).toEqual({ schema: 1, layout: "flow", nodes: [], edges: [] });
  });
});

describe("layered layout", () => {
  test("stacks a flow top to bottom with long edges, cycles and yes/no branches", () => {
    const doc = layoutPreview({
      doc: {
        layout: "flow",
        nodes: [
          node("start", "Início", { shape: "ellipse" }),
          node("ask", "Aprovado?", { shape: "diamond" }),
          node("yes", "Publica"),
          node("no", "Revisa"),
          node("other", "Outro"),
          node("end", "Fim", { shape: "ellipse" }),
        ],
        edges: [
          edge("start", "ask"),
          edge("ask", "yes", { label: "sim" }),
          edge("ask", "no", { label: "não" }),
          edge("ask", "other", { label: "talvez" }),
          edge("no", "ask"),
          edge("yes", "end"),
          edge("start", "end", { label: "sim" }),
          edge("start", "end", { label: "não" }),
        ],
      },
    });
    const start = byId(doc, "start");
    const ask = byId(doc, "ask");
    const yes = byId(doc, "yes");
    const no = byId(doc, "no");
    const end = byId(doc, "end");
    expect(start.y).toBeLessThan(ask.y);
    expect(ask.y).toBeLessThan(yes.y);
    expect(yes.y).toBeLessThan(end.y);
    expect(yes.x).toBeLessThan(no.x);
    noOverlaps(doc);
  });

  test("lays out a pure cycle without a clear root", () => {
    const doc = layoutPreview({
      doc: { nodes: [node("a"), node("b"), node("c")], edges: [edge("a", "b"), edge("b", "c"), edge("c", "a")] },
    });
    expect(new Set(doc.nodes.map((item) => item.y)).size).toBe(3);
    noOverlaps(doc);
  });

  test("keeps nodes of one layer apart", () => {
    const wide: CanvasDoc = {
      schema: 1,
      layout: "diagram",
      nodes: [
        { id: "a", text: "a", x: 0, y: 0, w: 100, h: 50, shape: "box" },
        { id: "b", text: "b", x: 10, y: 0, w: 100, h: 50, shape: "box" },
      ],
      edges: [],
    };
    layoutDoc(wide);
    noOverlaps(wide);
  });

  test("refuses an edge that points to a missing node with a clear error", () => {
    const broken: CanvasDoc = {
      schema: 1,
      layout: "diagram",
      nodes: [{ id: "a", text: "a", x: 0, y: 0, w: 100, h: 50, shape: "box" }],
      edges: [{ id: "e", from: "a", to: "ghost" }],
    };
    expect(() => layoutDoc(broken)).toThrow("canvas layout: missing entry ghost");
  });
});

describe("radial layout", () => {
  function pair(w: number, h: number): CanvasDoc {
    return {
      schema: 1,
      layout: "mindmap",
      nodes: [
        { id: "root", text: "r", x: 0, y: 0, w, h, shape: "box" },
        { id: "child", text: "c", x: 0, y: 0, w, h, shape: "box" },
      ],
      edges: [{ id: "e", from: "root", to: "child" }],
    };
  }

  test("pushes tall overlapping nodes apart sideways", () => {
    const doc = pair(100, 600);
    layoutDoc(doc);
    const [root, child] = doc.nodes;
    expect(root.x + root.w + 32).toBeLessThanOrEqual(child.x + 1);
    expect(root.y).toBe(child.y - 250);
  });

  test("pushes wide overlapping nodes apart vertically", () => {
    const doc = pair(1000, 300);
    layoutDoc(doc);
    const [root, child] = doc.nodes;
    expect(root.y + root.h + 32).toBeLessThanOrEqual(child.y + 1);
  });

  test("puts the root at the center and strays below", () => {
    const doc = layoutPreview({
      doc: {
        layout: "mindmap",
        nodes: [node("root"), node("a"), node("b"), node("a1"), node("lost1"), node("lost2")],
        edges: [edge("root", "a"), edge("root", "b"), edge("a", "a1")],
      },
    });
    const root = byId(doc, "root");
    expect(Math.abs(root.x + root.w / 2)).toBeLessThan(200);
    const lost1 = byId(doc, "lost1");
    const lost2 = byId(doc, "lost2");
    expect(lost1.y).toBe(lost2.y);
    expect(lost1.y).toBeGreaterThan(root.y);
    noOverlaps(doc);
  });

  test("picks a root inside a cycle and handles an empty map", () => {
    const doc = layoutPreview({
      doc: { layout: "mindmap", nodes: [node("a"), node("b")], edges: [edge("a", "b"), edge("b", "a")] },
    });
    expect(doc.nodes).toHaveLength(2);
    noOverlaps(doc);
    const empty: CanvasDoc = { schema: 1, layout: "mindmap", nodes: [], edges: [] };
    layoutDoc(empty);
    expect(empty.nodes).toEqual([]);
  });
});

describe("createCanvas and reads", () => {
  test("creates a laid out canvas as version 1 by the bot", async () => {
    const { meta, doc } = await createCanvas(botId, "Fluxo", {
      layout: "flow",
      nodes: [node("a"), node("b")],
      edges: [edge("a", "b")],
    });
    expect(meta.id).toMatch(/^art_/);
    expect(meta.kind).toBe("canvas");
    expect(meta.versions).toMatchObject([{ n: 1, author: "bot" }]);
    expect(meta.canvas).toEqual({ seen: 1, notified: 1 });
    expect(byId(doc, "a").y).toBeLessThan(byId(doc, "b").y);
    expect(await readCanvasDoc(botId, meta.id, 1)).toEqual(doc);
    expect(await readArtifact(botId, meta.id)).toEqual(meta);
  });

  test("keeps positions when every node has coordinates", async () => {
    const { doc } = await createCanvas(botId, "Livre", {
      nodes: [node("a", "a", { x: 10, y: 20 }), node("b", "b", { x: 500, y: 20 })],
      edges: [],
    });
    expect([byId(doc, "a").x, byId(doc, "a").y]).toEqual([10, 20]);
  });

  test("rejects an empty canvas", async () => {
    await expect(createCanvas(botId, "Vazio", { nodes: [null], edges: [] })).rejects.toThrow(
      "Mande pelo menos uma caixa.",
    );
  });

  test("readCanvasDoc returns null for bad versions, missing files and corrupt content", async () => {
    expect(await readCanvasDoc(botId, "art_missing", 0)).toBeNull();
    expect(await readCanvasDoc(botId, "art_missing", 1.5)).toBeNull();
    expect(await readCanvasDoc(botId, "art_missing", 1)).toBeNull();
    const { meta } = await createCanvas(botId, "Corrompido", { nodes: [node("a", "a", { x: 0, y: 0 })], edges: [] });
    await getBlobStore().put(artifactContentKey(botId, meta.id, 1, "canvas"), "{ not json");
    expect(await readCanvasDoc(botId, meta.id, 1)).toBeNull();
  });

  test("requireCanvas errors: not found, not a canvas, unreadable", async () => {
    expect(await failure(readCanvasForBot(botId, "art_nothere1"))).toMatchObject({ status: 404, code: "not_found" });
    const page = await artifacts.createArtifact(botId, "Página", "page", html);
    expect(await failure(readCanvasForBot(botId, page.id))).toMatchObject({ status: 400, code: "not_canvas" });
    const { meta } = await createCanvas(botId, "Quebrado", { nodes: [node("a")], edges: [] });
    await getBlobStore().delete(artifactContentKey(botId, meta.id, 1, "canvas"));
    expect(await failure(readCanvasForBot(botId, meta.id))).toMatchObject({ status: 500, code: "unreadable" });
  });

  test("readCanvasForBot reports person edits and marks them seen", async () => {
    const { meta, doc } = await createCanvas(botId, "Mapa", {
      nodes: [
        node("a", "Alpha", { x: 0, y: 0 }),
        node("b", "Beta", { x: 400, y: 0 }),
        node("c", "Gamma", { x: 800, y: 0 }),
      ],
      edges: [edge("a", "b", { id: "ab", label: "x" }), edge("b", "c", { id: "bc" })],
    });
    const edited = structuredClone(doc);
    edited.nodes = edited.nodes.filter((item) => item.id !== "c");
    byId(edited, "a").text = "Alfa";
    byId(edited, "a").x = 100;
    byId(edited, "b").shape = "round";
    edited.nodes.push({ id: "d", text: "Delta", x: 0, y: 400, w: 120, h: 56, shape: "box" });
    edited.edges = [
      { id: "ab", from: "a", to: "b", label: "y" },
      { id: "ad", from: "a", to: "d" },
    ];
    await saveUserCanvas(botId, meta.id, { doc: edited, baseVersion: 1 });
    const read = await readCanvasForBot(botId, meta.id);
    expect(read.version).toBe(2);
    expect(read.userEdits).toBe(
      '+1 caixa ("Delta"), −1 caixa ("Gamma"), 1 caixa renomeada ("Alpha" → "Alfa"), +1 conexão ("Alfa" → "Delta"), −1 conexão, 1 rótulo de seta mudou, 1 caixa movida, 1 caixa com forma ou cor nova',
    );
    expect((await readArtifact(botId, meta.id))?.canvas).toEqual({ seen: 2, notified: 2 });
    const again = await readCanvasForBot(botId, meta.id);
    expect(again.userEdits).toBe("");
  });

  test("plural change descriptions and an unknown seen version", async () => {
    const { meta, doc } = await createCanvas(botId, "Plural", {
      nodes: [node("a", "A", { x: 0, y: 0 }), node("b", "B", { x: 300, y: 0 }), node("c", "C", { x: 600, y: 0 })],
      edges: [edge("a", "b", { id: "ab", label: "1" }), edge("b", "c", { id: "bc", label: "2" })],
    });
    const edited = structuredClone(doc);
    for (const item of edited.nodes) {
      item.text = `${item.text}!`;
      item.y += 200;
      item.color = "blue";
    }
    edited.edges = edited.edges.map((item) => ({ ...item, label: "z" }));
    edited.nodes.push(
      { id: "d", text: "D", x: 0, y: 900, w: 120, h: 56, shape: "box" },
      { id: "e", text: "E", x: 400, y: 900, w: 120, h: 56, shape: "box" },
    );
    edited.edges.push({ id: "de", from: "d", to: "e" }, { id: "ae", from: "a", to: "e" });
    await saveUserCanvas(botId, meta.id, { doc: edited });
    const second = structuredClone(edited);
    second.nodes = second.nodes.filter((item) => item.id === "a");
    second.edges = [];
    const saved = await saveUserCanvas(botId, meta.id, { doc: second });
    expect(saved.meta.versions.map((item) => item.n)).toEqual([1, 2]);
    const read = await readCanvasForBot(botId, meta.id);
    expect(read.userEdits).toContain("−2 caixas");
    expect(read.userEdits).toContain("−2 conexões");
    const fresh = await readArtifact(botId, meta.id);
    await writeMeta({ ...(fresh as ArtifactMeta), canvas: { seen: 1, notified: 1 } });
    await saveUserCanvas(botId, meta.id, { doc: edited, baseVersion: 2 });
    setSystemTime(new Date(Date.now() + 10 * 60_000));
    const third = await saveUserCanvas(botId, meta.id, { doc: edited, baseVersion: 2 });
    expect(third.meta.versions.map((item) => item.n)).toEqual([1, 2, 3]);
    await writeMeta({ ...third.meta, canvas: { seen: 1, notified: 1 } });
    const plural = await readCanvasForBot(botId, meta.id);
    expect(plural.userEdits).toContain("+2 caixas");
    expect(plural.userEdits).toContain("3 caixas renomeadas");
    expect(plural.userEdits).toContain("+2 conexões");
    expect(plural.userEdits).toContain("2 rótulos de seta mudaram");
    expect(plural.userEdits).toContain("3 caixas movidas");
    expect(plural.userEdits).toContain("3 caixas com forma ou cor nova");
    await writeMeta({ ...third.meta, canvas: { seen: 9, notified: 1 } });
    expect((await readCanvasForBot(botId, meta.id)).userEdits).toBe("");
    const latest = (await readArtifact(botId, meta.id)) as ArtifactMeta;
    const { canvas: _canvas, ...withoutCanvas } = latest;
    await writeMeta(withoutCanvas);
    expect((await readCanvasForBot(botId, meta.id)).userEdits).toBe("");
  });
});

describe("saveUserCanvas", () => {
  test("rejects a stale base when the bot wrote after it", async () => {
    const { meta } = await createCanvas(botId, "S", { nodes: [node("a", "a", { x: 0, y: 0 })], edges: [] });
    await updateCanvas(botId, meta.id, [{ op: "add_node", text: "b", x: 300, y: 0 }]);
    expect(
      await failure(saveUserCanvas(botId, meta.id, { doc: { nodes: [node("a")] }, baseVersion: 1 })),
    ).toMatchObject({
      status: 409,
      code: "stale",
    });
  });

  test("returns an artifact event by the person", async () => {
    const { meta } = await createCanvas(botId, "S", { nodes: [node("a", "a", { x: 0, y: 0 })], edges: [] });
    const saved = await saveUserCanvas(botId, meta.id, { doc: { nodes: [node("a")] } });
    expect(saved.event).toEqual({
      type: "artifact.updated",
      data: { artifactId: meta.id, title: "S", kind: "canvas", version: 2, author: "user" },
    });
    expect(saved.meta.canvas).toEqual({ seen: 1, notified: 1 });
    await expect(saveUserCanvas(botId, meta.id, null)).rejects.toThrow("Mande o documento do canvas.");
  });

  test("handles a meta without canvas state", async () => {
    const { meta } = await createCanvas(botId, "S", { nodes: [node("a", "a", { x: 0, y: 0 })], edges: [] });
    const { canvas: _canvas, ...bare } = meta;
    await writeMeta(bare);
    const saved = await saveUserCanvas(botId, meta.id, { doc: { nodes: [node("a")] } });
    expect(saved.meta.canvas).toEqual({ seen: 0, notified: 0 });
  });
});

describe("updateCanvas operations", () => {
  async function base(layout = "flow") {
    const { meta } = await createCanvas(botId, "Base", {
      layout,
      nodes: [node("root", "Raiz", { x: 0, y: 0 }), node("a", "A", { x: 0, y: 200 })],
      edges: [edge("root", "a", { id: "e1" })],
      groups: [{ id: "g1", label: "Grupo", nodeIds: ["root", "a"] }],
    });
    return meta.id;
  }

  test("node operations", async () => {
    const id = await base();
    const { doc, meta, userEdits } = await updateCanvas(
      botId,
      id,
      [
        { op: "add_node", id: "b", text: "B", parent: "a", color: "green", shape: "round" },
        { op: "add_node", id: "c", text: "C", parent: "a" },
        { op: "add_node", text: "Solta", x: 10 },
        { op: "update_node", id: "a", text: "A novo", shape: "diamond", color: "red", x: 5.4, y: 7.6 },
        { op: "update_node", id: "root", color: null },
        { op: "update_node", id: "b", color: "teal" },
        { op: "update_node", id: "root" },
      ],
      "  Novo título ",
    );
    expect(meta.title).toBe("Novo título");
    expect(meta.versions).toHaveLength(2);
    expect(userEdits).toBe("");
    const a = byId(doc, "a");
    expect([a.text, a.shape, a.color, a.x, a.y]).toEqual(["A novo", "diamond", "red", 5, 8]);
    expect(byId(doc, "b").color).toBe("teal");
    expect(byId(doc, "b").y).toBeGreaterThan(a.y);
    expect(overlap(byId(doc, "b"), byId(doc, "c"))).toBe(false);
    expect(doc.edges.filter((item) => item.from === "a").map((item) => item.to)).toEqual(["b", "c"]);
    const loose = doc.nodes.find((item) => item.text === "Solta") as CanvasNode;
    expect(loose.x).toBeGreaterThan(Math.max(byId(doc, "b").x, byId(doc, "c").x));

    const removed = await updateCanvas(botId, id, [{ op: "remove_node", id: "a" }], "   ");
    expect(removed.meta.title).toBe("Novo título");
    expect(removed.doc.nodes.map((item) => item.id)).not.toContain("a");
    expect(removed.doc.edges.some((item) => item.from === "a" || item.to === "a")).toBe(false);
    expect(removed.doc.groups).toEqual([{ id: "g1", label: "Grupo", nodeIds: ["root"] }]);
    const gone = await updateCanvas(botId, id, [{ op: "remove_node", id: "root" }]);
    expect(gone.doc.groups).toEqual([]);
  });

  test("an added node removed in the same batch is not placed", async () => {
    const { meta } = await createCanvas(botId, "NoGroups", {
      nodes: [node("x", "x", { x: 0, y: 0 })],
      edges: [],
    });
    const { doc } = await updateCanvas(botId, meta.id, [
      { op: "add_node", id: "tmp", text: "tmp" },
      { op: "remove_node", id: "tmp" },
    ]);
    expect(doc.nodes.map((item) => item.id)).toEqual(["x"]);
    expect(doc.groups).toBeUndefined();
  });

  test("edge and group operations", async () => {
    const id = await base("diagram");
    const { doc } = await updateCanvas(botId, id, [
      { op: "add_edge", id: "e2", from: "a", to: "root", label: "volta", style: "dashed" },
      { op: "add_edge", from: "root", to: "a" },
      { op: "update_edge", id: "e1", label: "ida", style: "dashed" },
      { op: "update_edge", id: "e2", label: "  ", style: "solid" },
      { op: "update_edge", id: "e1" },
      { op: "remove_edge", from: "root", to: "a" },
      { op: "set_group", id: "g1", label: "Renomeado", nodeIds: ["a", "ghost"] },
      { op: "set_group", label: "Novo", nodeIds: ["root"] },
      { op: "set_group", id: "g9", label: "Com id", nodeIds: ["root"] },
      { op: "remove_group", id: "g9" },
    ]);
    expect(doc.edges).toEqual([{ id: "e2", from: "a", to: "root" }]);
    expect(doc.groups?.[0]).toEqual({ id: "g1", label: "Renomeado", nodeIds: ["a"] });
    expect(doc.groups?.[1]).toMatchObject({ label: "Novo", nodeIds: ["root"] });
    const next = await updateCanvas(botId, id, [
      { op: "remove_edge", id: "e2" },
      { op: "remove_group", id: "g1" },
    ]);
    expect(next.doc.edges).toEqual([]);
    const { meta } = await createCanvas(botId, "Sem grupos", { nodes: [node("x", "x", { x: 0, y: 0 })], edges: [] });
    const cleared = await updateCanvas(botId, meta.id, [
      { op: "remove_group", id: "nope" },
      { op: "set_group", label: "Primeiro", nodeIds: ["x"] },
    ]);
    expect(cleared.doc.groups).toHaveLength(1);
  });

  test("relayout reorganizes everything", async () => {
    const id = await base();
    const { doc } = await updateCanvas(botId, id, [
      { op: "add_node", id: "b", text: "B", parent: "a" },
      { op: "relayout" },
    ]);
    expect(byId(doc, "root").y).toBeLessThan(byId(doc, "a").y);
    expect(byId(doc, "a").y).toBeLessThan(byId(doc, "b").y);
  });

  test("operation errors", async () => {
    const id = await base();
    const cases: Array<[Parameters<typeof updateCanvas>[2], string]> = [
      [[{ op: "add_node", id: "a", text: "x" }], 'Operação 1: já existe caixa "a".'],
      [[{ op: "add_node", text: "x", parent: "ghost" }], 'não existe caixa "ghost"'],
      [[{ op: "update_node", id: "ghost" }], 'não existe caixa "ghost"'],
      [[{ op: "remove_node", id: "ghost" }], 'não existe caixa "ghost"'],
      [[{ op: "add_edge", from: "a", to: "ghost" }], 'não existe caixa "ghost"'],
      [[{ op: "add_edge", from: "a", to: "a" }], "duas caixas diferentes"],
      [[{ op: "add_edge", id: "e1", from: "a", to: "root" }], 'já existe conexão "e1"'],
      [[{ op: "update_edge", id: "ghost" }], 'não existe conexão "ghost"'],
      [[{ op: "relayout" }, { op: "remove_edge", id: "ghost" }], "Operação 2: conexão não encontrada."],
    ];
    for (const [ops, message] of cases)
      expect((await failure(updateCanvas(botId, id, ops))).message).toContain(message);
    const meta = (await readArtifact(botId, id)) as ArtifactMeta;
    expect(meta.versions).toHaveLength(1);
  });

  test("rejects growing past the node limit", async () => {
    const nodes = Array.from({ length: 400 }, (_, index) => node(`n${index}`, "x", { x: index * 200, y: 0 }));
    const { meta } = await createCanvas(botId, "Cheio", { nodes, edges: [] });
    await expect(updateCanvas(botId, meta.id, [{ op: "add_node", text: "mais", x: 0, y: 900 }])).rejects.toThrow(
      "máximo 400 caixas",
    );
  });

  test("reports the person's edits made before the bot update", async () => {
    const id = await base();
    const current = (await readCanvasForBot(botId, id)).doc;
    const edited = structuredClone(current);
    byId(edited, "a").text = "Editado";
    await saveUserCanvas(botId, id, { doc: edited });
    const { userEdits } = await updateCanvas(botId, id, [{ op: "update_node", id: "root", text: "R" }]);
    expect(userEdits).toBe('1 caixa renomeada ("A" → "Editado")');
  });

  test("places new nodes in a mindmap away from the root direction", async () => {
    const { meta } = await createCanvas(botId, "Mente", {
      layout: "mindmap",
      nodes: [node("root"), node("a"), node("b")],
      edges: [edge("root", "a"), edge("root", "b")],
    });
    const { doc } = await updateCanvas(botId, meta.id, [
      { op: "add_node", id: "c", text: "c", parent: "root" },
      { op: "add_node", id: "a1", text: "a1", parent: "a" },
      { op: "add_node", id: "a2", text: "a2", parent: "a" },
      { op: "add_node", id: "a3", text: "a3", parent: "a" },
    ]);
    const root = byId(doc, "root");
    const a = byId(doc, "a");
    const a1 = byId(doc, "a1");
    const distance = (n: CanvasNode) => Math.hypot(n.x - root.x, n.y - root.y);
    expect(distance(a1)).toBeGreaterThan(distance(a));
    noOverlaps(doc);
  });

  test("places a node at the origin when nothing else is left and stacks unlinked nodes", async () => {
    const { meta } = await createCanvas(botId, "Só", { nodes: [node("x", "x", { x: 0, y: 0 })], edges: [] });
    const first = await updateCanvas(botId, meta.id, [
      { op: "remove_node", id: "x" },
      { op: "add_node", id: "y", text: "y" },
    ]);
    expect([byId(first.doc, "y").x, byId(first.doc, "y").y]).toEqual([0, 0]);
    const stacked = await updateCanvas(botId, meta.id, [
      { op: "add_node", id: "p", text: "p" },
      { op: "add_node", id: "q", text: "q" },
      { op: "add_edge", from: "p", to: "q" },
    ]);
    for (const id of ["p", "q"]) expect(byId(stacked.doc, id).x).toBeGreaterThan(byId(stacked.doc, "y").x);
  });

  test("stacks unlinked nodes down when the right side is occupied", async () => {
    const { meta } = await createCanvas(botId, "Cheio à direita", {
      nodes: [node("a", "a", { x: 0, y: 0 }), node("tall", "t", { x: 0, y: 0, w: 100, h: 800 })],
      edges: [],
    });
    const { doc } = await updateCanvas(botId, meta.id, [
      { op: "add_node", id: "n1", text: "n1" },
      { op: "add_node", id: "n2", text: "n2" },
    ]);
    const right = Math.max(...["a", "tall"].map((id) => byId(doc, id).x + byId(doc, id).w));
    expect(byId(doc, "n1").x).toBeGreaterThanOrEqual(right);
    expect(byId(doc, "n1").y).toBe(0);
  });

  test("serializes concurrent updates and recovers after a failed one", async () => {
    const id = await base();
    const results = await Promise.allSettled([
      updateCanvas(botId, id, [{ op: "update_node", id: "ghost" }]),
      updateCanvas(botId, id, [{ op: "add_node", id: "b", text: "B", x: 0, y: 500 }]),
      updateCanvas(botId, id, [{ op: "add_node", id: "c", text: "C", x: 0, y: 900 }]),
    ]);
    expect(results.map((item) => item.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    const meta = (await readArtifact(botId, id)) as ArtifactMeta;
    expect(meta.versions.map((item) => item.n)).toEqual([1, 2, 3]);
  });
});

describe("canvasEditNote", () => {
  test("is empty without canvases or edits", async () => {
    expect(await canvasEditNote(botId)).toBe("");
    await createCanvas(botId, "Só do bot", { nodes: [node("a", "a", { x: 0, y: 0 })], edges: [] });
    await artifacts.createArtifact(botId, "Página", "page", html);
    expect(await canvasEditNote(botId)).toBe("");
  });

  test("summarizes person edits once", async () => {
    const { meta, doc } = await createCanvas(botId, "Plano", {
      nodes: [node("a", "A", { x: 0, y: 0 })],
      edges: [],
    });
    const edited = structuredClone(doc);
    byId(edited, "a").text = "B";
    await saveUserCanvas(botId, meta.id, { doc: edited });
    const note = await canvasEditNote(botId);
    expect(note).toBe(
      [
        "## Canvas editado pela pessoa",
        `- O canvas "Plano" (${meta.id}) foi editado pela pessoa: 1 caixa renomeada ("A" → "B").`,
        "Respeite essas edições: use canvas_read antes de mudar esse canvas e não desfaça o que a pessoa mudou.",
      ].join("\n"),
    );
    expect((await readArtifact(botId, meta.id))?.canvas).toEqual({ seen: 1, notified: 2 });
    expect(await canvasEditNote(botId)).toBe("");
  });

  test("falls back to small changes, skips unreadable versions and missing metas", async () => {
    const { meta, doc } = await createCanvas(botId, "Pequeno", {
      nodes: [node("a", "A", { x: 0, y: 0 })],
      edges: [],
    });
    await saveUserCanvas(botId, meta.id, { doc });
    const saved = (await readArtifact(botId, meta.id)) as ArtifactMeta;
    const { canvas: _canvas, ...bare } = saved;
    await writeMeta({ ...bare, canvas: { seen: 1, notified: 1 } });
    expect(await canvasEditNote(botId)).toContain("mudanças pequenas");
    expect((await readArtifact(botId, meta.id))?.canvas).toEqual({ seen: 1, notified: 2 });

    await writeMeta({ ...bare, canvas: { seen: 1, notified: 1 } });
    await getBlobStore().delete(artifactContentKey(botId, meta.id, 2, "canvas"));
    expect(await canvasEditNote(botId)).toBe("");
  });

  test("uses notified and seen defaults when the meta lacks canvas state", async () => {
    const { meta, doc } = await createCanvas(botId, "Sem estado", {
      nodes: [node("a", "A", { x: 0, y: 0 })],
      edges: [],
    });
    await saveUserCanvas(botId, meta.id, { doc });
    const saved = (await readArtifact(botId, meta.id)) as ArtifactMeta;
    await writeMeta({ ...saved, canvas: { seen: 0, notified: 0 } });
    const note = await canvasEditNote(botId);
    expect(note).toContain("mudanças pequenas");
    const { canvas: _canvas, ...bare } = saved;
    await writeMeta(bare);
    expect(await canvasEditNote(botId)).toBe("");
  });
});

describe("canvasTools", () => {
  test("canvas_create runs and labels", async () => {
    const create = tool("canvas_create");
    expect(create.label({ title: "Mapa" })).toBe("Criar canvas: Mapa");
    expect(create.label({})).toBe("Criar canvas: ");
    expect(withLanguage("en", () => create.label({ title: "Map" }))).toBe("Create canvas: Map");
    expect(create.approval).toBeNull();
    const out = (await create.run(
      {
        title: "  Mapa  ",
        kind: "mindmap",
        nodes: [node("r", "Raiz"), node("a", "A")],
        edges: [edge("r", "a")],
        groups: [{ label: "G", nodeIds: ["r"] }],
      },
      signal,
    )) as Record<string, unknown>;
    expect(out).toMatchObject({ title: "Mapa", kind: "canvas", version: 1, nodes: 2, edges: 1 });
    expect(out.artifactEvent).toMatchObject({ type: "artifact.created", data: { title: "Mapa", version: 1 } });
    const plain = (await create.run({ title: "D", nodes: [node("x")], edges: [] }, signal)) as Record<string, unknown>;
    expect(plain.nodes).toBe(1);
  });

  test("canvas_read returns the compact doc and person edits", async () => {
    const { meta, doc } = await createCanvas(botId, "Ler", {
      nodes: [node("a", "A", { x: 0, y: 0, color: "red" }), node("b", "B", { x: 300, y: 0 })],
      edges: [edge("a", "b", { id: "ab", label: "l", style: "dashed" })],
      groups: [{ id: "g", label: "G", nodeIds: ["a"] }],
    });
    const read = tool("canvas_read");
    expect(read.label({})).toBe("Ler canvas");
    const first = (await read.run({ id: meta.id }, signal)) as Record<string, unknown>;
    expect(first.editedByPerson).toBeUndefined();
    expect(first.doc).toEqual({
      layout: "diagram",
      nodes: [
        { id: "a", text: "A", shape: "box", color: "red", x: 0, y: 0, w: byId(doc, "a").w, h: byId(doc, "a").h },
        { id: "b", text: "B", shape: "box", x: 300, y: 0, w: byId(doc, "b").w, h: byId(doc, "b").h },
      ],
      edges: [{ id: "ab", from: "a", to: "b", label: "l", style: "dashed" }],
      groups: [{ id: "g", label: "G", nodeIds: ["a"] }],
    });
    const edited = structuredClone(doc);
    edited.edges = [];
    edited.groups = [];
    await saveUserCanvas(botId, meta.id, { doc: edited });
    const second = (await read.run({ id: meta.id }, signal)) as Record<string, unknown>;
    expect(second.editedByPerson).toBe("−1 conexão");
    expect(second.version).toBe(2);
    expect((second.doc as Record<string, unknown>).groups).toBeUndefined();
    expect((second.doc as Record<string, unknown>).edges).toEqual([]);
  });

  test("canvas_update applies ops and reports earlier person edits", async () => {
    const { meta, doc } = await createCanvas(botId, "Atualizar", {
      nodes: [node("a", "A", { x: 0, y: 0 })],
      edges: [],
    });
    const update = tool("canvas_update");
    expect(update.label({})).toBe("Atualizar canvas");
    const plain = (await update.run(
      { id: meta.id, ops: [{ op: "add_node", text: "B", parent: "a" }] },
      signal,
    )) as Record<string, unknown>;
    expect(plain).toMatchObject({ version: 2, nodes: 2, edges: 1, title: "Atualizar" });
    expect(plain.editedByPersonBefore).toBeUndefined();
    const edited = structuredClone(doc);
    byId(edited, "a").text = "Z";
    await saveUserCanvas(botId, meta.id, { doc: edited });
    const out = (await update.run(
      { id: meta.id, ops: [{ op: "add_node", text: "C", parent: "a" }], title: "Novo" },
      signal,
    )) as Record<string, unknown>;
    expect(out.title).toBe("Novo");
    expect(out.editedByPersonBefore).toContain("caixa renomeada");
    expect(out.artifactEvent).toMatchObject({ type: "artifact.updated", data: { version: 4 } });
  });

  test("guide mentions the tools", () => {
    expect(canvasGuide).toContain("canvas_create");
    expect(canvasGuide).toContain("canvas_update");
  });
});
