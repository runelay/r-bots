import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsOfType, makeBot, newSession, waitFor } from "../../../../test/engine-helpers";
import {
  byBot,
  contextOf,
  hold,
  idle,
  quietEngine,
  repliesOf,
  restoreTracked,
  run,
  send,
  settledOf,
  track,
} from "../../../../test/engine-turn-helpers";
import { type FakeTurn, fakeProviders } from "../../../../test/helpers";
import * as decisions from "../../approvals/services/decisions.service";
import { getBot, setArchived } from "../../bots/services/bots.service";
import { botHomePath } from "../../code/services/bot-home.service";
import * as conversations from "../../conversations/services/conversations.service";
import { getStoredSession, type StoredSession } from "../../conversations/services/sessions.service";
import * as threads from "../../conversations/services/threads.service";
import { createGroup, setGroupArchived } from "../../groups/services/groups.service";
import { outboxDir } from "../../uploads/services/send-file.service";
import { answer, cancel, conversationStatus } from "../services/engine.service";

beforeEach(async () => {
  quietEngine();
});

afterEach(async () => {
  restoreTracked();
});

async function updates(session: StoredSession) {
  return (await factsOfType(session, "delegation.updated")).map((fact) => fact.data) as Array<Record<string, unknown>>;
}

function delegating(targetId: string, message: string, outcome: { reply?: string; error?: string }) {
  return async (turn: FakeTurn) => {
    try {
      const reply = await contextOf(turn).delegate(targetId, message, "call_del");
      outcome.reply = reply;
      turn.emit({ type: "text", part: "r", text: `Resposta: ${reply}` });
    } catch (error) {
      outcome.error = (error as Error).message;
      turn.emit({ type: "text", part: "r", text: `Erro: ${outcome.error}` });
    }
    turn.emit({ type: "done", ok: true });
  };
}

async function childSession(parent: StoredSession) {
  const id = (await updates(parent))[0]?.sessionId as string | undefined;
  return id ? getStoredSession(id) : undefined;
}

