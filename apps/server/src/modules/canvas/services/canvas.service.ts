import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  type ArtifactEvent,
  type ArtifactMeta,
  eventOf,
  listArtifacts,
  readArtifact,
  readArtifactContent,
  saveArtifactMeta,
  writeArtifactContent,
} from "../../artifacts/services/artifacts.service";
import type { BotTool } from "../../engine/services/bot-tools.service";

export type CanvasLayout = "flow" | "mindmap" | "diagram";
export type NodeShape = "box" | "round" | "diamond" | "ellipse" | "note";
export type EdgeStyle = "solid" | "dashed";

export interface CanvasNode {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: NodeShape;
  color?: string;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  style?: EdgeStyle;
}

export interface CanvasGroup {
  id: string;
  label: string;
  nodeIds: string[];
}

export interface CanvasDoc {
  schema: 1;
  layout: CanvasLayout;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  groups?: CanvasGroup[];
}

export class CanvasError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid",
  ) {
    super(message);
  }
}

const layouts = ["flow", "mindmap", "diagram"] as const;
const shapes = ["box", "round", "diamond", "ellipse", "note"] as const;
const styles = ["solid", "dashed"] as const;
export const canvasColors = [
  "neutral",
  "grey",
  "red",
  "orange",
  "amber",
  "yellow",
  "green",
  "teal",
  "blue",
  "indigo",
  "violet",
  "pink",
] as const;
const maxNodes = 400;
const maxEdges = 800;
const userMergeWindowMs = 120_000;

const locks = new Map<string, Promise<unknown>>();

function locked<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const tail = next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  });
  tail.catch(() => undefined);
  locks.set(key, tail);
  return next;
}

function newId(prefix: string) {
  return `${prefix}${randomBytes(4).toString("hex")}`;
}

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(-1_000_000, Math.min(1_000_000, value))
    : fallback;
}

function cleanText(value: unknown, max = 300) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .slice(0, max);
}

function cleanColor(value: unknown) {
  return typeof value === "string" && (canvasColors as readonly string[]).includes(value) ? value : undefined;
}

const charWidth = 9.4;
const wrapWidth = 200;
const lineHeight = 24;

function wrapLines(text: string) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && candidate.length * charWidth > wrapWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function sizeFor(text: string, shape: NodeShape) {
  const lines = wrapLines(text);
  const textWidth = Math.max(32, ...lines.map((line) => line.length * charWidth)) + 4;
  const textHeight = Math.max(1, lines.length) * lineHeight;
  let w: number;
  let h: number;
  if (shape === "diamond") {
    w = Math.max(150, textWidth * 1.5 + 48);
    h = Math.max(100, textHeight * 1.6 + 40);
  } else if (shape === "ellipse") {
    w = Math.max(130, textWidth * 1.25 + 44);
    h = Math.max(60, textHeight * 1.25 + 24);
  } else {
    w = Math.max(120, textWidth + 36);
    h = Math.max(56, textHeight + 28);
  }
  return { w: Math.round(w), h: Math.round(h) };
}

function sanitize(raw: unknown): CanvasDoc {
  if (!raw || typeof raw !== "object") throw new CanvasError("Mande o documento do canvas.");
  const input = raw as Record<string, unknown>;
  const layout = (layouts as readonly string[]).includes(String(input.layout))
    ? (input.layout as CanvasLayout)
    : "diagram";
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  const rawEdges = Array.isArray(input.edges) ? input.edges : [];
  if (rawNodes.length > maxNodes) throw new CanvasError(`Canvas grande demais (máximo ${maxNodes} caixas).`);
  if (rawEdges.length > maxEdges) throw new CanvasError(`Canvas grande demais (máximo ${maxEdges} conexões).`);
  const seen = new Set<string>();
  const nodes: CanvasNode[] = [];
  for (const item of rawNodes as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    let id = cleanText(item.id, 60).trim() || newId("n");
    while (seen.has(id)) id = newId("n");
    seen.add(id);
    const shape = (shapes as readonly string[]).includes(String(item.shape)) ? (item.shape as NodeShape) : "box";
    const text = cleanText(item.text);
    const size = sizeFor(text, shape);
    const color = cleanColor(item.color);
    nodes.push({
      id,
      text,
      x: Math.round(finite(item.x, 0)),
      y: Math.round(finite(item.y, 0)),
      w: Math.round(Math.max(40, Math.min(1200, finite(item.w, size.w)))),
      h: Math.round(Math.max(28, Math.min(900, finite(item.h, size.h)))),
      shape,
      ...(color ? { color } : {}),
    });
  }
  const edgeIds = new Set<string>();
  const edges: CanvasEdge[] = [];
  for (const item of rawEdges as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    const from = String(item.from ?? "");
    const to = String(item.to ?? "");
    if (!seen.has(from) || !seen.has(to) || from === to) continue;
    let id = cleanText(item.id, 60).trim() || newId("e");
    while (edgeIds.has(id)) id = newId("e");
    edgeIds.add(id);
    const label = cleanText(item.label, 120).trim();
    edges.push({
      id,
      from,
      to,
      ...(label ? { label } : {}),
      ...(item.style === "dashed" ? { style: "dashed" as const } : {}),
    });
  }
  const groups: CanvasGroup[] = [];
  for (const item of (Array.isArray(input.groups) ? input.groups : []) as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    const nodeIds = (Array.isArray(item.nodeIds) ? item.nodeIds : []).map(String).filter((id) => seen.has(id));
    if (nodeIds.length === 0) continue;
    groups.push({ id: cleanText(item.id, 60).trim() || newId("g"), label: cleanText(item.label, 120), nodeIds });
  }
  return { schema: 1, layout, nodes, edges, ...(groups.length ? { groups } : {}) };
}

