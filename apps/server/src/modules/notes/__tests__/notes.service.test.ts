import { beforeEach, describe, expect, test } from "bun:test";
import { resetData } from "../../../../test/helpers";
import { getDb } from "../../../db";
import { noteLinks, notes } from "../../../db/tables";
import { BlockError } from "../../blocks/services/blocks.shared";
import {
  applyOps,
  cleanFolder,
  createNote,
  deleteNote,
  listNotes,
  moveNote,
  noteBacklinks,
  noteEditNote,
  noteTree,
  parseLinks,
  parseTags,
  patchNote,
  previewOf,
  readNoteForBot,
  requireNote,
  resolveNote,
  searchNotes,
  writeNote,
} from "../services/notes.service";

const bot = "bot-notes";

beforeEach(async () => {
  await resetData();
  getDb().delete(noteLinks).run();
  getDb().delete(notes).run();
});

function blockError(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BlockError);
    return error as BlockError;
  }
  throw new Error("expected a BlockError");
}

describe("parsing helpers", () => {
  test("folders, links, tags and preview", () => {
    expect(cleanFolder(" a / ./ b /../ c ")).toBe("a/b/c");
    expect(cleanFolder(undefined)).toBe("");
    expect(parseLinks("[[Plano]] e [[plano#meta|o plano]] e [[ Outro ]] e [[  ]]")).toEqual(["Plano", "Outro"]);
    expect(parseTags("#Meta e (#dev/ops) mas não `#code` nem\n```\n#bloco\n```\n#123 x#no #meta")).toEqual(["meta", "dev/ops"]);
    const long = Array.from({ length: 20 }, (_, index) => `linha ${index}`).join("\n");
    const preview = previewOf({ folder: "f", markdown: long });
    expect(preview.excerpt.split("\n")).toHaveLength(15);
    expect(preview.excerpt.endsWith("\n…")).toBe(true);
    expect(preview.words).toBe(40);
    expect(previewOf({ folder: "", markdown: "x".repeat(700) }).excerpt).toBe("\n…");
    expect(previewOf({ folder: "", markdown: "curta" })).toEqual({ kind: "note", folder: "", excerpt: "curta", words: 1 });
  });

  test("patch ops", () => {
    expect(applyOps("a b a", [{ op: "replace", old: "b", new: "c" }])).toBe("a c a");
    expect(applyOps("a b", [{ op: "replace", old: "b" }])).toBe("a ");
    expect(blockError(() => applyOps("a", [{ op: "replace", old: "" }])).message).toBe('op 1: "old" vazio.');
    expect(blockError(() => applyOps("a", [{ op: "replace", old: "z" }])).message).toBe("op 1: o trecho não foi encontrado.");
    expect(blockError(() => applyOps("a a", [{ op: "replace", old: "a" }])).message).toBe("op 1: o trecho aparece mais de uma vez.");
    expect(applyOps("a", [{ op: "append", text: "b" }])).toBe("a\nb");
    expect(applyOps("a\n", [{ op: "append", text: "b" }])).toBe("a\nb");
    expect(applyOps("", [{ op: "append" }])).toBe("");
    expect(applyOps("b", [{ op: "prepend", text: "a" }])).toBe("a\nb");
    expect(applyOps("b", [{ op: "prepend", text: "a\n" }])).toBe("a\nb");
    expect(applyOps("", [{ op: "prepend" }])).toBe("");
    expect(applyOps("# A\n## B\nx\n\n# C", [{ op: "insert_after_heading", heading: "## a", text: "y" }])).toBe(
      "# A\n## B\nx\ny\n\n# C",
    );
    expect(applyOps("# A\n", [{ op: "insert_after_heading", heading: "A" }])).toBe("# A\n\n");
    expect(blockError(() => applyOps("# A", [{ op: "insert_after_heading", heading: "Z", text: "y" }])).message).toBe(
      'op 1: o título "Z" não foi encontrado.',
    );
    expect(applyOps("- [x] a", [{ op: "toggle_task", line: 0, done: false }])).toBe("- [ ] a");
    expect(blockError(() => applyOps("texto", [{ op: "toggle_task", line: 0, done: true }])).message).toBe(
      "op 1: a linha 0 não é uma tarefa.",
    );
    expect(blockError(() => applyOps("x", [{ op: "toggle_task", line: 5, done: true }])).message).toBe(
      "op 1: a linha 5 não é uma tarefa.",
    );
    expect(blockError(() => applyOps("x", [{ op: "append", text: "y" }, { op: "spin" } as never])).message).toBe(
      "op 2: operação desconhecida.",
    );
  });
});

