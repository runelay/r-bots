import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { makeBot } from "../../../../test/engine-helpers";
import { request, resetData, startTestServer, type TestServer } from "../../../../test/helpers";
import { getDb } from "../../../db";
import { groupMembers, groups } from "../../../db/tables";
import { setDeleted } from "../../bots/services/bots.service";
import { loadGroupRows, saveGroupRow } from "../repositories/groups.repository";
import {
  activeMembers,
  createGroup,
  getGroup,
  isGroupId,
  listGroups,
  loadGroups,
  mentionedMembers,
  setGroupArchived,
  updateGroup,
} from "../services/groups.service";

interface GroupBody {
  id: string;
  name: string;
  members: string[];
  sessionBasePath: string;
  archivedAt: string | null;
  thread: { sessionId: string; unread: number; running: boolean };
}

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await resetData();
});

async function twoBots() {
  const a = await makeBot();
  const b = await makeBot();
  return [a.id, b.id];
}

describe("groups routes", () => {
  test("creates, lists, reads, updates and archives a group", async () => {
    const members = await twoBots();
    const created = await request<GroupBody>("/groups", { method: "POST", body: { name: " Squad ", members } });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("Squad");
    expect(created.body.members).toEqual(members);
    expect(created.body.sessionBasePath).toBe(`/groups/${created.body.id}/eve/v1`);
    expect(created.body.thread.running).toBe(false);
    expect(typeof created.body.thread.sessionId).toBe("string");
    const id = created.body.id;

    const list = await request<GroupBody[]>("/groups");
    expect(list.status).toBe(200);
    expect(list.body.map((item) => item.id)).toContain(id);

    const one = await request<GroupBody>(`/groups/${id}`);
    expect(one.status).toBe(200);
    expect(one.body.thread.sessionId).toBe(created.body.thread.sessionId);

    const patched = await request<GroupBody>(`/groups/${id}`, { method: "PATCH", body: { name: "Time" } });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe("Time");

    const archived = await request<GroupBody>(`/groups/${id}/archive`, { method: "POST", body: "{broken" });
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).not.toBeNull();
    expect((await request<GroupBody[]>("/groups")).body.map((item) => item.id)).not.toContain(id);
    expect((await request<GroupBody[]>("/groups?archived=1")).body.map((item) => item.id)).toContain(id);

    const restored = await request<GroupBody>(`/groups/${id}/unarchive`, { method: "POST", body: "{}" });
    expect(restored.body.archivedAt).toBeNull();
  });

  test("thread endpoints mark read and unread", async () => {
    const group = await createGroup({ name: "Leitura", members: await twoBots() });
    const thread = await request<{ sessionId: string; running: boolean }>(`/groups/${group.id}/thread`);
    expect(thread.status).toBe(200);
    expect(thread.body.running).toBe(false);

    const unread = await request<{ unread: number }>(`/groups/${group.id}/thread/unread`, {
      method: "POST",
      body: "{broken",
    });
    expect(unread.status).toBe(200);
    expect(unread.body.unread).toBe(1);

    const read = await request<{ unread: number }>(`/groups/${group.id}/thread/read`, {
      method: "POST",
      body: "{broken",
    });
    expect(read.status).toBe(200);
    expect(read.body.unread).toBe(0);
  });

  test("eve routes reject sessions and forward the rest", async () => {
    const group = await createGroup({ name: "Eve", members: await twoBots() });
    const blocked = await request<{ ok: boolean; error: string }>(`/groups/${group.id}/eve/v1/session`, {
      method: "POST",
      body: {},
    });
    expect(blocked.status).toBe(405);
    expect(blocked.body.error).toContain("Grupos usam só a conversa do grupo");

    const missing = await request<{ code: string }>(`/groups/${group.id}/eve/v1/session/nope/events`);
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe("session_not_active");
  });

  test("unknown group, unknown route and validation errors", async () => {
    const missing = await request<{ error: string }>("/groups/grp_nothing");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("Grupo não encontrado.");

    const group = await createGroup({ name: "Erros", members: await twoBots() });
    const unknown = await request(`/groups/${group.id}/whatever`);
    expect(unknown.status).toBe(404);

    const invalid = await request<{ ok: boolean; field: string }>("/groups", { method: "POST", body: { name: "" } });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ ok: false, field: "name" });

    const badPatch = await request<{ field: string }>(`/groups/${group.id}`, { method: "PATCH", body: { color: 1 } });
    expect(badPatch.status).toBe(400);
    expect(badPatch.body.field).toBe("color");
  });
});

