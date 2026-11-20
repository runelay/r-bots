import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { makeBot, waitFor } from "../../../../test/engine-helpers";
import { fakeProviders, readyProbe, resetData } from "../../../../test/helpers";
import type { Account } from "../../accounts/services/accounts.service";
import type { WorkspaceState } from "../../code/services/workspace.service";
import * as workspace from "../../code/services/workspace.service";
import {
  handoffBlock,
  handoffMode,
  readItem,
  refreshSummary,
  threadItems,
  turnNumber,
} from "../services/handoff.service";
import { createStoredSession, type Fact, type StoredSession } from "../services/sessions.service";

const account: Account = {
  id: "vps:claude",
  runner: "vps",
  provider: "claude",
  label: "Claude",
  status: "ready",
  models: readyProbe("claude").models,
  detail: "",
  checkedAt: new Date().toISOString(),
};

let session: StoredSession;

function add(turnId: string, ...facts: Fact[]) {
  session.log.emit(...facts.map((fact) => ({ ...fact, scope: turnId ? { turnId } : undefined })));
}

beforeEach(async () => {
  await resetData();
  const bot = await makeBot();
  session = await createStoredSession({ botId: bot.id, kind: "conversation", source: "chat", title: "" });
});

let changed: ReturnType<typeof spyOn<typeof workspace, "changedFiles">> | null = null;

afterEach(async () => {
  changed?.mockRestore();
  changed = null;
});

