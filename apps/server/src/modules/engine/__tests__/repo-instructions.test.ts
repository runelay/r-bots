import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoInstructions } from "../services/engine.service";

function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "rb-repo-instructions-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

describe("repoInstructions", () => {
  test("uses AGENTS.md first", () => {
    const root = repo({ "AGENTS.md": "Sem comentários no código.\n", "CLAUDE.md": "outra coisa" });
    const block = repoInstructions(root);
    expect(block.split("\n")[0]).toBe("## Instruções do repositório");
    expect(block).toContain(`Regras de ${join(root, "AGENTS.md")}.`);
    expect(block).toContain("Sem comentários no código.");
    expect(block).not.toContain("outra coisa");
  });

  test("follows a CLAUDE.md that only includes another file", () => {
    const root = repo({ "CLAUDE.md": "@REGRAS.md\n", "REGRAS.md": "Base é a develop." });
    expect(repoInstructions(root)).toContain("Base é a develop.");
  });

  test("does not follow a second include", () => {
    const root = repo({ "CLAUDE.md": "@A.md", "A.md": "@B.md", "B.md": "fundo" });
    const block = repoInstructions(root);
    expect(block).toContain("@B.md");
    expect(block).not.toContain("fundo");
  });

  test("cuts a long file and points to the rest", () => {
    const root = repo({ "AGENTS.md": `${"a".repeat(20_000)}FIM` });
    const block = repoInstructions(root);
    expect(block).not.toContain("FIM");
    expect(block).toContain(`[cortado: leia o resto de ${join(root, "AGENTS.md")} com Read`);
  });

  test("is empty without instructions, with an empty file or an unreadable one", () => {
    expect(repoInstructions(repo({}))).toBe("");
    expect(repoInstructions(repo({ "AGENTS.md": "  \n" }))).toBe("");
    expect(repoInstructions(repo({ "CLAUDE.md": "@FALTA.md" }))).toBe("");
    const root = repo({});
    mkdirSync(join(root, "AGENTS.md"));
    expect(repoInstructions(root)).toBe("");
  });
});