function center(node: CanvasNode) {
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
}

function setCenter(node: CanvasNode, x: number, y: number) {
  node.x = Math.round(x - node.w / 2);
  node.y = Math.round(y - node.h / 2);
}

function branchBias(edge: CanvasEdge) {
  const label = (edge.label ?? "").trim().toLowerCase();
  if (!label) return 0;
  if (/^(sim|yes|s|ok|aprovad|verdade|true)/.test(label)) return -1;
  if (/^(n[aã]o|no|n|recusad|falso|false)/.test(label)) return 1;
  return 0;
}

function layered(doc: CanvasDoc) {
  const ids = doc.nodes.map((node) => node.id);
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const out = new Map<string, CanvasEdge[]>(ids.map((id) => [id, []]));
  for (const edge of doc.edges) out.get(edge.from)?.push(edge);
  const state = new Map<string, number>();
  const forward: CanvasEdge[] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    for (const edge of out.get(id) ?? []) {
      const mark = state.get(edge.to) ?? 0;
      if (mark === 1) continue;
      forward.push(edge);
      if (mark === 0) visit(edge.to);
    }
    state.set(id, 2);
  };
  const incoming = new Set(doc.edges.map((edge) => edge.to));
  for (const id of ids) if (!incoming.has(id) && !state.has(id)) visit(id);
  for (const id of ids) if (!state.has(id)) visit(id);
  const realParents = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of forward) realParents.get(edge.to)!.push(edge.from);
  const layer = new Map<string, number>();
  const depth = (id: string, trail: Set<string>): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    trail.add(id);
    let value = 0;
    for (const parent of realParents.get(id) ?? [])
      if (!trail.has(parent)) value = Math.max(value, depth(parent, trail) + 1);
    trail.delete(id);
    layer.set(id, value);
    return value;
  };
  for (const id of ids) depth(id, new Set());
  const width = new Map<string, number>(doc.nodes.map((node) => [node.id, node.w]));
  const height = new Map<string, number>(doc.nodes.map((node) => [node.id, node.h]));
  const bias = new Map<string, number>();
  const parents = new Map<string, string[]>(ids.map((id) => [id, []]));
  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  const link = (from: string, to: string) => {
    children.get(from)!.push(to);
    parents.get(to)!.push(from);
  };
  forward.forEach((edge, index) => {
    const from = layer.get(edge.from)!;
    const to = layer.get(edge.to)!;
    const lean = branchBias(edge);
    let previous = edge.from;
    for (let level = from + 1; level < to; level++) {
      const dummy = `~${index}.${level}`;
      layer.set(dummy, level);
      width.set(dummy, 28);
      height.set(dummy, 0);
      parents.set(dummy, []);
      children.set(dummy, []);
      if (lean) bias.set(dummy, lean);
      link(previous, dummy);
      previous = dummy;
    }
    link(previous, edge.to);
    if (lean && to === from + 1) bias.set(edge.to, (bias.get(edge.to) ?? 0) + lean);
  });
  const layers: string[][] = [];
  for (const [id, index] of layer) {
    const row = layers[index] ?? [];
    layers[index] = row;
    row.push(id);
  }
  const position = new Map<string, number>();
  const refresh = () => {
    for (const row of layers) {
      if (!row) continue;
      row.forEach((id, index) => {
        position.set(id, index);
      });
    }
  };
  refresh();
  const barycenter = (id: string, neighbors: Map<string, string[]>) => {
    const list = neighbors.get(id) ?? [];
    const base = list.length
      ? list.reduce((sum, item) => sum + (position.get(item) ?? 0), 0) / list.length
      : (position.get(id) ?? 0);
    return base + (bias.get(id) ?? 0) * 0.6;
  };
  for (let pass = 0; pass < 8; pass++) {
    const down = pass % 2 === 0;
    const order = down
      ? layers.map((_, index) => index).slice(1)
      : layers
          .map((_, index) => index)
          .reverse()
          .slice(1);
    for (const index of order) {
      const row = layers[index];
      if (!row) continue;
      const scores = new Map(row.map((id) => [id, barycenter(id, down ? parents : children)]));
      row.sort((a, b) => scores.get(a)! - scores.get(b)!);
      refresh();
    }
  }
  const gapX = 64;
  const gapY = 96;
  const xs = new Map<string, number>();
  const tops: number[] = [];
  let top = 0;
  layers.forEach((row, index) => {
    if (!row) return;
    const rowHeight = Math.max(24, ...row.map((id) => height.get(id)!));
    const total = row.reduce((sum, id) => sum + width.get(id)!, 0) + gapX * (row.length - 1);
    let left = -total / 2;
    for (const id of row) {
      xs.set(id, left + width.get(id)! / 2);
      left += width.get(id)! + gapX;
    }
    tops[index] = top;
    for (const id of row) {
      const node = byId.get(id);
      if (node) node.y = Math.round(top + (rowHeight - node.h) / 2);
    }
    top += rowHeight + gapY;
  });
  for (let pass = 0; pass < 6; pass++) {
    const down = pass % 2 === 0;
    const rows = down ? layers.slice(1) : layers.slice(0, -1).reverse();
    const neighbors = down ? parents : children;
    for (const row of rows) {
      if (!row) continue;
      const wanted = row.map((id) => {
        const list = neighbors.get(id) ?? [];
        return list.length ? list.reduce((sum, item) => sum + xs.get(item)!, 0) / list.length : xs.get(id)!;
      });
      const placed: number[] = [];
      row.forEach((id, index) => {
        let x = wanted[index];
        if (index > 0) x = Math.max(x, placed[index - 1] + width.get(row[index - 1])! / 2 + gapX + width.get(id)! / 2);
        placed.push(x);
      });
      const shift = (wanted.reduce((a, b) => a + b, 0) - placed.reduce((a, b) => a + b, 0)) / row.length;
      row.forEach((id, index) => {
        xs.set(id, placed[index] + shift);
      });
    }
  }
  for (const id of ids) {
    const node = byId.get(id)!;
    node.x = Math.round(xs.get(id)! - node.w / 2);
  }
}

