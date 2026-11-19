import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { fakeRunelay, request, startTestServer, type TestServer } from "../../../../test/helpers";
import * as runelay from "../../connectors/services/runelay.service";
import * as skills from "../services/skills.service";
import { listSkills, loadSkill, skillSlugPattern, skillsBlock } from "../services/skills.service";

let server: TestServer;
let clock = Date.now() + 10 * 60_000;

function advance(ms: number) {
  clock += ms;
  setSystemTime(new Date(clock));
}

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  setSystemTime();
  await server.close();
});

afterEach(() => {
  advance(10 * 60_000);
});

describe("skill slugs", () => {
  test("accept lowercase slugs only", () => {
    expect(skillSlugPattern.test("criar-campanha")).toBe(true);
    expect(skillSlugPattern.test("-bad")).toBe(false);
    expect(skillSlugPattern.test("Bad")).toBe(false);
  });
});

describe("listSkills", () => {
  test("walks every page, drops disabled skills, sorts and caches the full list", async () => {
    fakeRunelay.route("GET", "/skills", (call) => {
      const cursor = new URL(`http://x${call.path}`).searchParams.get("cursor");
      if (!cursor)
        return {
          data: {
            items: [
              { slug: "zeta-flow", name: "zeta-flow", description: "Primeira frase. Segunda frase." },
              { slug: "off", name: "Off", enabled: false },
            ],
            nextCursor: 2,
          },
        };
      return {
        data: {
          items: [{ slug: "alpha", name: " Alpha ", description: `${"x".repeat(200)} fim` }],
          nextCursor: null,
        },
      };
    });
    const list = await listSkills("");
    expect(list.map((item) => item.slug)).toEqual(["alpha", "zeta-flow"]);
    expect(list[0].name).toBe("Alpha");
    expect(list[0].description.endsWith("…")).toBe(true);
    expect(list[0].description.length).toBe(140);
    expect(list[1]).toEqual({ slug: "zeta-flow", name: "Zeta flow", description: "Primeira frase." });
    expect(fakeRunelay.apiCalls.map((call) => call.path)).toEqual(["/skills?limit=100", "/skills?limit=100&cursor=2"]);
    expect(await listSkills("  ")).toBe(list);
    expect(fakeRunelay.apiCalls).toHaveLength(2);
    await listSkills("", true);
    expect(fakeRunelay.apiCalls).toHaveLength(4);
  });

  test("searches one page per query and caches by term", async () => {
    fakeRunelay.route("GET", "/skills", { data: { items: [{ slug: "busca" }], nextCursor: 9 } });
    const found = await listSkills("  BUSCA ");
    expect(found).toEqual([{ slug: "busca", name: "Busca", description: "" }]);
    expect(fakeRunelay.apiCalls.map((call) => call.path)).toEqual(["/skills?limit=100&query=busca"]);
    expect(await listSkills("busca")).toBe(found);
    await listSkills("busca", true);
    expect(fakeRunelay.apiCalls).toHaveLength(2);
    advance(31_000);
    await listSkills("busca");
    expect(fakeRunelay.apiCalls).toHaveLength(3);
  });

  test("tolerates empty pages and resets the search cache when it grows", async () => {
    fakeRunelay.route("GET", "/skills", { data: null });
    expect(await listSkills("", true)).toEqual([]);
    for (let index = 0; index < 202; index++) await listSkills(`q${index}`);
    const before = fakeRunelay.apiCalls.length;
    await listSkills("q0");
    expect(fakeRunelay.apiCalls.length).toBe(before + 1);
  });
});

describe("loadSkill", () => {
  test("loads the detail once per minute", async () => {
    fakeRunelay.route("GET", "/skills/relatorio", {
      data: { slug: "relatorio", name: "Relatório", body: "passos", files: [{ path: "a.md" }] },
    });
    fakeRunelay.route("GET", "/skills/vazia", { data: { slug: "vazia" } });
    const skill = await loadSkill("relatorio");
    expect(skill).toEqual({ slug: "relatorio", name: "Relatório", body: "passos", files: ["a.md"] });
    expect(await loadSkill("relatorio")).toBe(skill);
    expect(fakeRunelay.apiCalls).toHaveLength(1);
    advance(61_000);
    await loadSkill("relatorio");
    expect(fakeRunelay.apiCalls).toHaveLength(2);
    expect(await loadSkill("vazia")).toEqual({ slug: "vazia", name: "Vazia", body: "", files: [] });
  });
});

describe("skillsBlock", () => {
  test("renders each skill with its files when they can be read", () => {
    const files = Array.from({ length: 61 }, (_, index) => `f${index}.md`);
    const block = skillsBlock(
      [
        { slug: "a", name: "A", body: "corpo", files: ["x.md"] },
        { slug: "b", name: "B", body: "y".repeat(40_001), files },
        { slug: "c", name: "C", body: "sem arquivos", files: [] },
      ],
      true,
    );
    expect(block).toContain("## Siga a skill A");
    expect(block).toContain('skill_read(slug: "a", path)');
    expect(block).toContain('[cortado; o resto está em skill_read("b")]');
    expect(block).toContain("f59.md, …");
    expect(block).not.toContain("f60.md");
    expect(block).toContain("## Siga a skill C\nA pessoa anexou esta skill à mensagem. Siga as instruções dela neste turno.\n\nsem arquivos");
    expect(skillsBlock([{ slug: "a", name: "A", body: "corpo", files: ["x.md"] }], false)).not.toContain("x.md");
  });
});

describe("GET /skills", () => {
  test("lists skills with the query and refresh flags", async () => {
    fakeRunelay.route("GET", "/skills", { data: { items: [{ slug: "rota", name: "Rota" }], nextCursor: null } });
    const response = await request("/skills?query=rota&refresh=1");
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ slug: "rota", name: "Rota", description: "" }]);
  });

  test("maps runelay errors to their status", async () => {
    fakeRunelay.route("GET", "/skills", { status: 404, body: { error: { message: "sumiu" } } });
    const missing = await request("/skills?query=nada&refresh=1");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ ok: false, error: "sumiu" });
  });

  test("answers 502 for unexpected failures and 503 when runelay is off", async () => {
    const list = spyOn(skills, "listSkills").mockRejectedValue(new Error("quebrou"));
    try {
      const failed = await request("/skills");
      expect(failed.status).toBe(502);
      expect(failed.body).toEqual({ ok: false, error: "runelay não respondeu: quebrou" });
    } finally {
      list.mockRestore();
    }
    const enabled = spyOn(runelay, "runelayEnabled").mockReturnValue(false);
    try {
      const off = await request("/skills");
      expect(off.status).toBe(503);
    } finally {
      enabled.mockRestore();
    }
  });
});
