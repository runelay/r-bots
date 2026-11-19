import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeBot } from "../../../../test/engine-helpers";
import { request, startTestServer, type TestServer } from "../../../../test/helpers";
import { ValidationError } from "../../../shared/errors";
import { getBot, updateSidebar } from "../../bots/services/bots.service";
import { loadSectionRows, saveSectionRow } from "../repositories/sections.repository";
import {
  archiveSection,
  createSection,
  listSections,
  loadSections,
  publicSection,
  sectionExists,
  updateSection,
} from "../services/sections.service";

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

type PublicSection = { id: string; name: string; order: number };

describe("sections service", () => {
  test("creates sections after the last order and lists them sorted", async () => {
    const first = await createSection({ name: "  Vendas  " });
    const second = await createSection({ name: "Ops" });
    expect(first.name).toBe("Vendas");
    expect(second.order).toBe(first.order + 1);
    const pinned = await createSection({ name: "Topo", order: 0 });
    const ids = listSections().map((section) => section.id);
    expect(ids.indexOf(pinned.id)).toBeLessThan(ids.indexOf(second.id));
    expect(publicSection(pinned)).toEqual({ id: pinned.id, name: "Topo", order: 0 });
    expect(sectionExists(first.id)).toBe(true);
  });

  test("breaks order ties by creation time", async () => {
    const early = await createSection({ name: "Empate A", order: 9000 });
    const late = await createSection({ name: "Empate B", order: 9000 });
    late.createdAt = new Date(Date.parse(early.createdAt) + 1000).toISOString();
    const ids = listSections().map((section) => section.id);
    expect(ids.indexOf(early.id)).toBeLessThan(ids.indexOf(late.id));
  });

  test("rejects invalid bodies, names and orders", async () => {
    await expect(createSection(null)).rejects.toThrow("Corpo inválido.");
    await expect(createSection([])).rejects.toThrow(ValidationError);
    await expect(createSection({ name: "   " })).rejects.toThrow("O nome da seção não pode ficar vazio.");
    await expect(createSection({ name: 5 })).rejects.toThrow("O nome da seção não pode ficar vazio.");
    await expect(createSection({ name: "x".repeat(41) })).rejects.toThrow("no máximo 40 caracteres");
    for (const order of [-1, 1.5, "2", 10_001])
      await expect(createSection({ name: "Ok", order })).rejects.toThrow("order precisa ser um inteiro");
  });

  test("updates name and order, rejecting unknown fields", async () => {
    const section = await createSection({ name: "Antes" });
    const updated = await updateSection(section.id, { name: "Depois", order: 42 });
    expect(updated).toMatchObject({ id: section.id, name: "Depois", order: 42 });
    const untouched = await updateSection(section.id, {});
    expect(untouched).toMatchObject({ name: "Depois", order: 42 });
    await expect(updateSection(section.id, { color: "red" })).rejects.toThrow("Campo desconhecido: color.");
    expect(await updateSection("sec_missing", { name: "x" })).toBeNull();
  });

  test("archives a section once and hides it", async () => {
    const section = await createSection({ name: "Velha" });
    const archived = await archiveSection(section.id);
    expect(typeof archived?.archivedAt).toBe("string");
    expect(sectionExists(section.id)).toBe(false);
    expect(listSections().some((item) => item.id === section.id)).toBe(false);
    expect(await archiveSection(section.id)).toBeNull();
    expect(await updateSection(section.id, { name: "x" })).toBeNull();
  });

  test("reloads the saved sections from the database", async () => {
    const section = await createSection({ name: "Persistida" });
    await loadSections();
    expect(listSections().find((item) => item.id === section.id)).toMatchObject({ name: "Persistida" });
  });
});

describe("sections repository", () => {
  test("round-trips updatedAt and unknown fields through extra", () => {
    saveSectionRow({
      id: "sec_repo",
      name: "Repo",
      order: 7,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      archivedAt: null,
      color: "violet",
    });
    expect(loadSectionRows().find((row) => row.id === "sec_repo")).toEqual({
      id: "sec_repo",
      name: "Repo",
      order: 7,
      createdAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-01-02T00:00:00.000Z",
      color: "violet",
    } as never);
  });

  test("fills defaults for a sparse row", () => {
    saveSectionRow({ id: "sec_sparse", createdAt: "2026-01-03T00:00:00.000Z" });
    expect(loadSectionRows().find((row) => row.id === "sec_sparse")).toEqual({
      id: "sec_sparse",
      name: "",
      order: 0,
      createdAt: "2026-01-03T00:00:00.000Z",
      archivedAt: null,
    });
  });
});

describe("sections routes", () => {
  test("creates, lists, renames and archives a section", async () => {
    const created = await request<PublicSection>("/sections", { method: "POST", body: { name: "Rota" } });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("Rota");
    const list = await request<PublicSection[]>("/sections");
    expect(list.status).toBe(200);
    expect(list.body).toContainEqual(created.body);
    const renamed = await request<PublicSection>(`/sections/${created.body.id}`, {
      method: "PATCH",
      body: { name: "Rota 2" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ ...created.body, name: "Rota 2" });

    const bot = await makeBot();
    await updateSidebar(bot.id, { sectionId: created.body.id }, sectionExists);
    const archived = await request<PublicSection & { archivedAt: string }>(`/sections/${created.body.id}/archive`, {
      method: "POST",
    });
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ id: created.body.id, name: "Rota 2" });
    expect(typeof archived.body.archivedAt).toBe("string");
    expect(getBot(bot.id)?.sidebar?.sectionId).toBeNull();
  });

  test("answers 404 for unknown sections and routes", async () => {
    const patch = await request("/sections/sec_nope", { method: "PATCH", body: { name: "x" } });
    expect(patch.status).toBe(404);
    expect(patch.body).toEqual({ ok: false, error: "Seção não encontrada." });
    const archive = await request("/sections/sec_nope/archive", { method: "POST" });
    expect(archive.status).toBe(404);
    expect(archive.body).toEqual({ ok: false, error: "Seção não encontrada." });
    expect((await request("/sections/a/b/c", { method: "DELETE" })).status).toBe(404);
  });

  test("archives even when the body is not valid JSON", async () => {
    const section = await createSection({ name: "Corpo ruim" });
    const archived = await request<{ id: string; archivedAt: string }>(`/sections/${section.id}/archive`, {
      method: "POST",
      body: "{nope",
      headers: { "content-type": "application/json" },
    });
    expect(archived.status).toBe(200);
    expect(archived.body.id).toBe(section.id);
    expect(sectionExists(section.id)).toBe(false);
  });

  test("answers 400 for invalid input and malformed JSON", async () => {
    const empty = await request("/sections", { method: "POST", body: { name: "" } });
    expect(empty.status).toBe(400);
    expect(empty.body).toMatchObject({ ok: false, field: "name" });
    const broken = await request("/sections", {
      method: "POST",
      body: "{nope",
      headers: { "content-type": "application/json" },
    });
    expect(broken.status).toBe(400);
    expect(broken.body).toEqual({ ok: false, error: "JSON inválido.", field: "body" });
  });
});
