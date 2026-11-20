import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { LiveMessage } from "@runelay-bots/protocol";
import { factsOfType, makeBot, newSession, waitFor } from "../../../../test/engine-helpers";
import {
  aborted,
  contextOf,
  hold,
  idle,
  lastRequest,
  quietEngine,
  repliesOf,
  restoreTracked,
  run,
  send,
  sequence,
  settledOf,
  track,
} from "../../../../test/engine-turn-helpers";
import { type FakeTurn, fakeProviders, replyWith } from "../../../../test/helpers";
import * as decisions from "../../approvals/services/decisions.service";
import * as handoff from "../../conversations/services/handoff.service";
import type { StoredSession } from "../../conversations/services/sessions.service";
import * as threads from "../../conversations/services/threads.service";
import * as uploads from "../../uploads/services/uploads.service";
import { answer, botStatus, cancel, conversationStatus, isBusy, steerLead } from "../services/engine.service";
import type { ApprovalResult } from "../services/mcp-gateway.service";

beforeEach(() => {
  quietEngine();
});

afterEach(() => {
  restoreTracked();
});

async function opened(session: StoredSession) {
  return (await factsOfType(session, "interaction.opened")).map((fact) => fact.data) as Array<{
    interactionId: string;
    request: Record<string, unknown>;
    subject: { callId: string };
    origin?: { agent: string };
  }>;
}

async function nextInteraction(session: StoredSession, count = 1) {
  return waitFor(async () => (await opened(session))[count - 1]);
}

function asking(prompt: string, details?: Parameters<ReturnType<typeof contextOf>["requestApproval"]>[3]) {
  const results: ApprovalResult[] = [];
  const script = async (turn: FakeTurn) => {
    const context = contextOf(turn);
    context.onCallStart();
    const result = await context.requestApproval(prompt, "call_1", details?.reason ? "Ana" : null, details);
    context.onCallEnd();
    results.push(result);
    turn.emit({ type: "text", part: "r", text: `escolha ${result.choice}${result.always ? " sempre" : ""}` });
    turn.emit({ type: "done", ok: true });
  };
  return { script, results };
}