function resolveOverlaps(doc: CanvasDoc) {
  const gap = 32;
  for (let round = 0; round < 60; round++) {
    let moved = false;
    for (let i = 0; i < doc.nodes.length; i++) {
      for (let j = i + 1; j < doc.nodes.length; j++) {
        const a = doc.nodes[i];
        const b = doc.nodes[j];
        const overlapX = Math.min(a.x + a.w, b.x + b.w) + gap - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.h, b.y + b.h) + gap - Math.max(a.y, b.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        moved = true;
        const ca = center(a);
        const cb = center(b);
        if (overlapX < overlapY) {
          const push = Math.ceil(overlapX / 2);
          const sign = cb.x >= ca.x ? 1 : -1;
          a.x -= sign * push;
          b.x += sign * push;
        } else {
          const push = Math.ceil(overlapY / 2);
          const sign = cb.y >= ca.y ? 1 : -1;
          a.y -= sign * push;
          b.y += sign * push;
        }
      }
    }
    if (!moved) break;
  }
}

function rootOf(doc: CanvasDoc) {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of doc.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
  }
  const candidates = doc.nodes.filter((node) => !incoming.get(node.id));
  const pool = candidates.length ? candidates : doc.nodes;
  return pool.reduce(
    (best, node) => ((outgoing.get(node.id) ?? 0) > (outgoing.get(best.id) ?? 0) ? node : best),
    pool[0],
  );
}

function radial(doc: CanvasDoc) {
  if (doc.nodes.length === 0) return;
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, string[]>(doc.nodes.map((node) => [node.id, []]));
  for (const edge of doc.edges) {
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }
  const root = rootOf(doc);
  const children = new Map<string, string[]>();
  const level = new Map<string, number>([[root.id, 0]]);
  const queue = [root.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of adjacency.get(id) ?? []) {
      if (level.has(next)) continue;
      level.set(next, level.get(id)! + 1);
      (children.get(id) ?? children.set(id, []).get(id)!).push(next);
      queue.push(next);
    }
  }
  const leaves = new Map<string, number>();
  const count = (id: string): number => {
    const list = children.get(id) ?? [];
    const value = list.length ? list.reduce((sum, item) => sum + count(item), 0) : 1;
    leaves.set(id, value);
    return value;
  };
  const total = count(root.id);
  const maxDepth = Math.max(1, ...level.values());
  const ring = Math.max(250, (total * 120) / (2 * Math.PI * maxDepth));
  setCenter(root, 0, 0);
  const place = (id: string, start: number, end: number) => {
    const list = children.get(id) ?? [];
    let cursor = start;
    for (const child of list) {
      const share = ((end - start) * leaves.get(child)!) / leaves.get(id)!;
      const angle = cursor + share / 2;
      const radius = ring * level.get(child)!;
      setCenter(byId.get(child)!, Math.cos(angle) * radius * 1.25, Math.sin(angle) * radius);
      place(child, cursor, cursor + share);
      cursor += share;
    }
  };
  place(root.id, -Math.PI / 2, (Math.PI * 3) / 2);
  const stray = doc.nodes.filter((node) => !level.has(node.id));
  if (stray.length) {
    const bottom = Math.max(...doc.nodes.filter((node) => level.has(node.id)).map((node) => node.y + node.h)) + 120;
    let left = -(stray.reduce((sum, node) => sum + node.w + 40, 0) - 40) / 2;
    for (const node of stray) {
      node.x = Math.round(left);
      node.y = Math.round(bottom);
      left += node.w + 40;
    }
  }
}