describe("notes", () => {
  test("create validates title and uniqueness per folder", () => {
    expect(blockError(() => createNote(bot, { title: " [[ ]] " }, "bot")).message).toBe("Título é obrigatório.");
    const { note, event } = createNote(bot, { title: "Ideias #1", folder: "a/b" }, "user");
    expect(note).toMatchObject({ title: "Ideias 1", folder: "a/b", content: "", links: [], backlinkCount: 0 });
    expect(event.data.changed).toBeUndefined();
    expect(requireNote(bot, note.id)).toMatchObject({ seenVersion: 0, userChanges: null });
    const clash = blockError(() => createNote(bot, { title: "ideias 1", folder: "a/b" }, "bot"));
    expect(clash).toMatchObject({ status: 409, code: "exists", extra: { id: note.id } });
    expect(createNote(bot, { title: "Ideias 1", folder: "c" }, "bot").note.folder).toBe("c");
    const user = createNote(bot, { title: "Com texto", content: "a\nb" }, "user");
    expect(requireNote(bot, user.note.id).userChanges).toEqual([[0, 1]]);
    expect(user.event.data.changed).toEqual({ lines: [[0, 1]] });
  });

  test("links prefer the same folder and resolve when the target is created later", () => {
    const here = createNote(bot, { title: "Alvo", folder: "x" }, "bot").note;
    createNote(bot, { title: "Alvo", folder: "y" }, "bot");
    const source = createNote(bot, { title: "Fonte", folder: "x", content: "ver [[alvo]] e [[Depois]]" }, "bot").note;
    expect(source.links).toEqual([
      { target: "alvo", id: here.id, title: "Alvo" },
      { target: "Depois", id: null, title: "Depois" },
    ]);
    const later = createNote(bot, { title: "Depois", folder: "z" }, "bot").note;
    expect(later.backlinkCount).toBe(1);
    expect(getDb().select().from(noteLinks).all().find((link) => link.targetTitle === "Depois")?.targetId).toBe(later.id);
    expect(resolveNote(bot, "ALVO", "x").id).toBe(here.id);
    expect(resolveNote(bot, "Fonte").id).toBe(source.id);
    expect(blockError(() => resolveNote(bot, "Nada")).status).toBe(404);
  });

  test("list filters by folder, tag and text, sorted by title", () => {
    createNote(bot, { title: "Beta", folder: "p", content: "texto com #tag." }, "bot");
    createNote(bot, { title: "alfa", folder: "p", content: "#tag" }, "bot");
    createNote(bot, { title: "Gama", content: "#outra conteúdo" }, "bot");
    expect(listNotes(bot, { folder: "p", sort: "title" }).items.map((item) => item.title)).toEqual(["alfa", "Beta"]);
    expect(listNotes(bot, { tag: "#TAG" }).total).toBe(2);
    expect(listNotes(bot, { tag: "  " }).total).toBe(3);
    expect(listNotes(bot, { q: "conteudo" }).items.map((item) => item.title)).toEqual(["Gama"]);
    expect(listNotes(bot, { q: "!!!" }).total).toBe(3);
    expect(listNotes(bot, { folder: null }).total).toBe(3);
    const first = listNotes(bot, { limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    expect(listNotes(bot, { cursor: first.nextCursor, limit: 2 }).items).toHaveLength(1);
  });

  test("tree shows direct subfolders with note and folder counts", () => {
    createNote(bot, { title: "Raiz" }, "bot");
    createNote(bot, { title: "A1", folder: "a" }, "bot");
    createNote(bot, { title: "A2", folder: "a/x" }, "bot");
    createNote(bot, { title: "A3", folder: "a/y/z" }, "bot");
    createNote(bot, { title: "B1", folder: "b/k" }, "bot");
    const root = noteTree(bot, {});
    expect(root.folders).toEqual([
      { name: "a", path: "a", notes: 1, folders: 2 },
      { name: "b", path: "b", notes: 0, folders: 1 },
    ]);
    expect(root.notes.items.map((item) => item.title)).toEqual(["Raiz"]);
    const inner = noteTree(bot, { folder: "a" });
    expect(inner.folder).toBe("a");
    expect(inner.folders).toEqual([
      { name: "x", path: "a/x", notes: 1, folders: 0 },
      { name: "y", path: "a/y", notes: 0, folders: 1 },
    ]);
    expect(inner.notes.items.map((item) => item.title)).toEqual(["A1"]);
  });

  test("search by body and title, with highlight ranges", () => {
    const a = createNote(bot, { title: "Reunião de time", content: "pauta: orçamento e contratação" }, "bot").note;
    const b = createNote(bot, { title: "Orçamento anual", content: "nada aqui" }, "bot").note;
    expect(searchNotes(bot, { q: "" })).toEqual({ items: [], total: 0, nextCursor: null });
    expect(searchNotes(bot, { q: 5 })).toEqual({ items: [], total: 0, nextCursor: null });
    const body = searchNotes(bot, { q: "orcamento" });
    expect(body.total).toBe(2);
    const fromBody = body.items.find((item) => item.id === a.id)!;
    expect(fromBody.snippet).toContain("orçamento");
    expect(fromBody.snippet.slice(fromBody.ranges[0][0], fromBody.ranges[0][1])).toBe("orçamento");
    const fromTitle = body.items.find((item) => item.id === b.id)!;
    expect(fromTitle.snippet).toBe("Orçamento anual");
    expect(fromTitle.ranges).toEqual([[0, 9]]);
    const titles = searchNotes(bot, { q: "reu", mode: "title" });
    expect(titles.items).toEqual([{ id: a.id, title: "Reunião de time", folder: "", snippet: "", ranges: [[0, 7]] }]);
    expect(searchNotes("other", { q: "orcamento" }).total).toBe(0);
  });

  test("write, patch and rename keep links and version rules", () => {
    const target = createNote(bot, { title: "Alvo" }, "bot").note;
    const other = createNote(bot, { title: "Outra" }, "bot").note;
    const source = createNote(bot, { title: "Fonte", content: "[[Alvo]]" }, "bot").note;
    expect(blockError(() => writeNote(bot, source.id, { content: 1 }, "bot")).message).toBe("content é obrigatório.");
    expect(blockError(() => patchNote(bot, source.id, { ops: [] }, "bot")).message).toBe("ops é obrigatório.");
    expect(blockError(() => patchNote(bot, source.id, {}, "bot")).message).toBe("ops é obrigatório.");
    expect(blockError(() => writeNote(bot, target.id, { content: "x", title: "outra" }, "bot")).status).toBe(409);
    const renamed = writeNote(bot, target.id, { content: "novo", title: "Alvo 2" }, "bot");
    expect(renamed.note).toMatchObject({ title: "Alvo 2", version: 2 });
    expect(renamed.event.data.changed).toEqual({ lines: [[0, 0]] });
    expect(getDb().select().from(noteLinks).all().find((link) => link.sourceId === source.id)?.targetId).toBeNull();
    const same = writeNote(bot, other.id, { content: "" }, "bot");
    expect(same.event.data.changed).toBeUndefined();
    const patched = patchNote(bot, source.id, { ops: [{ op: "append", text: "fim" }] }, "user");
    expect(patched.note.content).toBe("[[Alvo]]\nfim");
    expect(readNoteForBot(bot, source.id).version).toBe(2);
    expect(requireNote(bot, source.id)).toMatchObject({ seenVersion: 2, userChanges: null });
    expect(readNoteForBot(bot, source.id).version).toBe(2);
  });

  test("move renames, relinks every source including itself and handles no-ops", () => {
    const target = createNote(bot, { title: "Plano", content: "eu: [[Plano#topo|aqui]]" }, "bot").note;
    const source = createNote(bot, { title: "Diário", content: "ver [[plano]]" }, "bot").note;
    const unchanged = moveNote(bot, target.id, { folder: "", title: "Plano" }, "bot");
    expect(unchanged).toMatchObject({ relinked: 0, event: null });
    const moved = moveNote(bot, target.id, { title: "Plano 2", folder: "p" }, "user");
    expect(moved.relinked).toBe(2);
    expect(moved.note).toMatchObject({ title: "Plano 2", folder: "p", content: "eu: [[Plano 2#topo|aqui]]" });
    expect(requireNote(bot, source.id).markdown).toBe("ver [[Plano 2]]");
    expect(noteBacklinks(bot, target.id, {}).total).toBe(2);
    const folderOnly = moveNote(bot, target.id, { folder: "q" }, "bot");
    expect(folderOnly.relinked).toBe(0);
    expect(folderOnly.note.folder).toBe("q");
    expect(requireNote(bot, target.id).seenVersion).toBe(folderOnly.note.version);
    createNote(bot, { title: "Livre", folder: "q" }, "bot");
    expect(blockError(() => moveNote(bot, target.id, { title: "livre" }, "bot")).status).toBe(409);
  });

  test("backlinks list snippets and unresolved titles, and delete unlinks", () => {
    const source = createNote(bot, { title: "Fonte", content: "intro\n  veja [[Alvo|o alvo]] agora  " }, "bot").note;
    const target = createNote(bot, { title: "Alvo" }, "bot").note;
    const links = noteBacklinks(bot, target.id, {});
    expect(links.items).toEqual([{ id: source.id, title: "Fonte", folder: "", snippet: "veja [[Alvo|o alvo]] agora" }]);
    getDb().update(noteLinks).set({ targetTitle: "alvo" }).run();
    getDb().update(notes).set({ markdown: "sem link" }).run();
    expect(noteBacklinks(bot, target.id, {}).items[0].snippet).toBe("");
    deleteNote(bot, target.id, "user");
    expect(getDb().select().from(noteLinks).all()[0].targetId).toBeNull();
    expect(blockError(() => requireNote(bot, target.id)).status).toBe(404);
    expect(blockError(() => noteBacklinks(bot, target.id, {})).status).toBe(404);
  });

  test("person edits become a notice with line ranges once", () => {
    const { note } = createNote(bot, { title: "Lista", content: "a\nb\nc\nd\ne" }, "bot");
    writeNote(bot, note.id, { content: "a\nB\nC\nd\ne" }, "user");
    writeNote(bot, note.id, { content: "a\nB\nC\nd\nE" }, "user");
    const empty = createNote(bot, { title: "Vazia" }, "user").note;
    expect(noteEditNote(bot).sort()).toEqual(
      [
        `- A nota "Lista" (${note.id}) foi editada pela pessoa: linhas 2–3, 5 mudaram; use note_read antes de mudar.`,
        `- A nota "Vazia" (${empty.id}) foi editada pela pessoa: o conteúdo mudou; use note_read antes de mudar.`,
      ].sort(),
    );
    expect(noteEditNote(bot)).toEqual([]);
  });
});