describe("approvals", () => {
  test("pauses the turn, shows the card and resumes on approve always", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const ask = asking("Posso rodar o deploy?", {
      grant: { kind: "repo", repo: "conty-api" },
      target: "conty-api",
      previewImage: "data:image/png;base64,AA",
      reason: "Pediu deploy.",
    } as never);
    fakeProviders.next(ask.script);
    send(session);
    const card = await nextInteraction(session);
    expect(card.request).toMatchObject({
      kind: "approval",
      display: "confirmation",
      prompt: "Posso rodar o deploy?",
      target: "conty-api",
      previewImage: "data:image/png;base64,AA",
      reason: "Pediu deploy.",
    });
    expect((card.request.options as Array<{ id: string }>).map((option) => option.id)).toEqual([
      "approve",
      "approve_always",
      "deny",
    ]);
    expect(card.subject).toEqual({ callId: "call_1" });
    expect(card.origin).toEqual({ agent: "Ana" });
    expect(await factsOfType(session, "turn.paused")).toHaveLength(1);
    expect(conversationStatus(session.meta.sessionId)).toBe("awaiting");
    expect(botStatus(bot.id)).toBe("awaiting");
    expect(answer(session, "dlv_x", "nao-existe", "approve")).toBe(false);
    expect(answer(session, "dlv_answer", card.interactionId, "approve_always")).toBe(true);
    await idle(session);
    expect(ask.results[0]).toEqual({ choice: "approve", interactionId: card.interactionId, always: true });
    expect(await repliesOf(session)).toEqual(["escolha approve sempre"]);
    const settled = (await factsOfType(session, "interaction.settled"))[0].data;
    expect(settled).toMatchObject({ outcome: "accepted", response: { optionId: "approve_always" } });
    expect((await factsOfType(session, "response.submitted"))[0].data.deliveryId).toBe("dlv_answer");
  });

  test("asks for a secret and records a denial", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const ask = asking("Cole a chave", { secret: { name: "API_KEY" } } as never);
    fakeProviders.next(ask.script);
    send(session);
    const card = await nextInteraction(session);
    expect(card.request).toMatchObject({ kind: "secret", display: "secret_form", secret: { name: "API_KEY" } });
    expect((card.request.options as Array<{ label: string }>).map((option) => option.label)).toEqual([
      "Salvar",
      "Agora não",
    ]);
    expect(card.origin).toBeUndefined();
    answer(session, "dlv_deny", card.interactionId, "deny");
    await idle(session);
    expect(ask.results[0]).toEqual({ choice: "deny", interactionId: card.interactionId });
    expect((await factsOfType(session, "interaction.settled"))[0].data.outcome).toBe("declined");
  });

  test("an approval with a timeout expires as a denial and an answered one clears its timer", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const ask = asking("Posso rodar?", { timeoutMs: 20 } as never);
    fakeProviders.next(ask.script);
    send(session);
    const card = await nextInteraction(session);
    await idle(session);
    expect(ask.results[0]).toEqual({ choice: "deny", interactionId: card.interactionId });
    expect((await factsOfType(session, "interaction.settled"))[0].data.outcome).toBe("expired");
    expect(answer(session, "dlv_late", card.interactionId, "approve")).toBe(false);

    const quick = asking("Posso rodar de novo?", { timeoutMs: 60_000 } as never);
    fakeProviders.next(quick.script);
    send(session);
    const second = await nextInteraction(session, 2);
    expect(answer(session, "dlv_ok", second.interactionId, "approve")).toBe(true);
    await idle(session);
    expect(quick.results[0].choice).toBe("approve");
  });

  test("withdraws the card when the turn is cancelled", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const ask = asking("Posso?");
    fakeProviders.next(ask.script);
    send(session);
    await nextInteraction(session);
    expect(cancel(session)).toBe(true);
    await idle(session);
    expect(ask.results[0].choice).toBe("deny");
    expect((await factsOfType(session, "interaction.settled"))[0].data.outcome).toBe("withdrawn");
    expect((await settledOf(session))?.outcome).toBe("cancelled");
  });

  test("denies open cards when the provider crashes", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const results: ApprovalResult[] = [];
    fakeProviders.next(async (turn) => {
      void contextOf(turn)
        .requestApproval("Posso?", "call_1", null)
        .then((result) => results.push(result));
      throw new Error("caiu");
    });
    await run(session);
    expect(results.map((result) => result.choice)).toEqual(["deny"]);
    expect(await settledOf(session)).toMatchObject({ outcome: "failed", error: { message: "caiu" } });
  });
});

describe("steering a paused turn", () => {
  test("closes the card and continues from the new message", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const ask = asking("Posso apagar?");
    fakeProviders.next(
      sequence(async (turn) => {
        turn.emit({ type: "session", id: "prov-steer" });
        await ask.script(turn);
      }, replyWith("Ok, não apago e sigo assim.")),
    );
    send(session, { text: "limpa a pasta" });
    await nextInteraction(session);
    send(session, { deliveryId: "dlv_steer", text: "  não apaga, só lista  " });
    await idle(session);
    const steer = (await factsOfType(session, "delivery.consumed")).find((fact) => fact.data.steer);
    expect(steer?.data).toMatchObject({ deliveryId: "dlv_steer", turnId: "turn_0" });
    expect((await factsOfType(session, "interaction.settled"))[0].data).toMatchObject({
      outcome: "withdrawn",
      reason: "message",
    });
    expect(ask.results[0].choice).toBe("deny");
    expect(fakeProviders.turns).toHaveLength(2);
    expect(lastRequest().prompt).toContain("não apaga, só lista");
    expect(lastRequest().resume).toBe("prov-steer");
    expect(await repliesOf(session)).toEqual(["Ok, não apago e sigo assim."]);
    expect(await factsOfType(session, "turn.started")).toHaveLength(1);
  });

  test("retries from the handoff when the resumed steer run fails", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    track(spyOn(threads, "recordThreadMessage").mockRejectedValue(new Error("sem disco")));
    track(spyOn(handoff, "handoffBlock").mockResolvedValue(""));
    const ask = asking("Posso?");
    fakeProviders.next(
      sequence(
        async (turn) => {
          turn.emit({ type: "session", id: "prov-a" });
          await ask.script(turn);
        },
        ({ emit }) => emit({ type: "done", ok: false, message: "sessão expirou" }),
        replyWith("Recomecei."),
      ),
    );
    const errors = track(spyOn(console, "error").mockImplementation(() => undefined));
    session.meta.kind = "session";
    send(session);
    await nextInteraction(session);
    send(session, { text: "segue sem isso" });
    await idle(session);
    expect(errors).not.toHaveBeenCalled();
    expect(fakeProviders.turns.map((turn) => turn.request.resume)).toEqual([null, "prov-a", null]);
    expect(fakeProviders.turns[2].request.prompt).toContain("segue sem isso");
    expect(await repliesOf(session)).toEqual(["Recomecei."]);
    expect((await settledOf(session))?.outcome).toBe("completed");
  });

  test("queues voice, empty and non-chat messages instead of steering", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const ask = asking("Posso?");
    fakeProviders.next(sequence(ask.script, replyWith("próxima")));
    send(session);
    const card = await nextInteraction(session);
    send(session, { text: "voz", voice: true });
    send(session, { text: "   " });
    send(session, { text: "rotina", source: "schedule" });
    expect(await opened(session)).toHaveLength(1);
    answer(session, "dlv_ok", card.interactionId, "approve");
    await idle(session);
    expect(await factsOfType(session, "turn.started")).toHaveLength(4);
    expect((await factsOfType(session, "delivery.consumed")).some((fact) => fact.data.steer)).toBe(false);
  });

  test("steers with a skill attached and keeps the skill in the consumed fact", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const ask = asking("Posso?");
    fakeProviders.next(sequence(ask.script, replyWith("segui a skill")));
    send(session);
    await nextInteraction(session);
    send(session, { text: "usa isso", skills: [{ slug: "s", name: "S", body: "b", files: [] }] });
    await idle(session);
    const steer = (await factsOfType(session, "delivery.consumed")).find((fact) => fact.data.steer);
    expect(steer?.data.skills).toEqual([{ slug: "s", name: "S" }]);
    expect(lastRequest().prompt).toContain("A pessoa anexou a skill");
    expect(await factsOfType(session, "turn.started")).toHaveLength(1);
  });
});