export function layoutDoc(doc: CanvasDoc) {
  if (doc.layout === "mindmap") radial(doc);
  else layered(doc);
  resolveOverlaps(doc);
}

function overlaps(node: CanvasNode, others: CanvasNode[]) {
  return others.some(
    (other) =>
      other !== node &&
      node.x < other.x + other.w + 24 &&
      other.x < node.x + node.w + 24 &&
      node.y < other.y + other.h + 24 &&
      other.y < node.y + node.h + 24,
  );
}

function placeNew(doc: CanvasDoc, pending: Set<string>) {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const root =
    doc.layout === "mindmap" ? rootOf({ ...doc, nodes: doc.nodes.filter((node) => !pending.has(node.id)) }) : undefined;
  const placed = () => doc.nodes.filter((node) => !pending.has(node.id));
  let progress = true;
  while (pending.size && progress) {
    progress = false;
    for (const id of [...pending]) {
      const node = byId.get(id)!;
      const link = doc.edges.find(
        (edge) => (edge.to === id && !pending.has(edge.from)) || (edge.from === id && !pending.has(edge.to)),
      );
      if (!link) continue;
      const anchor = byId.get(link.to === id ? link.from : link.to)!;
      const base = center(anchor);
      let dx = 0;
      let dy = 1;
      if (doc.layout === "mindmap" && root && root.id !== anchor.id) {
        const origin = center(root);
        const length = Math.hypot(base.x - origin.x, base.y - origin.y) || 1;
        dx = (base.x - origin.x) / length;
        dy = (base.y - origin.y) / length;
      } else if (doc.layout === "mindmap") {
        const siblings = doc.edges.filter((edge) => edge.from === anchor.id).length;
        const angle = -Math.PI / 2 + siblings * 1.1;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
      }
      const distance = doc.layout === "mindmap" ? 240 : anchor.h / 2 + 88 + node.h / 2;
      setCenter(node, base.x + dx * distance * (doc.layout === "mindmap" ? 1.25 : 1), base.y + dy * distance);
      const others = placed();
      for (let step = 1; overlaps(node, others) && step < 40; step++) {
        const offset = Math.ceil(step / 2) * 72 * (step % 2 ? 1 : -1);
        setCenter(node, base.x + dx * distance + -dy * offset, base.y + dy * distance + dx * offset);
      }
      pending.delete(id);
      progress = true;
    }
  }
  for (const id of pending) {
    const node = byId.get(id)!;
    const others = placed();
    const right = others.length ? Math.max(...others.map((item) => item.x + item.w)) + 80 : 0;
    const top = others.length ? Math.min(...others.map((item) => item.y)) : 0;
    node.x = right;
    node.y = top;
    for (let step = 0; overlaps(node, others) && step < 40; step++) node.y += 80;
  }
}

export async function readCanvasDoc(botId: string, artifactId: string, version: number): Promise<CanvasDoc | null> {
  if (!Number.isInteger(version) || version < 1) return null;
  try {
    const text = await readArtifactContent({ botId, id: artifactId, kind: "canvas" }, version);
    return text === null ? null : (JSON.parse(text) as CanvasDoc);
  } catch {
    return null;
  }
}

function latestOf(meta: ArtifactMeta) {
  return meta.versions[meta.versions.length - 1];
}

async function requireCanvas(botId: string, artifactId: string) {
  const meta = await readArtifact(botId, artifactId);
  if (!meta) throw new CanvasError(`Não existe canvas ${artifactId}.`, 404, "not_found");
  if (meta.kind !== "canvas") throw new CanvasError("Esse artefato não é um canvas.", 400, "not_canvas");
  const doc = await readCanvasDoc(botId, artifactId, latestOf(meta).n);
  if (!doc) throw new CanvasError("Não consegui ler o canvas.", 500, "unreadable");
  return { meta, doc };
}

async function persist(meta: ArtifactMeta, doc: CanvasDoc, author: "bot" | "user", replaceLatest: boolean) {
  const body = JSON.stringify(doc);
  const now = new Date().toISOString();
  const last = meta.versions[meta.versions.length - 1];
  const n = replaceLatest && last ? last.n : (last?.n ?? 0) + 1;
  await writeArtifactContent(meta, n, body);
  const entry = { n, createdAt: now, size: Buffer.byteLength(body), author };
  const versions = replaceLatest && last ? [...meta.versions.slice(0, -1), entry] : [...meta.versions, entry];
  const seen = author === "bot" ? n : (meta.canvas?.seen ?? 0);
  const next: ArtifactMeta = {
    ...meta,
    updatedAt: now,
    versions,
    canvas: { seen, notified: Math.max(meta.canvas?.notified ?? 0, seen) },
  };
  await saveArtifactMeta(next);
  return next;
}

