import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  connectMcp,
  factsOfType,
  makeBot,
  newSession,
  textOf,
  toolContext,
  waitFor,
} from "../../../../test/engine-helpers";
import {
  contextOf,
  idle,
  quietEngine,
  repliesOf,
  restoreTracked,
  send,
  sequence,
} from "../../../../test/engine-turn-helpers";
import {
  type FakeTurn,
  fakeProviders,
  replyWith,
  request,
  resetData,
  startTestServer,
  type TestServer,
} from "../../../../test/helpers";
import { ValidationError } from "../../../shared/errors";
import { withLanguage } from "../../../shared/i18n";
import type { BotDefinition } from "../../bots/services/bots.service";
import type { StoredSession } from "../../conversations/services/sessions.service";
import { answer, answerQuestion, conversationStatus } from "../../engine/services/engine.service";
import {
  answerSummary,
  isQuestionAnswer,
  isSpokenSkip,
  matchSpokenOption,
  type QuestionOutcome,
  questionRequestOf,
  questionResultText,
  resolveAnswers,
  runAskUser,
  spokenQuestion,
} from "../services/questions.service";

let server: TestServer;
let bot: BotDefinition;
let session: StoredSession;
const clients: Client[] = [];
const revokes: Array<() => unknown> = [];

const story = {
  question: "O que a checagem confere no Story?",
  header: "Checagem",
  options: [
    { label: "Data e hora", description: "Confere quando foi postado", recommended: true },
    { label: "Marcação da marca" },
    { label: "Link na figurinha", recommended: true },
  ],
};
const networks = {
  question: "Quais redes entram?",
  multiSelect: true,
  options: [{ label: "Instagram" }, { label: "TikTok" }],
};

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  quietEngine();
  await resetData();
  bot = await makeBot();
  session = await newSession(bot.id);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const revoke of revokes.splice(0)) revoke();
  restoreTracked();
});

async function card() {
  return waitFor(async () => (await factsOfType(session, "interaction.opened")).at(-1)?.data) as Promise<{
    interactionId: string;
    request: Record<string, unknown>;
    subject: { callId: string };
  }>;
}

function asking(questions: unknown[]) {
  const results: string[] = [];
  const script = async (turn: FakeTurn) => {
    const result = await runAskUser(contextOf(turn), { questions } as never);
    const text = textOf(result);
    results.push(text);
    turn.emit({ type: "text", part: "r", text: `seguindo: ${text}` });
    turn.emit({ type: "done", ok: true });
  };
  return { script, results };
}

const eve = () => `/bots/${bot.id}/eve/v1/session/${session.meta.sessionId}`;