async function richHistory() {
  add(
    "turn_0",
    {
      type: "delivery.consumed",
      data: {
        source: "chat",
        parts: [{ kind: "text", text: "monta o relatório" }],
        skills: [{ name: "Relatório" }, {}],
        attachments: [{ name: "a.pdf", kind: "file", uploadId: "U1" }],
      },
    },
    { type: "delivery.consumed", data: { source: "schedule", parts: [{ text: "rotina" }] } },
    { type: "content.completed", data: { kind: "text", partId: "run_0.0", phase: "narration", value: "Vou olhar." } },
    { type: "content.completed", data: { kind: "image", partId: "run_0.1", value: "x" } },
    { type: "content.completed", data: { kind: "text", partId: "run_0.2", value: "   " } },
    {
      type: "call.requested",
      data: { callId: "c1", capability: { name: "Bash", label: "Rodar ls" }, input: { command: "ls" } },
    },
    {
      type: "call.settled",
      data: { callId: "c1", outcome: "completed", output: { stdout: "a\nb", stderr: "warn", exitCode: 0 } },
    },
    { type: "call.requested", data: { callId: "c2" } },
    { type: "call.settled", data: { callId: "c2", output: [{ text: "parte 1" }, { text: null }] } },
    { type: "call.requested", data: { callId: "c3", capability: { name: "prod_query" }, input: { sql: "select 1" } } },
    { type: "call.settled", data: { callId: "c3", outcome: "failed", error: { message: "timeout" } } },
    { type: "call.requested", data: { callId: "c4", capability: { name: "x", label: "X" }, input: {} } },
    { type: "call.settled", data: { callId: "c4", outcome: "rejected", output: "negado" } },
    { type: "call.requested", data: { callId: "c5", capability: { name: "y" }, input: {} } },
    { type: "call.settled", data: { callId: "c5", outcome: "failed" } },
    { type: "call.requested", data: { callId: "c6", capability: { name: "z" }, input: {} } },
    { type: "call.settled", data: { callId: "c6", outcome: "completed", output: null } },
    { type: "call.settled", data: { callId: "unknown" } },
  );
  add(
    "turn_1",
    {
      type: "code.edit",
      data: {
        path: "src/a.ts",
        added: 2,
        removed: 1,
        created: true,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-a", "+b", "+c"] }, {}],
      },
    },
    { type: "code.edit", data: { path: "src/b.ts", deleted: true, hunks: "nope" } },
    { type: "code.edit", data: {} },
    { type: "interaction.opened", data: { interactionId: "i1", request: { prompt: "Posso apagar?" } } },
    { type: "interaction.settled", data: { interactionId: "i1", outcome: "declined" } },
    { type: "interaction.opened", data: { interactionId: "i2", request: { kind: "secret" } } },
    { type: "interaction.settled", data: { interactionId: "i2", outcome: "strange" } },
    { type: "interaction.opened", data: { interactionId: "i3" } },
    { type: "interaction.settled", data: { interactionId: "missing", outcome: "accepted" } },
    { type: "artifact.created", data: { artifactId: "art1", title: "Painel", kind: "dashboard", version: 1 } },
    { type: "artifact.updated", data: { artifactId: "art1", title: "Painel", kind: "dashboard", version: 2 } },
    {
      type: "file.sent",
      data: { attachment: { uploadId: "U2", name: "r.csv", mime: "text/csv", kind: "file", url: "/u" } },
    },
    { type: "file.sent", data: {} },
    { type: "delegation.updated", data: { callId: "d0", botId: "bia", status: "working" } },
    { type: "delegation.updated", data: { callId: "d1", botId: "bia", status: "completed", summary: "feito" } },
    { type: "delegation.updated", data: { callId: "d2", botId: "bia", status: "failed", error: "caiu" } },
    { type: "delegation.updated", data: { callId: "d3", botId: "bia", status: "cancelled" } },
  );
  add(
    "turn_2",
    { type: "code.workspace", data: {} },
    { type: "code.workspace", data: { action: "failed", repo: "r" } },
    { type: "code.workspace", data: { action: "opened", repoName: "app", branch: "feat/x", path: "/w" } },
    { type: "code.workspace", data: { action: "closed", repo: "app" } },
    { type: "code.delivered", data: { action: "pr", commit: "abc", prUrl: "http://pr", files: 2, branch: "feat/x" } },
    { type: "code.delivered", data: { action: "commit", files: 1, branch: "feat/x" } },
    { type: "account.failover", data: { line: "Limite acabou" } },
    { type: "account.failover", data: {} },
    { type: "turn.settled", data: { outcome: "completed", turnId: "turn_2" } },
    { type: "turn.settled", data: { outcome: "failed", turnId: "turn_2", error: { message: "quebrou" } } },
  );
  add("turn_3", { type: "turn.settled", data: { outcome: "failed", turnId: "turn_3" } });
  add("turn_4", { type: "turn.settled", data: { outcome: "cancelled", turnId: "turn_4", reason: "parou" } });
  add("turn_5", { type: "turn.settled", data: { outcome: "cancelled", turnId: "turn_5" } });
  add(
    "turn_6",
    {
      type: "delivery.consumed",
      data: { source: "delegate", from: { name: "Ana" }, parts: [{ text: "faz isso" }] },
    },
    { type: "delivery.consumed", data: { source: "chat" } },
  );
  (await session.log.lines()).push("not json");
  (await session.log.lines()).push(
    JSON.stringify({
      facts: [{ type: "content.completed", data: { kind: "text", partId: "p", phase: "reply", value: "sem hora" } }],
    }),
  );
  (await session.log.lines()).push(JSON.stringify({ at: "x" }));
}

describe("turnNumber", () => {
  test("parses turn ids", async () => {
    expect(turnNumber("turn_7")).toBe(7);
    expect(turnNumber("")).toBe(-1);
    expect(turnNumber("turn_x")).toBe(-1);
  });
});