export async function createCanvas(
  botId: string,
  title: string,
  raw: { layout?: string; nodes: unknown[]; edges: unknown[]; groups?: unknown[] },
) {
  const positioned = raw.nodes.every(
    (item) =>
      item &&
      typeof item === "object" &&
      typeof (item as { x?: unknown }).x === "number" &&
      typeof (item as { y?: unknown }).y === "number",
  );
  const doc = sanitize(raw);
  if (doc.nodes.length === 0) throw new CanvasError("Mande pelo menos uma caixa.");
  if (!positioned) layoutDoc(doc);
  const id = `art_${randomBytes(9).toString("base64url")}`;
  const now = new Date().toISOString();
  const meta: ArtifactMeta = { id, botId, title, kind: "canvas", createdAt: now, updatedAt: now, versions: [] };
  return { meta: await persist(meta, doc, "bot", false), doc };
}

function describeChanges(before: CanvasDoc | null, after: CanvasDoc) {
  if (!before) return "";
  const old = new Map(before.nodes.map((node) => [node.id, node]));
  const now = new Map(after.nodes.map((node) => [node.id, node]));
  const added = after.nodes.filter((node) => !old.has(node.id));
  const removed = before.nodes.filter((node) => !now.has(node.id));
  const renamed = after.nodes.filter((node) => old.has(node.id) && old.get(node.id)!.text !== node.text);
  const moved = after.nodes.filter((node) => {
    const prior = old.get(node.id);
    return (
      prior &&
      (Math.abs(prior.x + prior.w / 2 - node.x - node.w / 2) > 4 ||
        Math.abs(prior.y + prior.h / 2 - node.y - node.h / 2) > 4)
    );
  });
  const restyled = after.nodes.filter((node) => {
    const prior = old.get(node.id);
    return prior && (prior.shape !== node.shape || prior.color !== node.color);
  });
  const key = (edge: CanvasEdge) => `${edge.from}>${edge.to}`;
  const oldEdges = new Map(before.edges.map((edge) => [key(edge), edge]));
  const newEdges = new Map(after.edges.map((edge) => [key(edge), edge]));
  const addedEdges = after.edges.filter((edge) => !oldEdges.has(key(edge)));
  const removedEdges = before.edges.filter((edge) => !newEdges.has(key(edge)));
  const relabeled = after.edges.filter(
    (edge) => oldEdges.has(key(edge)) && (oldEdges.get(key(edge))!.label ?? "") !== (edge.label ?? ""),
  );
  const quote = (text: string) => `"${text.replace(/\s+/g, " ").slice(0, 40)}"`;
  const parts: string[] = [];
  if (added.length)
    parts.push(
      `+${added.length} ${added.length === 1 ? "caixa" : "caixas"} (${added
        .slice(0, 5)
        .map((node) => quote(node.text))
        .join(", ")})`,
    );
  if (removed.length)
    parts.push(
      `−${removed.length} ${removed.length === 1 ? "caixa" : "caixas"} (${removed
        .slice(0, 5)
        .map((node) => quote(node.text))
        .join(", ")})`,
    );
  if (renamed.length)
    parts.push(
      `${renamed.length} ${renamed.length === 1 ? "caixa renomeada" : "caixas renomeadas"} (${renamed
        .slice(0, 5)
        .map((node) => `${quote(old.get(node.id)!.text)} → ${quote(node.text)}`)
        .join(", ")})`,
    );
  if (addedEdges.length)
    parts.push(
      `+${addedEdges.length} ${addedEdges.length === 1 ? "conexão" : "conexões"} (${addedEdges
        .slice(0, 5)
        .map((edge) => `${quote(now.get(edge.from)?.text ?? edge.from)} → ${quote(now.get(edge.to)?.text ?? edge.to)}`)
        .join(", ")})`,
    );
  if (removedEdges.length) parts.push(`−${removedEdges.length} ${removedEdges.length === 1 ? "conexão" : "conexões"}`);
  if (relabeled.length)
    parts.push(`${relabeled.length} ${relabeled.length === 1 ? "rótulo de seta mudou" : "rótulos de seta mudaram"}`);
  if (moved.length) parts.push(`${moved.length} ${moved.length === 1 ? "caixa movida" : "caixas movidas"}`);
  if (restyled.length)
    parts.push(
      `${restyled.length} ${restyled.length === 1 ? "caixa com forma ou cor nova" : "caixas com forma ou cor nova"}`,
    );
  return parts.join(", ");
}