describe("steering a running turn", () => {
  function liveTurn(reply: string) {
    const pushed: LiveMessage[] = [];
    const arrived = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const script = async (turn: FakeTurn) => {
      turn.emit({ type: "session", id: "prov-live" });
      turn.inbox?.((message) => {
        void Promise.resolve(message).then((item) => {
          pushed.push(item);
          arrived.resolve();
        });
        return true;
      });
      started.resolve();
      await arrived.promise;
      turn.emit({ type: "text", part: "r", text: reply });
      turn.inbox?.(null);
      turn.emit({ type: "done", ok: true });
    };
    return { script, pushed, started: started.promise };
  }

  test("pushes the message into the live run with the steer lead", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const live = liveTurn("Tirei as faixas e não abro PR.");
    fakeProviders.next(live.script);
    send(session, { text: "faz a landing" });
    await live.started;
    send(session, { deliveryId: "dlv_meio", text: "não abre PR, tira as faixas" });
    await idle(session);
    expect(live.pushed).toHaveLength(1);
    expect(live.pushed[0].text).toStartWith(steerLead);
    expect(live.pushed[0].text).toContain("não abre PR, tira as faixas");
    const steer = (await factsOfType(session, "delivery.consumed")).find((fact) => fact.data.steer);
    expect(steer?.data).toMatchObject({ deliveryId: "dlv_meio", turnId: "turn_0", source: "chat" });
    expect(fakeProviders.turns).toHaveLength(1);
    expect(await factsOfType(session, "turn.started")).toHaveLength(1);
    expect(await repliesOf(session)).toEqual(["Tirei as faixas e não abro PR."]);
  });

  test("sends attached images along with the live message", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    track(
      spyOn(uploads, "prepareAttachments").mockResolvedValue({
        text: '- Imagem "faixa.png" vai junto nesta mensagem.',
        images: [{ path: "/tmp/faixa.png", mime: "image/png", label: "Imagem anexada: faixa.png" }],
      } as never),
    );
    const live = liveTurn("Vi a imagem.");
    fakeProviders.next(live.script);
    send(session, { text: "faz a landing" });
    await live.started;
    send(session, {
      text: "tira isso",
      attachments: [
        {
          uploadId: "up_1",
          name: "faixa.png",
          mime: "image/png",
          size: 10,
          kind: "image",
          file: "faixa.png",
          createdAt: new Date().toISOString(),
          source: "user",
        },
      ],
    });
    await idle(session);
    expect(live.pushed[0].images).toEqual([
      { path: "/tmp/faixa.png", mime: "image/png", label: "Imagem anexada: faixa.png" },
    ]);
    expect(live.pushed[0].text).toContain('Imagem "faixa.png"');
    const steer = (await factsOfType(session, "delivery.consumed")).find((fact) => fact.data.steer);
    expect(steer?.data.attachments).toMatchObject([{ uploadId: "up_1" }]);
  });

  test("stops at the next tool boundary and resumes with the message when the provider has no live input", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const started = Promise.withResolvers<void>();
    const steered = Promise.withResolvers<void>();
    fakeProviders.next(
      sequence(async (turn) => {
        turn.emit({ type: "session", id: "prov-run" });
        started.resolve();
        await steered.promise;
        turn.emit({ type: "text", part: "old", text: "ainda no plano antigo" });
        const context = contextOf(turn);
        context.onCallStart();
        context.onCallEnd();
        await aborted(turn.signal);
      }, replyWith("Ajustei.")),
    );
    send(session, { text: "faz a landing" });
    await started.promise;
    send(session, { text: "muda o título" });
    steered.resolve();
    await idle(session);
    expect(fakeProviders.turns).toHaveLength(2);
    expect(lastRequest().resume).toBe("prov-run");
    expect(lastRequest().prompt).toStartWith(steerLead);
    expect(lastRequest().prompt).toContain("muda o título");
    expect(await repliesOf(session)).toEqual(["Ajustei."]);
    expect(await factsOfType(session, "turn.started")).toHaveLength(1);
    expect((await settledOf(session))?.outcome).toBe("completed");
  });

  test("hands messages that arrived before the run started to the live input", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const gate = Promise.withResolvers<void>();
    track(
      spyOn(handoff, "handoffBlock").mockImplementation(async () => {
        await gate.promise;
        return "";
      }),
    );
    const live = liveTurn("Considerei.");
    fakeProviders.next(live.script);
    send(session, { text: "faz a landing" });
    await waitFor(async () => (await factsOfType(session, "turn.started")).length === 1);
    send(session, { text: "e usa azul" });
    gate.resolve();
    await idle(session);
    expect(live.pushed.map((item) => item.text)).toEqual([`${steerLead}\ne usa azul`]);
    expect(fakeProviders.turns).toHaveLength(1);
  });
});