describe("groups service", () => {
  test("validates names and members", async () => {
    const [a, b] = await twoBots();
    await expect(createGroup(null)).rejects.toThrow("Corpo inválido.");
    await expect(createGroup([])).rejects.toThrow("Corpo inválido.");
    await expect(createGroup({ name: 3, members: [a, b] })).rejects.toThrow("não pode ficar vazio");
    await expect(createGroup({ name: "x".repeat(41), members: [a, b] })).rejects.toThrow("no máximo 40");
    await expect(createGroup({ name: "G", members: "a" })).rejects.toThrow("lista de ids");
    await expect(createGroup({ name: "G", members: [a, 1] })).rejects.toThrow("lista de ids");
    await expect(createGroup({ name: "G", members: [a, a] })).rejects.toThrow("pelo menos dois");
    const many = Array.from({ length: 9 }, (_, index) => `bot-${index}`);
    await expect(createGroup({ name: "G", members: many })).rejects.toThrow("no máximo 8");
    await expect(createGroup({ name: "G", members: [a, "ghost"] })).rejects.toThrow('id "ghost"');
  });

  test("updates members, reports missing ids and lists active members", async () => {
    const [a, b] = await twoBots();
    const c = (await makeBot()).id;
    const group = await createGroup({ name: "Membros", members: [a, b] });
    expect(isGroupId(group.id)).toBe(true);
    expect(isGroupId(a)).toBe(false);
    const updated = await updateGroup(group.id, { members: [a, b, c] });
    expect(updated?.members).toEqual([a, b, c]);
    await setDeleted(c, true);
    expect(activeMembers(group).map((bot) => bot.id)).toEqual([a, b]);
    await setDeleted(c, false);
    expect(await updateGroup("grp_missing", {})).toBeNull();
    expect(await setGroupArchived("grp_missing", true)).toBeNull();
    const archived = await setGroupArchived(group.id, true);
    const firstArchive = archived?.archivedAt;
    expect((await setGroupArchived(group.id, true))?.archivedAt).toBe(firstArchive ?? null);
    expect(listGroups().some((item) => item.id === group.id)).toBe(false);
    expect(listGroups(true).some((item) => item.id === group.id)).toBe(true);
  });

  test("persists to rows and reloads", async () => {
    const [a, b] = await twoBots();
    const group = await createGroup({ name: "Persistido", members: [a, b] });
    await loadGroups();
    expect(getGroup(group.id)).toMatchObject({ name: "Persistido", members: [a, b] });

    await saveGroupRow({
      id: "grp_extra",
      name: undefined,
      members: undefined,
      createdAt: "2026-01-01T00:00:00.000Z",
      note: "x",
    });
    const extra = (await loadGroupRows()).find((item) => item.id === "grp_extra") as unknown as Record<string, unknown>;
    expect(extra).toMatchObject({
      name: "",
      members: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      note: "x",
    });
    await getDb().delete(groupMembers);
    await getDb().delete(groups);
    expect(await loadGroupRows()).toEqual([]);
    await loadGroups();
    expect(getGroup(group.id)).toBeUndefined();
  });

  test("finds mentioned members in order", async () => {
    const members = [
      { id: "ana", name: "Ána" },
      { id: "bia", name: "Bia Souza" },
      { id: "caio", name: "Caio" },
    ];
    expect(mentionedMembers("Caio, olha isso com @ana", members)).toEqual(["caio", "ana"]);
    expect(mentionedMembers("ok, bia souza, pode ir", members)).toEqual(["bia"]);
    expect(mentionedMembers("ana: começa", members)).toEqual(["ana"]);
    expect(mentionedMembers("ninguém aqui", members)).toEqual([]);
  });
});