describe("threadItems", () => {
  test("turns every kind of fact into a readable item", async () => {
    await richHistory();
    const items = await threadItems(session);
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get("u_turn_0")?.text).toBe(
      "monta o relatório\nSkills anexadas: Relatório.\nAnexos: a.pdf (file, U1).",
    );
    expect(byId.get("a_run_0.0")?.brief).toBe("(narração) Vou olhar.");
    expect(byId.get("t_c1")?.text).toBe("Comando: ls\nResultado:\na\nb\nstderr:\nwarn\nExit code: 0");
    expect(byId.get("t_c2")?.text).toBe("Ferramenta: ferramenta\nEntrada: {}\nResultado:\nparte 1\n");
    expect(byId.get("t_c3")?.brief).toBe("prod_query → failed: timeout");
    expect(byId.get("t_c4")?.text).toContain("Resultado (rejected): negado");
    expect(byId.get("t_c5")?.text).toContain("Resultado (failed): sem detalhe");
    expect(byId.get("t_c6")?.text).toContain("Resultado:\n(vazio)");
    expect(byId.get("t_c6")?.brief).toBe("z → ok");
    expect(byId.has("t_unknown")).toBe(false);
    expect(byId.get("e_turn_1:src/a.ts")?.text).toBe(
      "Arquivo src/a.ts +2 −1 (novo)\n@@ -1,1 +1,2 @@\n-a\n+b\n+c\n@@ -0,0 +0,0 @@",
    );
    expect(byId.get("e_turn_1:src/b.ts")?.brief).toBe("src/b.ts +0 −0 (apagado)");
    expect(byId.get("e_turn_1:")?.brief).toBe(" +0 −0");
    expect(byId.get("p_i1")).toMatchObject({ pending: false, brief: "Aprovação pedida: Posso apagar? (negada)" });
    expect(byId.get("p_i2")?.text).toBe(
      "Aprovação pedida: Pedido de segredo pelo formulário seguro.\nResposta: strange.",
    );
    expect(byId.get("p_i3")?.pending).toBe(true);
    expect(byId.get("r_art1_v2")?.meta).toMatchObject({ version: 2 });
    expect(byId.get("f_U2")?.text).toBe("Arquivo enviado à pessoa: r.csv (text/csv, U2).");
    expect(byId.get("f_undefined")).toBeDefined();
    expect(byId.has("d_d0")).toBe(false);
    expect(byId.get("d_d1")?.text).toBe("Delegação para bia: completed. feito");
    expect(byId.get("d_d2")?.text).toBe("Delegação para bia: failed. caiu");
    expect(byId.get("d_d3")?.text).toBe("Delegação para bia: cancelled.");
    expect(byId.get("w_turn_2_opened")?.text).toBe("Repositório app: opened, branch feat/x, worktree /w.");
    expect(byId.get("w_turn_2_closed")?.text).toBe("Repositório app: closed.");
    expect(byId.get("w_abc_delivered")?.text).toBe(
      "Entrega do código: pr, commit abc, PR http://pr, 2 arquivos na branch feat/x.",
    );
    expect(items.filter((item) => item.id.endsWith("_delivered"))).toHaveLength(2);
    expect(byId.get("x_turn_2_failover")?.text).toBe("Troca de conta.");
    expect(byId.get("x_turn_2")?.text).toBe("O turno falhou: quebrou");
    expect(byId.get("x_turn_3")?.text).toBe("O turno falhou: sem detalhe");
    expect(byId.get("x_turn_4")?.text).toBe("Turno interrompido: parou.");
    expect(byId.get("x_turn_5")?.text).toBe("Turno interrompido.");
    expect(byId.get("u_turn_6")?.text).toBe("");
    expect(items.find((item) => item.id === "a_p")).toMatchObject({ at: "", turnId: "turn_6" });
  });

  test("skips reverted turns and settles calls without output", async () => {
    (await session.log.lines()).push(
      JSON.stringify({
        at: "t",
        facts: [
          {
            type: "call.requested",
            data: { callId: "k", capability: { name: "n" }, input: {} },
            scope: { turnId: "turn_0" },
          },
        ],
      }),
    );
    add("turn_0", { type: "delivery.consumed", data: { parts: [{ text: "oi" }] } });
    add("turn_1", { type: "delivery.consumed", data: { parts: [{ text: "revertido" }] } });
    session.meta.revertedTurns = ["turn_1"];
    const items = await threadItems(session);
    expect(items.map((item) => item.id)).toEqual(["u_turn_0"]);
    const lines = await session.log.lines();
    lines.push(
      `{"at":"t","facts":[{"type":"call.settled","data":{"callId":"k","outcome":"completed"},"scope":{"turnId":"turn_0"}}]}`,
    );
    const settled = (await threadItems(session)).find((item) => item.id === "t_k");
    expect(settled?.text).toContain("(vazio)");
  });
});