describe("cancel", () => {
  test("returns false when nothing runs and drops queued deliveries", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    expect(cancel(session)).toBe(false);
    const held = hold();
    fakeProviders.next(held.script);
    send(session);
    await held.started;
    const finished: unknown[] = [];
    send(session, {
      delegation: { onStart: () => undefined, onAwaiting: () => undefined, finish: (result) => finished.push(result) },
    });
    expect(cancel(session)).toBe(true);
    await idle(session);
    expect(finished).toEqual([{ outcome: "cancelled", reply: "" }]);
    expect(await factsOfType(session, "turn.started")).toHaveLength(1);
    expect((await settledOf(session))?.outcome).toBe("cancelled");
  });

  test("lets a tool cancel the turn with a reason", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    fakeProviders.next(async (turn) => {
      const context = contextOf(turn);
      context.cancelTurn?.("Pedido sem sentido.");
      context.cancelTurn?.("de novo");
      await aborted(turn.signal);
      turn.emit({ type: "done", ok: false, message: "cancelled" });
    });
    await run(session);
    expect(await settledOf(session)).toMatchObject({ outcome: "cancelled", reason: "Pedido sem sentido." });
  });

  test("settles as cancelled when the provider throws after a cancel", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    fakeProviders.next((turn) => {
      contextOf(turn).cancelTurn?.("parar");
      throw new Error("abortado");
    });
    await run(session);
    expect(await settledOf(session)).toMatchObject({ outcome: "cancelled" });
    expect((await settledOf(session))?.reason).toBeUndefined();
  });
});