const nodeInput = z.object({
  id: z.string().min(1).max(60).describe("Id curto e único, ex.: n1"),
  text: z.string().max(300).describe("Poucas palavras"),
  shape: z.enum(shapes).optional().describe("box (padrão), round, diamond (decisão), ellipse (início/fim), note"),
  color: z.enum(canvasColors).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

const edgeInput = z.object({
  id: z.string().min(1).max(60).optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().max(120).optional(),
  style: z.enum(styles).optional(),
});

const groupInput = z.object({
  id: z.string().min(1).max(60).optional(),
  label: z.string().max(120),
  nodeIds: z.array(z.string()).min(1),
});

const opInput = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_node"),
    id: z.string().min(1).max(60).optional(),
    text: z.string().max(300),
    shape: z.enum(shapes).optional(),
    color: z.enum(canvasColors).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    parent: z.string().optional().describe("Id de uma caixa existente; cria a conexão parent → nova caixa"),
  }),
  z.object({
    op: z.literal("update_node"),
    id: z.string().min(1),
    text: z.string().max(300).optional(),
    shape: z.enum(shapes).optional(),
    color: z.enum(canvasColors).nullable().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({ op: z.literal("remove_node"), id: z.string().min(1) }),
  z.object({
    op: z.literal("add_edge"),
    id: z.string().min(1).max(60).optional(),
    from: z.string().min(1),
    to: z.string().min(1),
    label: z.string().max(120).optional(),
    style: z.enum(styles).optional(),
  }),
  z.object({
    op: z.literal("update_edge"),
    id: z.string().min(1),
    label: z.string().max(120).optional(),
    style: z.enum(styles).optional(),
  }),
  z.object({
    op: z.literal("remove_edge"),
    id: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  }),
  z.object({
    op: z.literal("set_group"),
    id: z.string().optional(),
    label: z.string().max(120),
    nodeIds: z.array(z.string()).min(1),
  }),
  z.object({ op: z.literal("remove_group"), id: z.string().min(1) }),
  z.object({ op: z.literal("relayout") }),
]);

type CanvasOp = z.infer<typeof opInput>;

function applyOps(source: CanvasDoc, ops: CanvasOp[]) {
  const doc: CanvasDoc = structuredClone(source);
  const pending = new Set<string>();
  let relayout = false;
  const nodeOf = (id: string, index: number) => {
    const node = doc.nodes.find((item) => item.id === id);
    if (!node) throw new CanvasError(`Operação ${index + 1}: não existe caixa "${id}". Leia o canvas com canvas_read.`);
    return node;
  };
  ops.forEach((op, index) => {
    switch (op.op) {
      case "add_node": {
        const id = op.id ?? newId("n");
        if (doc.nodes.some((item) => item.id === id))
          throw new CanvasError(`Operação ${index + 1}: já existe caixa "${id}".`);
        const shape = op.shape ?? "box";
        const node: CanvasNode = {
          id,
          text: op.text,
          x: Math.round(op.x ?? 0),
          y: Math.round(op.y ?? 0),
          shape,
          ...sizeFor(op.text, shape),
          ...(op.color ? { color: op.color } : {}),
        };
        doc.nodes.push(node);
        if (op.x === undefined || op.y === undefined) pending.add(id);
        if (op.parent) {
          nodeOf(op.parent, index);
          doc.edges.push({ id: newId("e"), from: op.parent, to: id });
        }
        break;
      }
      case "update_node": {
        const node = nodeOf(op.id, index);
        if (op.text !== undefined) node.text = op.text;
        if (op.shape) node.shape = op.shape;
        if (op.text !== undefined || op.shape) Object.assign(node, sizeFor(node.text, node.shape));
        if (op.color === null) delete node.color;
        else if (op.color) node.color = op.color;
        if (op.x !== undefined) node.x = Math.round(op.x);
        if (op.y !== undefined) node.y = Math.round(op.y);
        break;
      }
      case "remove_node": {
        nodeOf(op.id, index);
        doc.nodes = doc.nodes.filter((item) => item.id !== op.id);
        doc.edges = doc.edges.filter((edge) => edge.from !== op.id && edge.to !== op.id);
        if (doc.groups)
          doc.groups = doc.groups
            .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => id !== op.id) }))
            .filter((group) => group.nodeIds.length);
        pending.delete(op.id);
        break;
      }
      case "add_edge": {
        nodeOf(op.from, index);
        nodeOf(op.to, index);
        if (op.from === op.to)
          throw new CanvasError(`Operação ${index + 1}: a conexão precisa ligar duas caixas diferentes.`);
        const id = op.id ?? newId("e");
        if (doc.edges.some((edge) => edge.id === id))
          throw new CanvasError(`Operação ${index + 1}: já existe conexão "${id}".`);
        doc.edges.push({
          id,
          from: op.from,
          to: op.to,
          ...(op.label ? { label: op.label } : {}),
          ...(op.style === "dashed" ? { style: "dashed" as const } : {}),
        });
        break;
      }
      case "update_edge": {
        const edge = doc.edges.find((item) => item.id === op.id);
        if (!edge) throw new CanvasError(`Operação ${index + 1}: não existe conexão "${op.id}".`);
        if (op.label !== undefined) {
          if (op.label.trim()) edge.label = op.label;
          else delete edge.label;
        }
        if (op.style === "dashed") edge.style = "dashed";
        else if (op.style === "solid") delete edge.style;
        break;
      }
      case "remove_edge": {
        const before = doc.edges.length;
        doc.edges = doc.edges.filter(
          (edge) => !(op.id ? edge.id === op.id : edge.from === op.from && edge.to === op.to),
        );
        if (doc.edges.length === before) throw new CanvasError(`Operação ${index + 1}: conexão não encontrada.`);
        break;
      }
      case "set_group": {
        const nodeIds = op.nodeIds.filter((id) => doc.nodes.some((node) => node.id === id));
        const groups = doc.groups ?? [];
        const existing = op.id ? groups.find((group) => group.id === op.id) : undefined;
        if (existing) Object.assign(existing, { label: op.label, nodeIds });
        else groups.push({ id: op.id ?? newId("g"), label: op.label, nodeIds });
        doc.groups = groups;
        break;
      }
      case "remove_group": {
        doc.groups = (doc.groups ?? []).filter((group) => group.id !== op.id);
        break;
      }
      case "relayout":
        relayout = true;
        break;
    }
  });
  if (doc.nodes.length > maxNodes) throw new CanvasError(`Canvas grande demais (máximo ${maxNodes} caixas).`);
  if (relayout) layoutDoc(doc);
  else if (pending.size) placeNew(doc, pending);
  return doc;
}

