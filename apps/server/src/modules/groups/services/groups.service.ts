import { randomBytes } from "node:crypto";
import { ValidationError } from "../../../shared/errors";
import { getBot, isActive } from "../../bots/services/bots.service";
import { loadGroupRows, saveGroupRow } from "../repositories/groups.repository";

export interface Group {
  id: string;
  name: string;
  members: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

let groups: Group[] = [];

export async function loadGroups() {
  groups = loadGroupRows();
}

function save(group: Group) {
  saveGroupRow(group);
}

export function getGroup(id: string) {
  return groups.find((group) => group.id === id);
}

export function listGroups(includeArchived = false) {
  return groups.filter((group) => includeArchived || !group.archivedAt);
}

export function isGroupId(id: string) {
  return id.startsWith("grp_");
}

export function activeMembers(group: Group) {
  return group.members.map((id) => getBot(id)).filter((bot) => isActive(bot));
}

function validName(value: unknown) {
  if (typeof value !== "string" || !value.trim())
    throw new ValidationError("O nome do grupo não pode ficar vazio.", "name");
  if (value.trim().length > 40) throw new ValidationError("O nome do grupo pode ter no máximo 40 caracteres.", "name");
  return value.trim();
}

function validMembers(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new ValidationError("members precisa ser uma lista de ids de bots.", "members");
  const members = [...new Set(value as string[])];
  if (members.length < 2) throw new ValidationError("Um grupo precisa de pelo menos dois bots.", "members");
  if (members.length > 8) throw new ValidationError("Um grupo pode ter no máximo 8 bots.", "members");
  for (const id of members) {
    if (!isActive(getBot(id))) throw new ValidationError(`Não existe bot ativo com id "${id}".`, "members");
  }
  return members;
}

function body(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Corpo inválido.", "body");
  return value as Record<string, unknown>;
}

export async function createGroup(input: unknown) {
  const raw = body(input);
  const now = new Date().toISOString();
  const group: Group = {
    id: `grp_${randomBytes(6).toString("hex")}`,
    name: validName(raw.name),
    members: validMembers(raw.members),
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  groups.push(group);
  save(group);
  return group;
}

export async function updateGroup(id: string, input: unknown) {
  const group = getGroup(id);
  if (!group) return null;
  const raw = body(input);
  for (const key of Object.keys(raw)) {
    if (!["name", "members"].includes(key)) throw new ValidationError(`Campo desconhecido: ${key}.`, key);
  }
  if (raw.name !== undefined) group.name = validName(raw.name);
  if (raw.members !== undefined) group.members = validMembers(raw.members);
  group.updatedAt = new Date().toISOString();
  save(group);
  return group;
}

export async function setGroupArchived(id: string, archived: boolean) {
  const group = getGroup(id);
  if (!group) return null;
  group.archivedAt = archived ? (group.archivedAt ?? new Date().toISOString()) : null;
  group.updatedAt = new Date().toISOString();
  save(group);
  return group;
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function mentionedMembers(text: string, members: { id: string; name: string }[]) {
  const plain = normalize(text);
  const hits: { id: string; index: number }[] = [];
  for (const member of members) {
    const names = [...new Set([member.id, normalize(member.name)])];
    let best = -1;
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const at = plain.search(new RegExp(`@${escaped}\\b`));
      const lead = plain.search(new RegExp(`^\\s*${escaped}\\s*[,:!-]`));
      const vocative = plain.search(new RegExp(`(?:^|[\\s,;.!?])${escaped}\\s*,`));
      for (const index of [at, lead, vocative]) if (index >= 0 && (best < 0 || index < best)) best = index;
    }
    if (best >= 0) hits.push({ id: member.id, index: best });
  }
  return hits.sort((a, b) => a.index - b.index).map((hit) => hit.id);
}
