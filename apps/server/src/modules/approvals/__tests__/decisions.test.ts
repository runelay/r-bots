import { afterEach, describe, expect, test } from "bun:test";
import { fakeJev, stopJev } from "../../../../test/engine-helpers";
import {
  type ApprovalState,
  decideApproval,
  decideProgress,
  decideRoute,
  decideTriage,
  defaultDecisions,
  hardHumanReason,
  jevModel,
  unchangedRoutine,
} from "../services/decisions.service";
import { askedDelivery, askedReason, noDeliveryAsk } from "../services/delivery-intent.service";

afterEach(() => stopJev());

function state(overrides: Partial<ApprovalState> = {}): ApprovalState {
  return {
    botName: "Ana",
    botRole: "Pesquisa",
    request: "abre o site",
    tool: "browser_open",
    input: { url: "https://example.com" },
    page: { url: "https://example.com", title: "Example" },
    element: "",
    ...overrides,
  };
}

function score(value: number, confidence: number) {
  return { type: "score", score: value, confidence, probabilities: { "0": 0.9 } };
}

describe("hardHumanReason", () => {
  test("flags sensitive fills and dangerous clicks", () => {
    expect(hardHumanReason("browser_fill", { text: "x" }, 'textbox "Senha"')).toBe(
      "Campo sensível (senha, cartão, documento ou token).",
    );
    expect(hardHumanReason("browser_fill", { text: "4111 1111 1111 1111" }, "textbox")).toBe(
      "O valor parece cartão, CPF ou CNPJ.",
    );
    expect(hardHumanReason("browser_fill", { text: "123.456.789-09" }, "textbox")).toBe(
      "O valor parece cartão, CPF ou CNPJ.",
    );
    expect(hardHumanReason("browser_fill", { text: "12.345.678/0001-90" }, "textbox")).toBe(
      "O valor parece cartão, CPF ou CNPJ.",
    );
    expect(hardHumanReason("browser_fill", { text: "oi\n" }, "textbox")).toBe("O preenchimento envia o formulário.");
    expect(hardHumanReason("browser_fill", { text: "oi" }, 'button "Enviar"')).toBe(
      "O campo dispara envio, pagamento ou exclusão.",
    );
    expect(hardHumanReason("browser_fill", {}, "textbox busca")).toBeNull();
    expect(hardHumanReason("browser_click", {}, 'button "Excluir conta"')).toBe(
      "O clique envia, paga, confirma ou exclui algo.",
    );
    expect(hardHumanReason("browser_click", {}, 'link "Docs"')).toBeNull();
    expect(hardHumanReason("browser_open", {}, "Delete")).toBeNull();
  });
});

describe("decideApproval", () => {
  test("hard rules skip Jev and go to a person", async () => {
    const record = await decideApproval(
      state({ tool: "browser_click", element: 'button "Pagar"' }),
      defaultDecisions,
      "c1",
    );
    expect(record).toMatchObject({
      kind: "approval",
      outcome: "human",
      reason: "O clique envia, paga, confirma ou exclui algo.",
      tool: "browser_click",
      callId: "c1",
      latencyMs: 0,
      threshold: 0.7,
    });
  });

  test("falls back when Jev is off", async () => {
    const record = await decideApproval(state(), defaultDecisions, "c2");
    expect(record).toMatchObject({ outcome: "fallback", reason: "Jev desligado.", model: null, callId: "c2" });
  });

  test("auto approves a low risk aligned action above the threshold", async () => {
    const seen: unknown[] = [];
    fakeJev((body) => {
      seen.push(body);
      return {
        answers: {
          risk: score(0.2, 0.9),
          needs_human: { type: "noul", noul: 0.1 },
          aligned: { type: "noul", noul: 0.9 },
        },
      };
    });
    const record = await decideApproval(state({ element: "link" }), defaultDecisions, "c3");
    expect(record.outcome).toBe("auto_approved");
    expect(record.answer).toEqual({ risk: 0.2, riskProbabilities: { "0": 0.9 }, needsHuman: 0.1, aligned: 0.9 });
    expect(record.model).toBe("jev-test");
    expect(record.costUsd).toBeGreaterThan(0);
    expect((seen[0] as { state: { target_element: string } }).state.target_element).toBe("link");
  });

  test("auto approves medium risk without a human flag, unless auto approve is off or confidence is short", async () => {
    fakeJev(() => ({
      answers: {
        risk: score(1.7, 0.9),
        needs_human: { type: "noul", noul: 0.4 },
        aligned: { type: "noul", noul: 0.9 },
      },
    }));
    expect((await decideApproval(state(), defaultDecisions, "a")).outcome).toBe("auto_approved");
    expect((await decideApproval(state(), { autoApprove: false, threshold: 0.7 }, "b")).outcome).toBe("human");
    expect((await decideApproval(state(), { autoApprove: true, threshold: 0.95 }, "c")).outcome).toBe("human");
  });

  test("uses cautious defaults when Jev leaves answers out", async () => {
    fakeJev(() => ({ answers: { risk: { type: "noul", noul: 0 } } }));
    const record = await decideApproval(state({ element: "" }), defaultDecisions, "d");
    expect(record).toMatchObject({
      outcome: "human",
      confidence: 0,
      answer: { risk: 3, riskProbabilities: null, needsHuman: 1, aligned: 0 },
    });
  });

  test("judges prod queries by the same risk rule", async () => {
    let risk = 0.5;
    fakeJev(() => ({
      answers: {
        risk: score(risk, 0.9),
        needs_human: { type: "noul", noul: 0.1 },
        aligned: { type: "noul", noul: 0.9 },
      },
    }));
    expect((await decideApproval(state({ tool: "prod_query" }), defaultDecisions, "p")).outcome).toBe("auto_approved");
    risk = 2;
    expect((await decideApproval(state({ tool: "prod_query" }), defaultDecisions, "p")).outcome).toBe("human");
  });

  test("falls back when Jev fails", async () => {
    fakeJev(() => new Response("down", { status: 500 }));
    const record = await decideApproval(state(), defaultDecisions, "e");
    expect(record).toMatchObject({ outcome: "fallback", reason: "Jev respondeu 500.", tool: "browser_open" });
  });
});