export async function updateCanvas(botId: string, artifactId: string, ops: CanvasOp[], title?: string) {
  return locked(`${botId}/${artifactId}`, async () => {
    const { meta, doc } = await requireCanvas(botId, artifactId);
    const seen = meta.canvas?.seen ?? latestOf(meta).n;
    const userEdits = latestOf(meta).n > seen ? describeChanges(await readCanvasDoc(botId, artifactId, seen), doc) : "";
    const next = applyOps(doc, ops);
    const saved = await persist({ ...meta, title: title?.trim() || meta.title }, next, "bot", false);
    return { meta: saved, doc: next, userEdits };
  });
}

export async function readCanvasForBot(botId: string, artifactId: string) {
  return locked(`${botId}/${artifactId}`, async () => {
    const { meta, doc } = await requireCanvas(botId, artifactId);
    const latest = latestOf(meta).n;
    const seen = meta.canvas?.seen ?? latest;
    const userEdits = latest > seen ? describeChanges(await readCanvasDoc(botId, artifactId, seen), doc) : "";
    if (latest !== seen || meta.canvas?.notified !== latest) {
      const next: ArtifactMeta = { ...meta, canvas: { seen: latest, notified: latest } };
      await saveArtifactMeta(next);
    }
    return { meta, doc, userEdits, version: latest };
  });
}

export async function saveUserCanvas(botId: string, artifactId: string, body: unknown) {
  const input = (body ?? {}) as { doc?: unknown; baseVersion?: unknown };
  const doc = sanitize(input.doc);
  return locked(`${botId}/${artifactId}`, async () => {
    const { meta } = await requireCanvas(botId, artifactId);
    const last = latestOf(meta);
    const base = typeof input.baseVersion === "number" ? input.baseVersion : last.n;
    if (base < last.n && last.author !== "user") {
      throw new CanvasError("O canvas mudou enquanto você editava. Recarregue para ver a versão nova.", 409, "stale");
    }
    const seen = meta.canvas?.seen ?? 0;
    const merge =
      last.author === "user" && last.n > seen && Date.now() - Date.parse(last.createdAt) < userMergeWindowMs;
    const saved = await persist(meta, doc, "user", merge);
    return { meta: saved, doc, event: eventOf("artifact.updated", saved) };
  });
}

export function layoutPreview(body: unknown) {
  const doc = sanitize((body as { doc?: unknown } | undefined)?.doc);
  layoutDoc(doc);
  return doc;
}

export async function canvasEditNote(botId: string) {
  const items = (await listArtifacts(botId)).filter((meta) => meta.kind === "canvas");
  const lines: string[] = [];
  for (const meta of items) {
    const last = latestOf(meta);
    const seen = meta.canvas?.seen ?? last.n;
    const notified = meta.canvas?.notified ?? seen;
    if (last.author !== "user" || last.n <= seen || last.n <= notified) continue;
    const [before, after] = await Promise.all([
      readCanvasDoc(botId, meta.id, seen),
      readCanvasDoc(botId, meta.id, last.n),
    ]);
    if (!after) continue;
    const summary = describeChanges(before, after) || "mudanças pequenas";
    lines.push(`- O canvas "${meta.title}" (${meta.id}) foi editado pela pessoa: ${summary}.`);
    await locked(`${botId}/${meta.id}`, async () => {
      const fresh = await readArtifact(botId, meta.id);
      if (!fresh) return;
      await saveArtifactMeta({ ...fresh, canvas: { seen: fresh.canvas?.seen ?? seen, notified: last.n } });
    });
  }
  if (!lines.length) return "";
  return [
    "## Canvas editado pela pessoa",
    ...lines,
    "Respeite essas edições: use canvas_read antes de mudar esse canvas e não desfaça o que a pessoa mudou.",
  ].join("\n");
}

function compact(doc: CanvasDoc) {
  return {
    layout: doc.layout,
    nodes: doc.nodes.map((node) => ({
      id: node.id,
      text: node.text,
      shape: node.shape,
      ...(node.color ? { color: node.color } : {}),
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
    })),
    edges: doc.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      ...(edge.label ? { label: edge.label } : {}),
      ...(edge.style ? { style: edge.style } : {}),
    })),
    ...(doc.groups?.length ? { groups: doc.groups } : {}),
  };
}