describe("delegation", () => {
  test("runs the task in a new conversation of the target and returns its reply", async () => {
    const boss = await makeBot({ name: "Chefe Del", role: "Coordena" });
    const worker = await makeBot({ role: "" });
    const session = await newSession(boss.id);
    session.meta.permission = "edit";
    const outcome: { reply?: string; error?: string } = {};
    fakeProviders.next(
      byBot({
        [boss.id]: delegating(worker.id, "levanta os números e faz o commit", outcome),
        [worker.id]: async (turn) => {
          const result = await contextOf(turn).requestApproval("Posso ler?", "call_w", null);
          turn.emit({ type: "text", part: "w", text: `Números ok (${result.choice}).` });
          turn.emit({ type: "done", ok: true });
        },
      }),
    );
    send(session, { text: "pede pro time e abre o PR" });
    const child = await waitFor(async () => await childSession(session));
    await waitFor(async () => (await factsOfType(child, "interaction.opened"))[0]);
    const card = (await factsOfType(child, "interaction.opened"))[0].data.interactionId as string;
    answer(child, "dlv_w", card, "approve");
    await idle(session);
    expect(outcome).toEqual({ reply: "Números ok (approve)." });
    expect((await updates(session)).map((item) => item.status)).toEqual([
      "starting",
      "working",
      "awaiting",
      "working",
      "completed",
    ]);
    expect((await updates(session)).at(-1)).toMatchObject({
      botId: worker.id,
      callId: "call_del",
      summary: "Números ok (approve).",
    });
    expect(child.meta.permission).toBe("edit");
    expect(child.meta.conversation?.delegatedBy).toMatchObject({ botId: boss.id, callId: "call_del" });
    const workerRequest = fakeProviders.turns.find((turn) => turn.request.workKey.startsWith(`${worker.id}/`));
    expect(workerRequest?.request.prompt).toContain(`Chefe Del (Coordena), outro bot do time, te passou esta tarefa:`);
    expect(workerRequest?.request.prompt).toContain("A pessoa pediu commit, push e PR");
    expect((await factsOfType(child, "delivery.admitted"))[0].data.source).toMatchObject({
      channel: "channel:delegate",
      botId: boss.id,
      callId: "call_del",
    });
    expect((await factsOfType(child, "turn.started"))[0].data.delegatedBy).toBe(boss.id);
    expect((await factsOfType(child, "delivery.consumed"))[0].data.from).toMatchObject({
      botId: boss.id,
      name: "Chefe Del",
    });
    expect(child.meta.conversation?.lastMessage?.text).toBeTruthy();
    expect(await repliesOf(session)).toEqual(["Resposta: Números ok (approve)."]);
  });

  test("uses a default role in the prompt and reports an empty reply", async () => {
    const boss = await makeBot();
    boss.role = "";
    const worker = await makeBot();
    const session = await newSession(boss.id);
    const outcome: { reply?: string; error?: string } = {};
    fakeProviders.next(
      byBot({
        [boss.id]: delegating(worker.id, "faz", outcome),
        [worker.id]: ({ emit }) => emit({ type: "done", ok: true }),
      }),
    );
    await run(session);
    expect(outcome.reply).toBe(`${worker.name} terminou sem responder.`);
    const workerRequest = fakeProviders.turns.find((turn) => turn.request.workKey.startsWith(`${worker.id}/`));
    expect(workerRequest?.request.prompt).toContain(`${boss.name} (bot do time), outro bot do time`);
  });

  test("raises the target failure to the caller", async () => {
    const boss = await makeBot();
    const worker = await makeBot();
    const session = await newSession(boss.id);
    const outcome: { reply?: string; error?: string } = {};
    fakeProviders.next(
      byBot({
        [boss.id]: delegating(worker.id, "faz", outcome),
        [worker.id]: ({ emit }) => emit({ type: "done", ok: false, message: "quebrou" }),
      }),
    );
    await run(session);
    expect(outcome.error).toBe(`${worker.name} falhou: quebrou`);
    expect((await updates(session)).at(-1)).toMatchObject({ status: "failed", error: "quebrou" });
  });

  test("rejects an unknown, archived or unavailable target and a delegation back", async () => {
    const boss = await makeBot();
    const archived = await makeBot();
    await setArchived(archived.id, true);
    const offline = await makeBot();
    offline.engine = { account: "vps:nada", model: "m", effort: null };
    const session = await newSession(boss.id);
    const errors: string[] = [];
    const tryDelegate = async (turn: FakeTurn, target: string) => {
      try {
        await contextOf(turn).delegate(target, "faz", "call_x");
      } catch (error) {
        errors.push((error as Error).message);
      }
    };
    fakeProviders.next(
      byBot({
        [boss.id]: async (turn) => {
          await tryDelegate(turn, "bot-inexistente");
          await tryDelegate(turn, archived.id);
          await tryDelegate(turn, offline.id);
          turn.emit({ type: "done", ok: true });
        },
      }),
    );
    await run(session);
    expect(errors[0]).toBe("O bot bot-inexistente não está disponível.");
    expect(errors[1]).toBe(`O bot ${archived.id} não está disponível.`);
    expect(errors[2]).toBe("A conta vps:nada não existe.");

    const worker = await makeBot();
    const outcome: { reply?: string; error?: string } = {};
    const back: { reply?: string; error?: string } = {};
    fakeProviders.next(
      byBot({
        [boss.id]: delegating(worker.id, "faz", outcome),
        [worker.id]: delegating(boss.id, "volta", back),
      }),
    );
    await run(session);
    expect(back.error).toBe(
      `${boss.name} está esperando uma resposta sua agora. Resolva você mesmo, sem delegar de volta.`,
    );
    expect(outcome.reply).toContain("Erro:");
  });

  test("cancels the delegated turn when the caller is cancelled", async () => {
    const boss = await makeBot();
    const worker = await makeBot();
    const session = await newSession(boss.id);
    const outcome: { reply?: string; error?: string } = {};
    const workerHeld = hold();
    fakeProviders.next(
      byBot({
        [boss.id]: delegating(worker.id, "faz", outcome),
        [worker.id]: workerHeld.script,
      }),
    );
    send(session);
    await workerHeld.started;
    const child = (await childSession(session)) as StoredSession;
    cancel(session);
    await idle(session);
    await idle(child);
    expect(outcome.error).toBe("Pedido cancelado.");
    expect(await settledOf(child)).toMatchObject({ outcome: "cancelled", reason: `${boss.name} cancelou o pedido.` });
    expect((await updates(session)).at(-1)?.status).toBe("cancelled");
  });

  test("returns cancelled at once when the caller was already cancelled", async () => {
    const boss = await makeBot();
    const worker = await makeBot();
    const session = await newSession(boss.id);
    const outcome: { reply?: string; error?: string } = {};
    fakeProviders.next(
      byBot({
        [boss.id]: async (turn) => {
          contextOf(turn).cancelTurn?.("parou");
          await delegating(worker.id, "faz", outcome)(turn);
        },
      }),
    );
    await run(session);
    expect(outcome.error).toBe("Pedido cancelado.");
    expect(fakeProviders.turns).toHaveLength(1);
  });

  test("queues behind a busy target and withdraws from its queue", async () => {
    const boss = await makeBot();
    const worker = await makeBot();
    const busy = await newSession(worker.id);
    const busyHeld = hold();
    fakeProviders.next(busyHeld.script);
    send(busy);
    await busyHeld.started;
    track(spyOn(conversations, "createConversation").mockResolvedValue(busy));
    const outcome: { reply?: string; error?: string } = {};
    const bossSession = await newSession(boss.id);
    fakeProviders.next(byBot({ [boss.id]: delegating(worker.id, "faz", outcome) }));
    send(bossSession);
    await waitFor(async () => (await updates(bossSession))[0]);
    expect((await updates(bossSession))[0].status).toBe("queued");
    cancel(bossSession);
    await idle(bossSession);
    expect(outcome.error).toBe("Pedido cancelado.");
    expect((await updates(bossSession)).at(-1)?.status).toBe("cancelled");
    busyHeld.release();
    await idle(busy);
    expect(await factsOfType(busy, "turn.started")).toHaveLength(1);
  });

  test("reports a target that stopped before finishing", async () => {
    const boss = await makeBot();
    const worker = await makeBot();
    const busy = await newSession(worker.id);
    const busyHeld = hold();
    fakeProviders.next(busyHeld.script);
    send(busy);
    await busyHeld.started;
    track(spyOn(conversations, "createConversation").mockResolvedValue(busy));
    const outcome: { reply?: string; error?: string } = {};
    const bossSession = await newSession(boss.id);
    fakeProviders.next(byBot({ [boss.id]: delegating(worker.id, "faz", outcome) }));
    send(bossSession);
    await waitFor(async () => (await updates(bossSession))[0]);
    cancel(busy);
    await idle(bossSession);
    expect(outcome.error).toBe(`${worker.name} parou antes de terminar.`);
  });
});