describe("decideProgress", () => {
  test("off, stop, continue and failure", async () => {
    expect(await decideProgress("x", [])).toMatchObject({ kind: "progress", outcome: "fallback", threshold: 0.8 });
    fakeJev(() => ({ answers: { progress: score(0.2, 0.9), stuck: { type: "noul", noul: 0.9 } } }));
    expect(await decideProgress("x", ["a", "a"])).toMatchObject({
      outcome: "stop",
      answer: { progress: 0.2, stuck: 0.9 },
      confidence: 0.9,
    });
    fakeJev(() => ({ answers: {} }));
    expect(await decideProgress("x", ["a"])).toMatchObject({ outcome: "continue", answer: { progress: 2, stuck: 0 } });
    fakeJev(() => new Response("no", { status: 503 }));
    expect(await decideProgress("x", ["a"])).toMatchObject({ outcome: "fallback", reason: "Jev respondeu 503." });
  });
});

describe("decideTriage", () => {
  test("off, notify, quiet and failure", async () => {
    expect(await decideTriage("r", "s", "p", "ok")).toMatchObject({ kind: "triage", outcome: "fallback" });
    fakeJev(() => ({ answers: { attention: { type: "noul", noul: 0.1 } } }));
    expect(await decideTriage("r", "s", "p", "ok")).toMatchObject({ outcome: "quiet", answer: { noul: 0.1 } });
    fakeJev(() => ({ answers: {} }));
    const notify = await decideTriage("r", "s", "p", "ok");
    expect(notify).toMatchObject({ outcome: "notify", confidence: 1 });
    fakeJev(() => new Response("no", { status: 500 }));
    expect(await decideTriage("r", "s", "p", "ok")).toMatchObject({
      outcome: "fallback",
      reason: "Jev respondeu 500.",
    });
  });

  test("quiets an unchanged routine without asking Jev and sends the previous result", async () => {
    const seen: unknown[] = [];
    fakeJev((body) => {
      seen.push(body);
      return { answers: { attention: { type: "noul", noul: 0.9 } } };
    });
    expect(await decideTriage("r", "s", "p", "Tudo normal.")).toMatchObject({ outcome: "quiet", model: null });
    expect(seen).toHaveLength(0);
    expect(await decideTriage("r", "s", "p", "Um job preso.", "Tudo normal.")).toMatchObject({ outcome: "notify" });
    expect(JSON.stringify(seen[0])).toContain("previous_result");
  });
});

