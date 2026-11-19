import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ValidationError } from "./bots";
import { dataDir } from "./config";
import { readJson, writeJson } from "./json-file";

export interface Section {
  id: string;
  name: string;
  order: number;
  createdAt: string;
  archivedAt: string | null;
}

const file = join(dataDir, "sections.json");
let sections: Section[] = [];

export async function loadSections() {
  sections = await readJson<Section[]>(file, []);
}

function save() {
  return writeJson(file, sections);
}

export function publicSection(section: Section) {
  return { id: section.id, name: section.name, order: section.order };
}

export function listSections() {
  return sections.filter((section) => !section.archivedAt).sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}

export function sectionExists(id: string) {
  return sections.some((section) => section.id === id && !section.archivedAt);
}

function validName(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError("O nome da seção não pode ficar vazio.", "name");
  if (value.trim().length > 40) throw new ValidationError("O nome da seção pode ter no máximo 40 caracteres.", "name");
  return value.trim();
}

function validOrder(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new ValidationError("order precisa ser um inteiro entre 0 e 10000.", "order");
  }
  return value;
}

function body(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Corpo inválido.", "body");
  return value as Record<string, unknown>;
}

export async function createSection(input: unknown) {
  const raw = body(input);
  const active = listSections();
  const section: Section = {
    id: `sec_${randomBytes(6).toString("hex")}`,
    name: validName(raw.name),
    order: raw.order === undefined ? (active.at(-1)?.order ?? -1) + 1 : validOrder(raw.order),
    createdAt: new Date().toISOString(),
    archivedAt: null,
  };
  sections.push(section);
  await save();
  return section;
}

export async function updateSection(id: string, input: unknown) {
  const section = sections.find((item) => item.id === id && !item.archivedAt);
  if (!section) return null;
  const raw = body(input);
  for (const key of Object.keys(raw)) {
    if (!["name", "order"].includes(key)) throw new ValidationError(`Campo desconhecido: ${key}.`, key);
  }
  if (raw.name !== undefined) section.name = validName(raw.name);
  if (raw.order !== undefined) section.order = validOrder(raw.order);
  await save();
  return section;
}

export async function archiveSection(id: string) {
  const section = sections.find((item) => item.id === id && !item.archivedAt);
  if (!section) return null;
  section.archivedAt = new Date().toISOString();
  await save();
  return section;
}