describe("delegation threads and files", () => {
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  function generating(path: string) {
    return (turn: FakeTurn) => {
      turn.emit({ type: "session", id: "codex-thread" });
      turn.emit({ type: "image", path });
      turn.emit({ type: "text", part: "i", text: `Pronto: ${path}` });
      turn.emit({ type: "done", ok: true });
    };
  }

  test("reuses the target conversation for follow-ups from the same origin conversation", async () => {
    const boss = await makeBot();
    const worker = await makeBot();
    const session = await newSession(boss.id);
    const first: { reply?: string; error?: string } = {};
    const second: { reply?: string; error?: string } = {};
    const worked = (turn: FakeTurn) => {
      turn.emit({ type: "session", id: "worker-session" });
      turn.emit({ type: "text", part: "w", text: "feito" });
      turn.emit({ type: "done", ok: true });
    };
    fakeProviders.next(byBot({ [boss.id]: delegating(worker.id, "primeiro", first), [worker.id]: worked }));
    await run(session);
    fakeProviders.next(byBot({ [boss.id]: delegating(worker.name, "segundo", second), [worker.id]: worked }));
    await run(session);
    expect(first.reply).toBe("feito");
    expect(second.reply).toBe("feito");
    const ids = (await updates(session)).map((item) => item.sessionId);
    expect(new Set(ids).size).toBe(1);
    const child = getStoredSession(ids[0] as string) as StoredSession;
    expect(child.meta.conversation?.delegatedBy).toMatchObject({ botId: boss.id, sessionId: session.meta.sessionId });
    expect(child.meta.conversation?.unread).toBe(0);
    const workerTurns = fakeProviders.turns.filter((turn) => turn.request.workKey.startsWith(`${worker.id}/`));
    expect(workerTurns).toHaveLength(2);
    expect(workerTurns[1]?.request.resume).toBe("worker-session");

    const other = await newSession(boss.id);
    const third: { reply?: string; error?: string } = {};
    fakeProviders.next(byBot({ [boss.id]: delegating(worker.id, "outro", third), [worker.id]: worked }));
    await run(other);
    expect((await updates(other))[0]?.sessionId).not.toBe(ids[0]);
  });

  test("rejects a delegation to itself", async () => {
    const boss = await makeBot();
    const session = await newSession(boss.id);
    const outcome: { reply?: string; error?: string } = {};
    fakeProviders.next(byBot({ [boss.id]: delegating(boss.id, "faz", outcome) }));
    await run(session);
    expect(outcome.error).toBe("Esse bot é você. Faça você mesmo, sem delegar.");
  });

  test("copies the files a delegated turn produced up the chain to the requester", async () => {
    const engineer = await makeBot({ name: "Eng Arq" });
    const boss = await makeBot({ name: "Chefe Arq" });
    const artist = await makeBot({ name: "Artista Arq" });
    const home = mkdtempSync(join(tmpdir(), "codex-deleg-"));
    const dir = join(home, "generated_images", "th-9");
    mkdirSync(dir, { recursive: true });
    const image = join(dir, "exec-a1b2c3d4-0000.png");
    writeFileSync(image, pixel);
    const session = await newSession(engineer.id);
    const outcome: { reply?: string; error?: string } = {};
    const relayed: { reply?: string; error?: string } = {};
    fakeProviders.next(
      byBot({
        [engineer.id]: delegating(boss.id, "pede a imagem", outcome),
        [boss.id]: delegating(artist.id, "gera a imagem", relayed),
        [artist.id]: generating(image),
      }),
    );
    await run(session);
    const bossCopy = join(outboxDir(boss.id), "recebidos", "imagem-a1b2c3d4.png");
    expect(relayed.reply).toContain(`Pronto: ${join(outboxDir(artist.id), "imagens", "imagem-a1b2c3d4.png")}`);
    expect(relayed.reply).not.toContain("generated_images");
    expect(relayed.reply).toContain(`Arquivos que ${artist.name} entregou, já copiados para você:`);
    expect(relayed.reply).toContain(`pasta de saída: ${bossCopy}`);
    expect(existsSync(bossCopy)).toBe(true);
    const engineerCopy = join(outboxDir(engineer.id), "recebidos", "imagem-a1b2c3d4.png");
    const readable = join(botHomePath(engineer.id), "recebidos", "imagem-a1b2c3d4.png");
    expect(outcome.reply).toContain(`Arquivos que ${boss.name} entregou, já copiados para você:`);
    expect(outcome.reply).toContain(`pasta de saída: ${engineerCopy}`);
    expect(outcome.reply).toContain(`para ler e copiar: ${readable}`);
    expect(outcome.reply).toMatch(/imagem-a1b2c3d4\.png \(imagem, anexo [0-9A-Z]{26}\)/);
    expect(readFileSync(readable).equals(pixel)).toBe(true);
    expect((await updates(session)).at(-1)).toMatchObject({ status: "completed", files: 1 });
    rmSync(home, { recursive: true, force: true });
  });
});