describe("unchangedRoutine", () => {
  test("quiets routines that say nothing changed or repeat the previous result", () => {
    for (const reply of [
      "Tudo normal. - `email_sends` (24h): 8.215 enviados e 4 com falha, igual à ronda anterior.",
      "Nada novo desde a ronda anterior:\n- `email_sends` (24h): 8.256 enviados",
      "Tudo igual à ronda anterior, sem nada novo.\n| Tabela | Resultado |",
      "**Nada novo** nem claramente quebrado. Os números são os mesmos da última rodada.",
      "Os números estão iguais aos da ronda anterior, sem novidade.",
      "  ",
    ])
      expect(unchangedRoutine(reply)).toBe(true);
    expect(unchangedRoutine("Um job preso em `integration_sync_jobs`.", "Um job preso em integration_sync_jobs.")).toBe(
      true,
    );
  });

  test("keeps routines that point to something", () => {
    for (const reply of [
      "Um job preso: em `integration_sync_jobs` há 1 job com status `running`.",
      "| Alerta novo | Número | Tabela |",
      "Tudo normal, exceto o spark-prod: 3 jobs falharam.",
      "Não consegui rodar a ronda.",
    ])
      expect(unchangedRoutine(reply)).toBe(false);
  });
});

describe("decideRoute", () => {
  const members = [
    { id: "ana", name: "Ana", role: "Pesquisa" },
    { id: "bia", name: "Bia", role: "" },
  ];

  test("falls back to the first member when Jev is off", async () => {
    expect(await decideRoute("g", members, "", "oi")).toMatchObject({
      kind: "route",
      outcome: "fallback",
      answer: { choice: "ana" },
    });
    expect(await decideRoute("g", [], "", "oi")).toMatchObject({ answer: { choice: null } });
  });

  test("follows a valid choice and ignores an unknown one", async () => {
    let choice = "bia";
    const bodies: Array<{ questions: { route: { criteria: Record<string, string> } } }> = [];
    fakeJev((body) => {
      bodies.push(body as unknown as (typeof bodies)[number]);
      return {
        answers: { route: { type: "choice", choice, confidence: 0.8, probabilities: { bia: 0.8, ana: 0.2 } } },
      };
    });
    expect(await decideRoute("g", members, "antes", "oi")).toMatchObject({
      outcome: "bia",
      answer: { choice: "bia", probabilities: { bia: 0.8, ana: 0.2 } },
      confidence: 0.8,
    });
    expect(bodies[0].questions.route.criteria).toEqual({ ana: "Ana: Pesquisa", bia: "Bia: sem papel definido" });
    choice = "zed";
    expect((await decideRoute("g", members, "", "oi")).outcome).toBe("ana");
    fakeJev(() => ({ answers: {} }));
    expect(await decideRoute("g", [], "", "oi")).toMatchObject({
      outcome: "none",
      confidence: null,
      answer: { choice: null, probabilities: null },
    });
  });

  test("falls back on failure with the first member as the answer", async () => {
    fakeJev(() => new Response("no", { status: 500 }));
    expect(await decideRoute("g", members, "", "oi")).toMatchObject({
      outcome: "fallback",
      answer: { choice: "ana" },
    });
    expect(await decideRoute("g", [], "", "oi")).toMatchObject({ outcome: "fallback", answer: { choice: null } });
  });

  test("re-exports the Jev model name", () => {
    expect(typeof jevModel).toBe("string");
  });
});

describe("delivery intent", () => {
  test("reads commit, push and PR requests from text", () => {
    expect(askedDelivery("só olha o código")).toEqual(noDeliveryAsk);
    expect(askedDelivery("pode commitar")).toEqual({ commit: true, push: false, pr: false });
    expect(askedDelivery("dá um push")).toEqual({ commit: true, push: true, pr: false });
    expect(askedDelivery("abre o PR")).toEqual({ commit: true, push: true, pr: true });
    expect(askedDelivery("não precisa commitar")).toEqual(noDeliveryAsk);
    expect(askedDelivery("não precisa testar nada agora, pode commitar")).toEqual({
      commit: true,
      push: false,
      pr: false,
    });
  });

  test("reads delivery from invoked skills", () => {
    expect(askedDelivery("", [{ slug: "pr-summary" }])).toEqual({ commit: true, push: true, pr: true });
    expect(askedDelivery("", [{ slug: "review-pr" }])).toEqual(noDeliveryAsk);
    expect(askedDelivery("", [{ slug: "x", name: "git-push" }])).toEqual({ commit: true, push: true, pr: false });
    expect(askedDelivery("", [{ slug: "commit" }])).toEqual({ commit: true, push: false, pr: false });
  });

  test("explains each kind", () => {
    expect(askedReason("pr")).toBe("Você pediu o PR.");
    expect(askedReason("push")).toBe("Você pediu o push.");
    expect(askedReason("commit")).toBe("Você pediu o commit.");
  });
});