describe("handoffMode", () => {
  test("is full without a provider session, delta once synced and unknown otherwise", async () => {
    expect(handoffMode(session, "vps:claude")).toEqual({ mode: "full", since: -1 });
    session.meta.providerSessions = { "vps:claude": "s1" };
    expect(handoffMode(session, "vps:claude")).toBeNull();
    session.meta.providerSynced = { "vps:claude": "turn_3" };
    expect(handoffMode(session, "vps:claude")).toEqual({ mode: "delta", since: 3 });
  });
});

describe("handoffBlock", () => {
  test("is empty when the provider already knows the conversation", async () => {
    session.meta.providerSessions = { k: "s" };
    expect(await handoffBlock(session, { key: "k", currentTurnId: "turn_0" })).toBe("");
    session.meta.providerSynced = { k: "turn_5" };
    add("turn_2", { type: "delivery.consumed", data: { parts: [{ text: "velho" }] } });
    expect(await handoffBlock(session, { key: "k", currentTurnId: "turn_6" })).toBe("");
  });

  test("is only the state block for an empty conversation", async () => {
    expect(await handoffBlock(session, { key: "k", currentTurnId: "turn_0" })).toBe("");
    const block = await handoffBlock(session, { key: "k", currentTurnId: "turn_0", skills: ["Relatório"] });
    expect(block).toBe(
      "## Contexto da conversa (handoff)\nEstado atual:\n- Skills anexadas ao pedido em curso: Relatório.",
    );
  });

  test("renders the full conversation with the state, ids and reason", async () => {
    await richHistory();
    add("turn_7", { type: "interaction.opened", data: { interactionId: "now", request: { prompt: "Agora?" } } });
    session.meta.workspace = {
      repoName: "app",
      branch: "feat/x",
      base: "origin/main",
      path: "/w",
      active: true,
    } as WorkspaceState;
    changed = spyOn(workspace, "changedFiles").mockResolvedValue(
      Array.from({ length: 31 }, (_, index) => ({
        path: `f${index}.ts`,
        added: 1,
        removed: 0,
        status: "modified",
        binary: false,
      })) as never,
    );
    const block = await handoffBlock(session, {
      key: "k",
      currentTurnId: "turn_7",
      skills: ["Relatório"],
      reason: "troca de conta",
    });
    expect(block).toContain("Handoff de contexto (conversa inteira)");
    expect(block).toContain("Motivo: troca de conta.");
    expect(block).toContain("Turnos cobertos: 0–7.");
    expect(block).toContain("- Repositório aberto: app, branch feat/x (base origin/main), worktree /w.");
    expect(block).toContain("Arquivos mudados na worktree (31, +31 −0)");
    expect(block).toContain("; e mais 1.");
    expect(block).toContain("- Aprovações pendentes: p_now (Aprovação pedida: Agora?).");
    expect(block).toContain("- Aprovações negadas recentemente");
    expect(block).toContain("“Painel” (dashboard, v2, art1)");
    expect(block).toContain("a.pdf (da pessoa, file, U1)");
    expect(block).toContain("r.csv (enviado por você, U2)");
    expect(block).toContain("[Histórico; você; tool_call; item=t_c1; turn_0]\nComando: ls\nResultado (resumido):");
    expect(block).toContain("item=t_c3; turn_0]\nFerramenta: prod_query\nEntrada:");
    expect(block).toContain("Resultado (failed): timeout");
    expect(block).toContain("Arquivo src/a.ts +2 −1 (novo) (diff no thread_read)");
    expect(block).toContain("Selecionei");
  });

  test("reports an empty worktree and a failing git status the same way", async () => {
    session.meta.workspace = { repoName: "app", branch: "b", base: "main", path: "/w", active: true } as WorkspaceState;
    changed = spyOn(workspace, "changedFiles").mockResolvedValue([]);
    expect(await handoffBlock(session, { key: "k", currentTurnId: "turn_0" })).toContain(
      "- Nenhum arquivo mudado na worktree.",
    );
    changed.mockRejectedValue(new Error("git"));
    expect(await handoffBlock(session, { key: "k", currentTurnId: "turn_0" })).toContain(
      "- Nenhum arquivo mudado na worktree.",
    );
  });

  test("renders only what the provider has not seen in delta mode", async () => {
    add("turn_1", { type: "delivery.consumed", data: { parts: [{ text: "antigo" }] } });
    add("turn_4", { type: "delivery.consumed", data: { parts: [{ text: "novo pedido" }] } });
    add("turn_5", { type: "delivery.consumed", data: { parts: [{ text: "atual" }] } });
    session.meta.providerSessions = { k: "s" };
    session.meta.providerSynced = { k: "turn_3" };
    session.meta.handoff = { summary: "resumo", lastItemId: "u_turn_1", updatedAt: "t" };
    const block = await handoffBlock(session, { key: "k", currentTurnId: "turn_5", reason: "limite" });
    expect(block).toContain(
      "Handoff de contexto (o que você não viu). Enquanto outra conta ou modelo respondia, a conversa",
    );
    expect(block).toContain("andou nos turnos 4–4. Motivo: limite.");
    expect(block).toContain("novo pedido");
    expect(block).not.toContain("antigo");
    expect(block).not.toContain("atual");
    expect(block).not.toContain("resumo");
  });

  test("summarizes, lists a timeline and omits old items when over budget", async () => {
    add("turn_0", { type: "delivery.consumed", data: { parts: [{ text: "z".repeat(20_000) }] } });
    for (let index = 1; index < 90; index++)
      add(`turn_${index}`, {
        type: "delivery.consumed",
        data: { parts: [{ text: `pedido ${index} ${"x".repeat(3000)}` }] },
      });
    session.meta.handoff = { summary: "Resumo antigo", lastItemId: "u_turn_0", updatedAt: "t" };
    const block = await handoffBlock(session, { key: "k", currentTurnId: "turn_89" });
    expect(block).toContain("Resumo da conversa até u_turn_0:\nResumo antigo");
    expect(block).toContain("Linha do tempo depois do resumo");
    expect(block).not.toContain("- u_turn_1 (pessoa)");
    expect(block).toMatch(/Ids omitidos, mais novos por último \(mostrando 60; os \d+ mais antigos estão no resumo\)/);
    const noSummary = await handoffBlock(
      { ...session, meta: { ...session.meta, handoff: undefined } } as StoredSession,
      {
        key: "k",
        currentTurnId: "turn_89",
      },
    );
    expect(noSummary).toContain("não aparecem aqui");
  });

  test("keeps long tool results short and skips items too large for a third of the budget", async () => {
    add("turn_0", { type: "delivery.consumed", data: { parts: [{ text: "y".repeat(20_000) }] } });
    add(
      "turn_1",
      { type: "call.requested", data: { callId: "big", capability: { name: "t" }, input: {} } },
      { type: "call.settled", data: { callId: "big", outcome: "completed", output: "o".repeat(5000) } },
    );
    const block = await handoffBlock(session, { key: "k", currentTurnId: "turn_9" });
    expect(block).toContain("Selecionei 1 itens inteiros; omiti 1.");
    expect(block).toContain("caracteres omitidos; íntegra no thread_read");
  });
});