describe("question request", () => {
  test("letters the options, keeps one recommended and drops blank extras", () => {
    const built = questionRequestOf({ questions: [story, { ...networks, header: " " }] } as never);
    expect(built.questions[0]).toEqual({
      id: "q1",
      title: "O que a checagem confere no Story?",
      header: "Checagem",
      multiSelect: false,
      options: [
        { id: "a", label: "Data e hora", description: "Confere quando foi postado", recommended: true },
        { id: "b", label: "Marcação da marca" },
        { id: "c", label: "Link na figurinha" },
      ],
    });
    expect(built.questions[1]).toMatchObject({ id: "q2", multiSelect: true });
    expect(built.questions[1].header).toBeUndefined();
  });

  test("resolves answers, free text, skips and rejects bad input", () => {
    const built = questionRequestOf({ questions: [story, networks] } as never);
    expect(isQuestionAnswer({ questions: [] })).toBe(true);
    expect(isQuestionAnswer({ optionId: "skip" })).toBe(true);
    expect(isQuestionAnswer({ optionId: "approve" })).toBe(false);
    expect(isQuestionAnswer(null)).toBe(false);
    const answers = resolveAnswers(built, {
      questions: [
        { questionId: "q1", optionIds: ["b"] },
        { questionId: "q2", optionIds: ["a", "b", "a"], text: "  e YouTube  " },
      ],
    });
    expect(answers).toEqual([
      { questionId: "q1", title: story.question, optionIds: ["b"], labels: ["Marcação da marca"], skipped: false },
      {
        questionId: "q2",
        title: networks.question,
        optionIds: ["a", "b", "other"],
        labels: ["Instagram", "TikTok"],
        text: "e YouTube",
        skipped: false,
      },
    ]);
    expect(answerSummary(answers)).toBe("Respondeu: Marcação da marca · Instagram, TikTok, e YouTube");
    const partial = resolveAnswers(built, { questions: [{ questionId: "q1", optionIds: [] }] });
    expect(partial.map((item) => item.skipped)).toEqual([true, true]);
    expect(answerSummary(partial)).toBe("Pulou");
    expect(resolveAnswers(built, { optionId: "skip" }).every((item) => item.skipped)).toBe(true);
    expect(
      resolveAnswers(built, { questions: [{ questionId: "q1", skipped: true, optionIds: ["a"] }] })[0].skipped,
    ).toBe(true);
    const other = resolveAnswers(built, { questions: [{ questionId: "q1", optionIds: ["other"], text: "o áudio" }] });
    expect(other[0]).toMatchObject({ optionIds: ["other"], labels: [], text: "o áudio" });
    expect(() => withLanguage("en", () => resolveAnswers(built, { optionId: "approve" }))).toThrow(
      "Send 'questions' or optionId 'skip'.",
    );
    const bad: Array<[unknown, string]> = [
      [null, "Cada resposta precisa ser um objeto."],
      [{ optionId: "approve" }, "Mande 'questions' ou optionId 'skip'."],
      [{ questions: [{ questionId: "q9" }] }, "Pergunta desconhecida: 'q9'."],
      [{ questions: [null] }, "Pergunta desconhecida: ''."],
      [{ questions: [{ questionId: "q1", optionIds: [1] }] }, "optionIds precisa ser uma lista de ids."],
      [{ questions: [{ questionId: "q1", optionIds: ["z"] }] }, "Opção desconhecida 'z' na pergunta 'q1'."],
      [{ questions: [{ questionId: "q1", optionIds: ["other"] }] }, "“Outra coisa” precisa de texto."],
      [{ questions: [{ questionId: "q1", optionIds: ["a", "b"] }] }, "A pergunta 'q1' aceita uma opção só."],
    ];
    for (const [raw, message] of bad) {
      const error = (() => {
        try {
          resolveAnswers(built, raw);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toBe(message);
    }
  });

  test("writes the tool result for each outcome", () => {
    const built = questionRequestOf({ questions: [story, networks] } as never);
    const answers = resolveAnswers(built, { questions: [{ questionId: "q1", optionIds: ["a"] }] });
    expect(questionResultText({ status: "answered", interactionId: "i", answers })).toBe(
      `Respostas da pessoa:\n- ${story.question} → Data e hora\n- ${networks.question} → pulou; decida com o padrão sensato e diga qual escolheu\nSiga com isso, sem perguntar de novo.`,
    );
    expect(questionResultText({ status: "skipped", interactionId: "i", answers: [] })).toContain("pulou as perguntas");
    expect(questionResultText({ status: "withdrawn", interactionId: "i" })).toContain("respondeu por mensagem");
  });

  test("matches spoken answers and skips", () => {
    const [question] = questionRequestOf({ questions: [story] } as never).questions;
    const multi = questionRequestOf({ questions: [networks] } as never).questions[0];
    expect(spokenQuestion(question, 1, 3)).toStartWith("Pergunta 2 de 3. O que a checagem");
    expect(matchSpokenOption(question, "")).toEqual([]);
    expect(matchSpokenOption(question, "letra C")).toEqual(["c"]);
    expect(matchSpokenOption(question, "dê")).toEqual([]);
    expect(matchSpokenOption(question, "a terceira")).toEqual(["c"]);
    expect(matchSpokenOption(question, "a quarta")).toEqual([]);
    expect(matchSpokenOption(question, "data e hora e marcação da marca")).toEqual(["a"]);
    expect(matchSpokenOption(multi, "primeira e segunda")).toEqual(["a", "b"]);
    expect(matchSpokenOption(multi, "instagram e tiktok")).toEqual(["a", "b"]);
    expect(matchSpokenOption(question, "primeira e segunda")).toEqual(["a"]);
    expect(matchSpokenOption(question, "olha a primeira coisa que eu acho é outra")).toEqual([]);
    expect(isSpokenSkip("Você decide")).toBe(true);
    expect(isSpokenSkip("a primeira")).toBe(false);
  });
});

describe("ask_user in a turn", () => {
  test("pauses, takes the answer by HTTP and resumes with it", async () => {
    const ask = asking([story, networks]);
    fakeProviders.next(ask.script);
    send(session);
    const opened = await card();
    expect(opened.request).toMatchObject({
      kind: "question",
      display: "questions",
      allowFreeform: true,
      prompt: story.question,
    });
    expect((opened.request.questions as unknown[]).length).toBe(2);
    expect(await factsOfType(session, "turn.paused")).toHaveLength(1);
    expect(conversationStatus(session.meta.sessionId)).toBe("awaiting");
    const call = (await factsOfType(session, "call.requested")).at(-1)?.data;
    expect(call).toMatchObject({
      callId: opened.subject.callId,
      capability: { name: "ask_user", label: "2 perguntas" },
    });

    const wrong = await request<{ error: string; field: string }>(eve(), {
      method: "POST",
      body: { answers: [{ interactionId: opened.interactionId, questions: [{ questionId: "q1", optionIds: ["z"] }] }] },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ field: "answers", error: "Opção desconhecida 'z' na pergunta 'q1'." });
    const stale = await request<{ code: string }>(eve(), {
      method: "POST",
      body: { answers: [{ interactionId: "nope", optionId: "skip" }] },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("interaction_not_pending");

    const sent = await request(eve(), {
      method: "POST",
      body: {
        answers: [
          {
            interactionId: opened.interactionId,
            questions: [
              { questionId: "q1", optionIds: ["other"], text: "Só o link" },
              { questionId: "q2", optionIds: ["a"] },
            ],
          },
        ],
      },
    });
    expect(sent.status).toBe(202);
    await idle(session);
    expect(ask.results[0]).toBe(
      `Respostas da pessoa:\n- ${story.question} → Só o link\n- ${networks.question} → Instagram\nSiga com isso, sem perguntar de novo.`,
    );
    const settled = (await factsOfType(session, "interaction.settled")).at(-1)?.data;
    expect(settled).toMatchObject({ outcome: "accepted", summary: "Respondeu: Só o link · Instagram" });
    const result = (await factsOfType(session, "call.settled")).at(-1)?.data;
    expect(result).toMatchObject({ outcome: "completed", output: { status: "answered" } });
    expect((await repliesOf(session))[0]).toStartWith("seguindo: Respostas da pessoa");
  });

  test("skip by the approval route and withdrawal by a chat message", async () => {
    const ask = asking([story]);
    fakeProviders.next(ask.script);
    send(session);
    const first = await card();
    expect(answerQuestion(session, "dlv", "nope", { optionId: "skip" })).toBe(false);
    expect(answer(session, "dlv_skip", first.interactionId, "deny")).toBe(true);
    await idle(session);
    expect(ask.results[0]).toContain("pulou as perguntas");
    expect((await factsOfType(session, "interaction.settled")).at(-1)?.data).toMatchObject({
      outcome: "declined",
      summary: "Pulou",
    });

    const again = asking([story]);
    fakeProviders.next(
      sequence(async (turn) => {
        turn.emit({ type: "session", id: "prov-question" });
        await again.script(turn);
      }, replyWith("Ok, só o link.")),
    );
    send(session);
    await waitFor(async () => (await factsOfType(session, "interaction.opened")).length === 2);
    send(session, { text: "na verdade confere só o link" });
    await idle(session);
    expect(again.results[0]).toContain("respondeu por mensagem");
    expect((await factsOfType(session, "interaction.settled")).at(-1)?.data).toMatchObject({
      outcome: "withdrawn",
      reason: "message",
    });
  });

  test("a cancelled turn withdraws the open question", async () => {
    const outcomes: QuestionOutcome[] = [];
    fakeProviders.next(async (turn) => {
      const context = contextOf(turn);
      outcomes.push(
        await (context.askUser as NonNullable<typeof context.askUser>)(
          questionRequestOf({ questions: [story] } as never),
          "call_x",
          "Ana",
        ),
      );
      turn.emit({ type: "done", ok: true });
    });
    send(session);
    const opened = (await card()) as { origin?: { agent: string } };
    expect(opened.origin).toEqual({ agent: "Ana" });
    const { cancel } = await import("../../engine/services/engine.service");
    cancel(session);
    await idle(session);
    expect(outcomes[0]).toMatchObject({ status: "withdrawn" });
  });
});

describe("ask_user over MCP", () => {
  async function open(overrides: Parameters<typeof toolContext>[2] = {}) {
    const harness = toolContext(bot, session, overrides);
    revokes.push(harness.revoke);
    const client = await connectMcp(harness.url(server.url), harness.context.token);
    clients.push(client);
    return { harness, client };
  }

  test("is listed and returns the person's answer", async () => {
    const { client } = await open({
      origin: "Davi",
      ownerCallId: "call_owner",
      askUser: async (built, callId) => ({
        status: "answered",
        interactionId: `int_${callId.length > 0}`,
        answers: resolveAnswers(built, { questions: [{ questionId: "q1", optionIds: ["c"] }] }),
      }),
    });
    const listed = await client.listTools();
    expect(listed.tools.some((tool) => tool.name === "ask_user")).toBe(true);
    const result = await client.callTool({ name: "ask_user", arguments: { questions: [story] } });
    expect(textOf(result)).toContain("→ Link na figurinha");
    const requested = (await factsOfType(session, "call.requested")).at(-1)?.data;
    expect(requested).toMatchObject({ owner: { callId: "call_owner" }, origin: { agent: "Davi" } });
    expect((await factsOfType(session, "call.started")).at(-1)?.data).toMatchObject({
      clearedBy: { interactionId: "int_true" },
    });
  });

  test("withdrawn outcome is recorded without answers", async () => {
    const { client } = await open({ askUser: async () => ({ status: "withdrawn", interactionId: "int_w" }) });
    const result = await client.callTool({ name: "ask_user", arguments: { questions: [story] } });
    expect(textOf(result)).toContain("respondeu por mensagem");
    expect((await factsOfType(session, "call.settled")).at(-1)?.data).toEqual({
      callId: expect.any(String),
      cause: { interactionId: "int_w" },
      outcome: "completed",
      output: { status: "withdrawn" },
    });
  });

  test("does not block in a routine and follows the recommended option", async () => {
    let asked = 0;
    const { harness, client } = await open({
      isSchedule: true,
      askUser: async () => {
        asked++;
        return { status: "withdrawn", interactionId: "x" };
      },
    });
    const result = await client.callTool({
      name: "ask_user",
      arguments: { questions: [story, { ...networks, options: [{ label: "Instagram" }, { label: "TikTok" }] }] },
    });
    expect(asked).toBe(0);
    expect(textOf(result)).toContain("registre a dúvida no resumo");
    expect(textOf(result)).toContain(`${story.question} → ninguém respondeu; siga com “Data e hora”`);
    expect(textOf(result)).toContain(`${networks.question} → ninguém respondeu; siga com “Instagram”`);
    expect(harness.settled.at(-1)).toBe("ask_user → sem pessoa presente, seguiu o padrão");
  });

  test("rejects invalid questions", async () => {
    const { client } = await open();
    const result = (await client.callTool({
      name: "ask_user",
      arguments: { questions: [{ question: "x", options: [{ label: "só uma" }] }] },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});
