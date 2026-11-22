import { randomBytes } from "node:crypto";
import { ValidationError } from "../../../shared/errors";
import { commonText } from "../../../shared/messages";
import { sectionsText } from "../constants/sections-messages.constants";
import { loadSectionRows, saveSectionRow } from "../repositories/sections.repository";

export interface Section {
  id: string;
  name: string;
  order: number;
  createdAt: string;
  archivedAt: string | null;
}

let sections: Section[] = [];

export async function loadSections() {
  sections = await loadSectionRows();
}

async function save(section: Section) {
  await saveSectionRow(section);
}

export function publicSection(section: Section) {
  return { id: section.id, name: section.name, order: section.order };
}

export function listSections() {
  return sections
    .filter((section) => !section.archivedAt)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}

export function sectionExists(id: string) {
  return sections.some((section) => section.id === id && !section.archivedAt);
}

function validName(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(sectionsText("nameEmpty"), "name");
  if (value.trim().length > 40) throw new ValidationError(sectionsText("nameTooLong"), "name");
  return value.trim();
}

function validOrder(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new ValidationError(sectionsText("orderInvalid"), "order");
  }
  return value;
}

function body(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError(commonText("bodyInvalid"), "body");
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
  await save(section);
  return section;
}

export async function updateSection(id: string, input: unknown) {
  const section = sections.find((item) => item.id === id && !item.archivedAt);
  if (!section) return null;
  const raw = body(input);
  for (const key of Object.keys(raw)) {
    if (!["name", "order"].includes(key)) throw new ValidationError(commonText("unknownField", { key }), key);
  }
  if (raw.name !== undefined) section.name = validName(raw.name);
  if (raw.order !== undefined) section.order = validOrder(raw.order);
  await save(section);
  return section;
}

export async function archiveSection(id: string) {
  const section = sections.find((item) => item.id === id && !item.archivedAt);
  if (!section) return null;
  section.archivedAt = new Date().toISOString();
  await save(section);
  return section;
}