describe("readItem", () => {
  test("reads items in chunks and reports missing ones", async () => {
    add("turn_0", { type: "delivery.consumed", data: { parts: [{ text: `${"a".repeat(3999)}😀${"b".repeat(10)}` }] } });
    const missing = await readItem(session, "nope");
    expect(missing).toEqual({ error: "Não achei o item nope nesta conversa.", recentIds: ["u_turn_0"] });
    const first = (await readItem(session, "u_turn_0")) as { text: string; nextOffset: number; totalChars: number };
    expect(first.text).toHaveLength(3999);
    expect(first.nextOffset).toBe(3999);
    const rest = (await readItem(session, "u_turn_0", first.nextOffset)) as { text: string; nextOffset: number | null };
    expect(rest.text).toBe(`😀${"b".repeat(10)}`);
    expect(rest.nextOffset).toBeNull();
    expect(await readItem(session, "u_turn_0", 99_999)).toMatchObject({ offset: first.totalChars, text: "" });
    expect(await readItem(session, "u_turn_0", -5)).toMatchObject({ offset: 0 });
  });
});

describe("refreshSummary", () => {
  function messages(count: number) {
    for (let index = 0; index < count; index++)
      add(`turn_${index}`, { type: "delivery.consumed", data: { parts: [{ text: `msg ${index}` }] } });
  }

  test("waits until enough items pile up", async () => {
    messages(30);
    await refreshSummary(session, account, "m", "Bia");
    expect(fakeProviders.turns).toHaveLength(0);
  });

  test("summarizes the oldest batch and continues from the last summary", async () => {
    messages(40);
    fakeProviders.next(({ emit }) => emit({ type: "text", part: "0", text: "resumo 1" }));
    await refreshSummary(session, account, "m", "Bia");
    expect(session.meta.handoff).toMatchObject({ summary: "resumo 1", lastItemId: "u_turn_15" });
    expect(fakeProviders.turns[0].request.prompt).toContain("[u_turn_0; pessoa; user_message] msg 0");
    messages(0);
    for (let index = 40; index < 60; index++)
      add(`turn_${index}`, { type: "delivery.consumed", data: { parts: [{ text: `msg ${index}` }] } });
    fakeProviders.next(({ emit }) => emit({ type: "text", part: "0", text: "resumo 2" }));
    await refreshSummary(session, account, "m", "Bia");
    expect(fakeProviders.turns[1].request.prompt).toContain("Resumo até agora:\nresumo 1");
    expect(fakeProviders.turns[1].request.prompt).toContain("[u_turn_16;");
    expect(session.meta.handoff?.lastItemId).toBe("u_turn_35");
  });

  test("forces a summary near the end, caps the input and ignores empty answers", async () => {
    for (let index = 0; index < 20; index++)
      add(
        `turn_${index}`,
        {
          type: "call.requested",
          data: { callId: `c${index}`, capability: { name: "t" }, input: {} },
        },
        { type: "call.settled", data: { callId: `c${index}`, output: "z".repeat(5000) } },
      );
    for (let index = 0; index < 60; index++)
      add(`turn_${index + 20}`, { type: "delivery.consumed", data: { parts: [{ text: "w".repeat(700) }] } });
    fakeProviders.next(({ emit }) => emit({ type: "text", part: "0", text: "" }));
    await refreshSummary(session, account, "m", "Bia", true);
    expect(session.meta.handoff).toBeUndefined();
    expect(fakeProviders.turns[0].request.prompt).toContain("[t_c0; você; tool_call] t → ");
    fakeProviders.next(({ emit }) => emit({ type: "text", part: "0", text: "ok" }));
    await refreshSummary(session, account, "m", "Bia", true);
    expect(session.meta.handoff?.summary).toBe("ok");
  });

  test("runs one summary at a time per conversation", async () => {
    messages(40);
    let release = () => undefined as undefined;
    fakeProviders.next(
      ({ emit }) =>
        new Promise<void>((resolve) => {
          release = () => {
            emit({ type: "text", part: "0", text: "s" });
            resolve();
          };
        }),
    );
    const first = refreshSummary(session, account, "m", "Bia");
    await waitFor(() => fakeProviders.turns.length === 1);
    await refreshSummary(session, account, "m", "Bia");
    expect(fakeProviders.turns).toHaveLength(1);
    release();
    await first;
    expect(session.meta.handoff?.summary).toBe("s");
  });
});