describe("progress guard", () => {
  test("stops a turn that is not advancing and explains what it tried", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const gate = Promise.withResolvers<decisions.DecisionRecord>();
    const progress = track(spyOn(decisions, "decideProgress").mockReturnValue(gate.promise));
    fakeProviders.next(async (turn) => {
      const context = contextOf(turn);
      for (let index = 1; index <= 8; index++) context.onCallSettled(`tentativa ${index}`);
      context.emitDecision({ kind: "approval", outcome: "human", answer: null } as never);
      gate.resolve({ kind: "progress", outcome: "stop", answer: { progress: 0.1 } } as never);
      await aborted(turn.signal);
      turn.emit({ type: "text", part: "a", text: "ainda tentando" });
      turn.emit({ type: "done", ok: false, message: "aborted" });
    });
    await run(session, { text: "arruma o build" });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls[0]).toEqual([
      "arruma o build",
      ["tentativa 1", "tentativa 2", "tentativa 3", "tentativa 4"],
    ]);
    expect(await settledOf(session)).toMatchObject({ outcome: "completed", stoppedBy: "progress_guard" });
    const reply = (await repliesOf(session)).join("\n");
    expect(reply).toContain("Parei aqui porque não estava avançando");
    expect(reply).toContain("- tentativa 8");
    expect((await factsOfType(session, "decision.made")).map((fact) => fact.data.outcome)).toEqual(["human", "stop"]);
  });

  test("keeps going when the guard says continue", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    track(
      spyOn(decisions, "decideProgress").mockResolvedValue({
        kind: "progress",
        outcome: "continue",
        answer: null,
      } as never),
    );
    fakeProviders.next(async (turn) => {
      const context = contextOf(turn);
      for (let index = 1; index <= 4; index++) context.onCallSettled(`passo ${index}`);
      await waitFor(async () => (await factsOfType(session, "decision.made")).length > 0);
      turn.emit({ type: "text", part: "a", text: "terminei" });
      turn.emit({ type: "done", ok: true });
    });
    await run(session);
    expect((await settledOf(session)).stoppedBy).toBeUndefined();
    expect(await repliesOf(session)).toEqual(["terminei"]);
  });

  test("ignores a stop that arrives after the turn was cancelled", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const gate = Promise.withResolvers<decisions.DecisionRecord>();
    track(spyOn(decisions, "decideProgress").mockReturnValue(gate.promise));
    fakeProviders.next(async (turn) => {
      const context = contextOf(turn);
      for (let index = 1; index <= 4; index++) context.onCallSettled(`passo ${index}`);
      context.cancelTurn?.("cancelado");
      gate.resolve({ kind: "progress", outcome: "stop", answer: null } as never);
      await gate.promise;
      await Promise.resolve();
      for (let index = 5; index <= 8; index++) context.onCallSettled(`passo ${index}`);
    });
    await run(session);
    expect(await settledOf(session)).toMatchObject({ outcome: "cancelled", reason: "cancelado" });
    expect(await repliesOf(session)).toEqual([]);
  });
});

describe("ending a run", () => {
  test("ends the provider run without failing the turn", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    fakeProviders.next(async (turn) => {
      turn.emit({ type: "text", part: "a", text: "Abri o que precisava." });
      contextOf(turn).endRun?.();
      await aborted(turn.signal);
      turn.emit({ type: "done", ok: false, message: "aborted" });
    });
    await run(session);
    expect((await settledOf(session))?.outcome).toBe("completed");
    expect(await repliesOf(session)).toEqual(["Abri o que precisava."]);
  });
});

describe("turn slots", () => {
  test("queues a turn beyond the limit and starts it when a slot frees", async () => {
    const holders = [hold(), hold(), hold()];
    const sessions: StoredSession[] = [];
    for (const held of holders) {
      const bot = await makeBot();
      const session = await newSession(bot.id);
      sessions.push(session);
      fakeProviders.next(held.script);
      send(session);
      await held.started;
    }
    const bot = await makeBot();
    const waiting = await newSession(bot.id);
    fakeProviders.next(replyWith("finalmente"));
    send(waiting);
    await waitFor(async () => (await factsOfType(waiting, "turn.queued")).length > 0);
    expect((await factsOfType(waiting, "turn.queued"))[0].data).toMatchObject({ position: 1, limit: 3 });
    expect(isBusy(waiting.meta.sessionId)).toBe(true);
    holders[0].release();
    await idle(waiting);
    expect(await factsOfType(waiting, "turn.dequeued")).toHaveLength(1);
    expect(await repliesOf(waiting)).toEqual(["finalmente"]);
    for (const held of holders.slice(1)) held.release();
    for (const session of sessions) await idle(session);
  });
});