describe("delegated files that cannot be copied", () => {
  test("reports the failure and renames a repeated file", async () => {
    const boss = await makeBot();
    const artist = await makeBot();
    const home = mkdtempSync(join(tmpdir(), "codex-again-"));
    const dir = join(home, "generated_images", "th-2");
    mkdirSync(dir, { recursive: true });
    const image = join(dir, "exec-feedbeef.png");
    writeFileSync(image, "png");
    const session = await newSession(boss.id);
    const replies: string[] = [];
    const asking = async (turn: FakeTurn) => {
      replies.push(await contextOf(turn).delegate(artist.id, "gera", "call_f"));
      turn.emit({ type: "done", ok: true });
    };
    const drawing = (turn: FakeTurn) => {
      const context = contextOf(turn);
      context.log.emit({
        type: "file.sent",
        data: { attachment: { uploadId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", name: "sumiu.pdf" } },
        scope: { turnId: context.turnId },
      });
      turn.emit({ type: "image", path: image });
      turn.emit({ type: "done", ok: true });
    };
    fakeProviders.next(byBot({ [boss.id]: asking, [artist.id]: drawing }));
    await run(session);
    await run(session);
    expect(replies[0]).toContain(`${artist.name} terminou sem responder.`);
    expect(replies[0]).toContain("- sumiu.pdf: não consegui copiar (Anexo não encontrado.)");
    expect(replies[1]).toContain(join(outboxDir(boss.id), "recebidos", "imagem-feedbeef-2.png"));
    rmSync(home, { recursive: true, force: true });
  });
});

describe("groups", () => {
  async function team() {
    const ana = await makeBot({ name: `Ana ${Math.random().toString(36).slice(2, 6)}`, role: "Vendas" });
    const bia = await makeBot({ name: `Bia ${Math.random().toString(36).slice(2, 6)}` });
    bia.role = "";
    const group = await createGroup({ name: "Time", members: [ana.id, bia.id] });
    const session = await newSession(group.id, "group");
    return { ana, bia, group, session };
  }

  function speaking(botId: string, text: string, handTo?: { botId: string; note: string }) {
    return (turn: FakeTurn) => {
      if (handTo) contextOf(turn).onHandoff(handTo.botId, handTo.note);
      turn.emit({ type: "text.delta", part: "x", text: text.slice(0, 2) });
      turn.emit({ type: "text", part: "x", text });
      turn.emit({ type: "done", ok: true });
      return botId;
    };
  }

  test("routes to the chosen member and passes the turn on a handoff", async () => {
    const { ana, bia, group, session } = await team();
    (await session.log.lines()).push("{broken");
    const record = track(spyOn(threads, "recordThreadMessage"));
    const route = track(
      spyOn(decisions, "decideRoute").mockResolvedValue({
        kind: "route",
        outcome: bia.id,
        answer: { choice: bia.id },
      } as never),
    );
    fakeProviders.next(
      byBot({
        [bia.id]: speaking(bia.id, "Eu vejo isso.", { botId: ana.id, note: "Ana fecha os números" }),
        [ana.id]: async (turn) => {
          const context = contextOf(turn);
          expect(context.groupMembers.map((member) => member.id)).toEqual([bia.id]);
          expect(await context.log.lines()).toBe(await session.log.lines());
          expect(context.log.size).toBe(session.log.size);
          expect(await context.log.slice(0)).toEqual(await session.log.slice(0));
          expect(await context.log.rows(0, 1)).toEqual(await session.log.rows(0, 1));
          const unsubscribe = context.log.subscribe(() => undefined);
          (unsubscribe as () => void)();
          void context.log.load();
          context.onHandoff("bot-fora-do-grupo", "x");
          return speaking(ana.id, "Números fechados.")(turn);
        },
      }),
    );
    await run(session, { text: "Como estão as vendas?" });
    expect(route.mock.calls[0][0]).toBe("Time");
    expect((await factsOfType(session, "decision.made"))[0].data).toMatchObject({ groupId: group.id });
    const replies = (await factsOfType(session, "content.completed")).filter((fact) => fact.data.phase === "reply");
    expect(replies.map((fact) => [fact.data.botId, fact.data.value])).toEqual([
      [bia.id, "Eu vejo isso."],
      [ana.id, "Números fechados."],
    ]);
    const anaRequest = fakeProviders.turns.find((turn) => turn.request.workKey.startsWith(`${ana.id}/`))!.request;
    expect(anaRequest.prompt).toContain(`${bia.name} passou a vez para você com esta nota: Ana fecha os números`);
    expect(anaRequest.prompt).toContain(`${bia.name}: Eu vejo isso.`);
    expect(anaRequest.prompt).toContain("Pessoa: Como estão as vendas?");
    expect(anaRequest.prompt).toContain(`- ${bia.name} (\`${bia.id}\`): sem papel`);
    expect(anaRequest.resume).toBeNull();
    expect(await factsOfType(session, "delivery.consumed")).toHaveLength(1);
    const recorded = record.mock.calls.map((call) => call[2]);
    expect(recorded).toContainEqual(
      expect.objectContaining({ role: "bot", text: `${ana.name}: Números fechados.`, botId: ana.id }),
    );
    expect(recorded).toContainEqual(expect.objectContaining({ role: "user", text: "Como estão as vendas?" }));
    expect(conversationStatus(session.meta.sessionId)).toBe("idle");
  });

  test("answers the mentioned members and stops after four turns", async () => {
    const { ana, bia, session } = await team();
    const route = track(spyOn(decisions, "decideRoute"));
    fakeProviders.next(
      byBot({
        [ana.id]: speaking(ana.id, "Ana aqui.", { botId: bia.id, note: "vai" }),
        [bia.id]: speaking(bia.id, "Bia aqui.", { botId: ana.id, note: "volta" }),
      }),
    );
    await run(session, { text: `${ana.name}, tudo bem?` });
    expect(route).not.toHaveBeenCalled();
    expect(fakeProviders.turns).toHaveLength(4);
    expect(fakeProviders.turns.map((turn) => turn.request.workKey.split("/")[0])).toEqual([
      ana.id,
      bia.id,
      ana.id,
      bia.id,
    ]);
  });

  test("falls back to the first member when the route has no choice", async () => {
    const { ana, session } = await team();
    track(spyOn(decisions, "decideRoute").mockResolvedValue({ kind: "route", outcome: "none", answer: null } as never));
    fakeProviders.next(byBot({ [ana.id]: speaking(ana.id, "Primeira.") }));
    await run(session, { text: "alguém?" });
    expect(fakeProviders.turns).toHaveLength(1);
    track(
      spyOn(decisions, "decideRoute").mockResolvedValue({
        kind: "route",
        outcome: "x",
        answer: { choice: "fantasma" },
      } as never),
    );
    await run(session, { text: "alguém?" });
    expect(fakeProviders.turns).toHaveLength(2);
    expect(fakeProviders.turns[1].request.workKey.startsWith(`${ana.id}/`)).toBe(true);
  });

  test("logs a crashed route, fails the delegation and keeps serving the group", async () => {
    const { ana, session } = await team();
    const errors = track(spyOn(console, "error").mockImplementation(() => undefined));
    const route = track(spyOn(decisions, "decideRoute"));
    const hooks = { onStart: () => undefined, onAwaiting: () => undefined, finish: (_: unknown) => undefined };
    const finished = track(spyOn(hooks, "finish"));
    route.mockRejectedValueOnce(new Error("roteador caiu"));
    await run(session, { text: "alguém?", delegation: hooks });
    expect(errors.mock.calls[0][0]).toBe("turn crashed");
    expect(finished.mock.calls[0][0]).toEqual({ outcome: "failed", reply: "", error: "roteador caiu" });
    route.mockRejectedValueOnce("cru");
    await run(session, { text: "alguém?", delegation: hooks });
    expect(finished.mock.calls[1][0]).toEqual({ outcome: "failed", reply: "", error: "cru" });
    expect(conversationStatus(session.meta.sessionId)).toBe("idle");
    route.mockResolvedValueOnce({ kind: "route", outcome: ana.id, answer: { choice: ana.id } } as never);
    fakeProviders.next(byBot({ [ana.id]: speaking(ana.id, "Aqui.") }));
    await run(session, { text: "alguém?" });
    expect(await repliesOf(session)).toEqual(["Aqui."]);
  });

  test("does nothing for a missing, archived or empty group", async () => {
    const lost = await newSession("grp_sumiu", "group");
    await run(lost, { text: "oi" });
    expect(await factsOfType(lost, "turn.started")).toHaveLength(0);
    const { ana, bia, group, session } = await team();
    await setGroupArchived(group.id, true);
    await run(session, { text: "oi" });
    expect(await factsOfType(session, "turn.started")).toHaveLength(0);
    await setGroupArchived(group.id, false);
    await setArchived(ana.id, true);
    await setArchived(bia.id, true);
    await run(session, { text: "oi" });
    expect(await factsOfType(session, "turn.started")).toHaveLength(0);
    expect(getBot(ana.id)?.archivedAt).toBeTruthy();
  });

  test("does not steer a paused group turn", async () => {
    const { ana, bia, session } = await team();
    fakeProviders.next(
      byBot({
        [ana.id]: async (turn) => {
          const result = await contextOf(turn).requestApproval("Posso?", "call_g", null);
          turn.emit({ type: "text", part: "a", text: `Ana: ${result.choice}` });
          turn.emit({ type: "done", ok: true });
        },
        [bia.id]: speaking(bia.id, "Bia."),
      }),
    );
    send(session, { text: `${ana.name}, pode?` });
    const card = await waitFor(async () => (await factsOfType(session, "interaction.opened"))[0]);
    send(session, { text: `${bia.name}, e você?` });
    expect((await factsOfType(session, "delivery.consumed")).some((fact) => fact.data.steer)).toBe(false);
    answer(session, "dlv_g", card.data.interactionId as string, "approve");
    await idle(session);
    expect(fakeProviders.turns).toHaveLength(2);
  });
});