function withEvent(type: ArtifactEvent["type"], meta: ArtifactMeta, extra: Record<string, unknown>) {
  return {
    artifactId: meta.id,
    title: meta.title,
    kind: meta.kind,
    version: latestOf(meta).n,
    ...extra,
    artifactEvent: eventOf(type, meta),
  };
}

export function canvasTools(botId: string): BotTool[] {
  return [
    {
      name: "canvas_create",
      description:
        "Cria um canvas editável (mapa mental, fluxo, diagrama, arquitetura, processo) que a pessoa vê e edita no app. nodes com id curto e poucas palavras; edges ligam ids. Sem x/y o servidor organiza sozinho: mindmap radial a partir da raiz, flow e diagram em camadas de cima para baixo. Devolve o id para canvas_read e canvas_update.",
      shape: {
        title: z.string().min(1).max(120),
        kind: z
          .enum(layouts)
          .optional()
          .describe(
            "flow (processo, aprovação), mindmap (ideias a partir de um centro), diagram (arquitetura, relações). Padrão: diagram",
          ),
        nodes: z.array(nodeInput).min(1).max(maxNodes),
        edges: z.array(edgeInput).max(maxEdges),
        groups: z.array(groupInput).max(40).optional(),
      },
      approval: null,
      label: (input) => `Criar canvas: ${String(input.title ?? "")}`,
      run: async (input) => {
        const { meta, doc } = await createCanvas(botId, String(input.title).trim(), {
          layout: typeof input.kind === "string" ? input.kind : "diagram",
          nodes: input.nodes as unknown[],
          edges: input.edges as unknown[],
          ...(Array.isArray(input.groups) ? { groups: input.groups as unknown[] } : {}),
        });
        return withEvent("artifact.created", meta, { nodes: doc.nodes.length, edges: doc.edges.length });
      },
    },
    {
      name: "canvas_read",
      description:
        "Lê o estado ATUAL de um canvas, incluindo o que a pessoa editou no app. Use antes de alterar um canvas que a pessoa pode ter mexido.",
      shape: { id: z.string().min(1) },
      approval: null,
      label: () => "Ler canvas",
      run: async (input) => {
        const { meta, doc, userEdits, version } = await readCanvasForBot(botId, String(input.id));
        return {
          artifactId: meta.id,
          title: meta.title,
          version,
          ...(userEdits ? { editedByPerson: userEdits } : {}),
          doc: compact(doc),
        };
      },
    },
    {
      name: "canvas_update",
      description:
        "Muda um canvas por operações aplicadas sobre o estado atual (inclusive as edições da pessoa): add_node {text, id?, shape?, color?, parent?} (sem x/y ela é posicionada perto da caixa ligada), update_node {id, text?, shape?, color?, x?, y?}, remove_node {id}, add_edge {from, to, label?, style?}, update_edge {id, label?, style?}, remove_edge {id} ou {from, to}, set_group {label, nodeIds, id?}, remove_group {id}, relayout {} (reorganiza tudo; evite se a pessoa arrumou posições à mão).",
      shape: {
        id: z.string().min(1),
        ops: z.array(opInput).min(1).max(200),
        title: z.string().min(1).max(120).optional(),
      },
      approval: null,
      label: () => "Atualizar canvas",
      run: async (input) => {
        const { meta, doc, userEdits } = await updateCanvas(
          botId,
          String(input.id),
          input.ops as CanvasOp[],
          typeof input.title === "string" ? input.title : undefined,
        );
        return withEvent("artifact.updated", meta, {
          nodes: doc.nodes.length,
          edges: doc.edges.length,
          ...(userEdits ? { editedByPersonBefore: userEdits } : {}),
        });
      },
    },
  ];
}

export const canvasGuide = [
  "## Canvas (diagramas editáveis)",
  "Quando o pedido for lógica, fluxo, mapa mental, arquitetura ou processo, use o canvas (`canvas_create`) em vez de HTML. A pessoa vê e edita o canvas no app: move caixas, renomeia, conecta.",
  "- Poucas palavras por caixa (2 a 5). No máximo ~25 caixas; passou disso, agrupe (groups / set_group) ou divida em dois canvas.",
  "- kind: mindmap para ideias a partir de um centro (a raiz é a caixa sem setas chegando), flow para processos de cima para baixo, diagram para arquitetura e relações.",
  '- Formas: diamond para decisão (setas com label "sim"/"não"), ellipse para início e fim, round para etapas, box padrão, note para observação. Cada forma já tem cor padrão (início/fim verde, decisão amarela, etapa azul); só mande color para destacar algo diferente.',
  "- Não mande x/y: o servidor organiza. Ao mudar um canvas que a pessoa editou, chame `canvas_read` antes e use `canvas_update` com operações pontuais; não use relayout nem desfaça o que ela mudou.",
  "- Na conversa, diga em uma frase o que montou, sem repetir as caixas.",
].join("\n");
