import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsOfType, makeBot, newSession, waitFor } from "../../../../test/engine-helpers";
import {
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
  usageOf,
} from "../../../../test/engine-turn-helpers";
import { fakeProviders, replyWith } from "../../../../test/helpers";
import * as accounts from "../../accounts/services/accounts.service";
import { clearLimit, limitOf, markLimited } from "../../accounts/services/limits.service";
import * as decisions from "../../approvals/services/decisions.service";
import * as blockTools from "../../blocks/services/block-tools.service";
import { setKnownConnectors, updateBot } from "../../bots/services/bots.service";
import * as canvas from "../../canvas/services/canvas.service";
import { botHomePath } from "../../code/services/bot-home.service";
import * as computer from "../../computer/services/computer.service";
import * as handoff from "../../conversations/services/handoff.service";
import * as threads from "../../conversations/services/threads.service";
import * as uploads from "../../uploads/services/uploads.service";
import {
  botStatus,
  botStatuses,
  conversationStatus,
  isRunning,
  onStatus,
  type StatusEvent,
  sessionStatuses,
} from "../services/engine.service";

let quiet: ReturnType<typeof quietEngine>;

beforeEach(() => {
  quiet = quietEngine();
});

afterEach(() => {
  restoreTracked();
  for (const id of ["vps:claude", "vps:codex", "vps:grok", "vps:cursor", "claude-2:claude"]) clearLimit(id);
});

function withSecondClaude() {
  const real = accounts.listAccounts;
  track(
    spyOn(accounts, "listAccounts").mockImplementation(async () => {
      const list = await real();
      const main = list.find((item) => item.id === "vps:claude");
      return main
        ? [
            ...list,
            { ...main, id: "claude-2:claude", label: "Claude Anderson", name: "Claude Anderson", isDefault: false },
          ]
        : list;
    }),
  );
}

function decision(outcome: string): decisions.DecisionRecord {
  return { kind: "triage", answer: null, outcome } as unknown as decisions.DecisionRecord;
}

describe("a chat turn", () => {
  test("replies, records usage, saves the provider session and reports status", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const events: StatusEvent[] = [];
    const stop = onStatus((event) => events.push(event));
    const held = hold([
      { type: "session", id: "prov-1" },
      { type: "text.delta", part: "p", text: "Ol" },
      { type: "text", part: "p", text: "Olá, tudo certo." },
      { type: "usage", usage: usageOf({ inputTokens: 10, outputTokens: 5 }), contextTokens: 900 },
      { type: "usage", usage: usageOf({ inputTokens: 1 }), contextTokens: null },
    ]);
    fakeProviders.next(held.script);
    send(session, { text: "Olá bot, me ajuda?" });
    await held.started;
    expect(isRunning(session.meta.sessionId)).toBe(true);
    expect(botStatus(bot.id)).toBe("working");
    expect(botStatuses()[bot.id]).toBe("working");
    expect(sessionStatuses()[session.meta.sessionId]).toEqual({ botId: bot.id, status: "working" });
    expect(conversationStatus(session.meta.sessionId)).toBe("working");
    held.release();
    await idle(session);
    stop();
    expect(conversationStatus(session.meta.sessionId)).toBe("idle");
    expect(botStatus(bot.id)).toBe("idle");
    expect(await settledOf(session)).toMatchObject({ outcome: "completed", turnId: "turn_0" });
    expect(await repliesOf(session)).toEqual(["Olá, tudo certo."]);
    const usage = (await factsOfType(session, "usage.recorded"))[0].data;
    expect(usage).toMatchObject({ account: "vps:claude", usage: { inputTokens: 11, outputTokens: 5 } });
    expect(session.meta.providerSessions).toEqual({ "vps:claude@home": "prov-1" });
    expect(session.meta.contextTokens).toBe(900);
    expect(session.meta.lastEngine?.account).toBe("vps:claude");
    expect(session.meta.title.length).toBeGreaterThan(0);
    expect(events).toContainEqual({ botId: bot.id, sessionId: session.meta.sessionId, status: "working" });
    expect(events).toContainEqual({ botId: bot.id, status: "idle" });
    expect(quiet.summary).toHaveBeenCalled();
    expect(quiet.capture).toHaveBeenCalled();

    fakeProviders.next(replyWith("de novo"));
    await run(session, { text: "mais uma" });
    expect(lastRequest().resume).toBe("prov-1");
  });

  test("splits narration from the reply around native tool calls", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const warn = track(spyOn(console, "warn").mockImplementation(() => undefined));
    fakeProviders.next(({ emit }) => {
      emit({ type: "text", part: "a", text: "Vou listar." });
      emit({ type: "tool", id: "t1", name: "Bash", phase: "start", input: { command: "ls   -la\n/tmp" } });
      emit({ type: "tool", id: "t1", name: "Bash", phase: "end", ok: true, output: "ok" });
      emit({ type: "text", part: "b", text: "   " });
      emit({ type: "tool", id: "t2", name: "Edit", phase: "start", input: { files: ["/repo/src/a.ts", "b.ts"] } });
      emit({ type: "tool", id: "t2", name: "Edit", phase: "end", ok: false });
      emit({ type: "tool", id: "t3", name: "Edit", phase: "start" });
      emit({ type: "tool", id: "t3", name: "Edit", phase: "end" });
      emit({ type: "warning", message: "devagar" });
      emit({ type: "text", part: "c", text: "Pronto." });
      emit({ type: "done", ok: true });
    });
    await run(session, { text: "lista os arquivos" });
    expect(await repliesOf(session, "narration")).toEqual(["Vou listar."]);
    expect(await repliesOf(session)).toEqual(["Pronto."]);
    const requested = (await factsOfType(session, "call.requested")).map(
      (fact) => (fact.data.capability as { label: string }).label,
    );
    expect(requested).toEqual(["Rodar ls -la /tmp", "Editar a.ts, b.ts", "Editar "]);
    const settled = (await factsOfType(session, "call.settled")).map((fact) => fact.data);
    expect(settled[0]).toMatchObject({ callId: "ext_t1", outcome: "completed", output: "ok" });
    expect(settled[1]).toMatchObject({ outcome: "failed", output: null, error: { code: "TOOL_EXECUTION_FAILED" } });
    expect((await factsOfType(session, "model.started")).length).toBeGreaterThanOrEqual(3);
    expect(warn).toHaveBeenCalledWith("provider warning vps:claude: devagar");
    expect(await factsOfType(session, "usage.recorded")).toHaveLength(0);
  });

  test("attaches images the provider generated and skips paths outside generated_images", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const warn = track(spyOn(console, "warn").mockImplementation(() => undefined));
    const home = mkdtempSync(join(tmpdir(), "codex-gen-"));
    const dir = join(home, "generated_images", "th-1");
    mkdirSync(dir, { recursive: true });
    const image = join(dir, "exec-0123abcd-ffff.png");
    writeFileSync(
      image,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    fakeProviders.next(({ emit }) => {
      emit({ type: "image", path: image });
      emit({ type: "image", path: join(home, "secret.png") });
      emit({ type: "text", part: "a", text: "Feito." });
      emit({ type: "done", ok: true });
    });
    await run(session, { text: "gera uma imagem" });
    const sent = await factsOfType(session, "file.sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.data).toMatchObject({ botId: bot.id, attachment: { name: "imagem-0123abcd.png", source: "bot" } });
    expect(warn.mock.calls.some((call) => String(call[0]).startsWith(`generated image ${bot.id}`))).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("fails the turn with the provider message and forgets a resumed session without reply", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    fakeProviders.next(replyWith("primeira"));
    await run(session);
    fakeProviders.next(({ emit }) => emit({ type: "done", ok: false, message: "explodiu" }));
    await run(session, { text: "de novo" });
    expect(await settledOf(session)).toMatchObject({
      outcome: "failed",
      error: { code: "MODEL_CALL_FAILED", message: "explodiu" },
    });
    expect(session.meta.providerSessions).toEqual({});
    fakeProviders.next(({ emit }) => emit({ type: "done", ok: false }));
    await run(session, { text: "e agora" });
    expect((await settledOf(session))?.error?.message).toBe("Falha no provedor.");
  });

  test("reports a provider crash and denies open approvals", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    fakeProviders.next(() => {
      throw new Error("pane no provedor");
    });
    await run(session);
    expect(await settledOf(session)).toMatchObject({ outcome: "failed", error: { message: "pane no provedor" } });
    fakeProviders.next(() => {
      throw "falha crua";
    });
    await run(session);
    expect((await settledOf(session))?.error?.message).toBe("falha crua");
  });

  test("fails when the bot no longer exists", async () => {
    const session = await newSession("bot-que-sumiu");
    await run(session, { text: "alô" });
    expect(await settledOf(session)).toMatchObject({ outcome: "failed", error: { code: "BOT_NOT_FOUND" } });
    expect(fakeProviders.turns).toHaveLength(0);
  });

  test("fails when the account is missing or down and nothing can take over", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    bot.engine = { account: "vps:nada", model: "x", effort: null, fallback: null };
    await run(session);
    expect(await settledOf(session)).toMatchObject({
      outcome: "failed",
      error: { code: "ACCOUNT_UNAVAILABLE", message: "A conta vps:nada não existe." },
    });
    track(
      spyOn(accounts, "findAccount").mockImplementation(async (id: string) => ({
        ...(await accounts.listAccounts()).find((item) => item.id === "vps:claude")!,
        id,
        status: "offline",
        detail: "caiu",
      })),
    );
    bot.engine = { account: "vps:claude", model: "x", effort: null, fallback: null };
    await run(session);
    expect((await settledOf(session))?.error?.message).toBe("A conta Claude está fora do ar. caiu");
    expect(fakeProviders.turns).toHaveLength(0);
  });

  test("fails the turn and frees the session when recording the user message fails", async () => {
    const bot = await makeBot();
    const record = track(spyOn(threads, "recordThreadMessage"));
    const hooks = { onStart: () => undefined, onAwaiting: () => undefined, finish: (_: unknown) => undefined };
    const finished = track(spyOn(hooks, "finish"));
    record.mockRejectedValueOnce(new Error("disco cheio"));
    const session = await newSession(bot.id);
    send(session, { delegation: hooks });
    await waitFor(() => finished.mock.calls.length === 1);
    expect(finished.mock.calls[0][0]).toEqual({ outcome: "failed", reply: "", error: "disco cheio" });
    await idle(session);
    expect(isRunning(session.meta.sessionId)).toBe(false);
    expect(conversationStatus(session.meta.sessionId)).toBe("idle");
    fakeProviders.next(replyWith("voltei"));
    await run(session, { text: "de novo" });
    expect((await settledOf(session))?.outcome).toBe("completed");
    expect((await repliesOf(session)).at(-1)).toBe("voltei");
    record.mockRejectedValueOnce("cru");
    const other = await newSession(bot.id);
    send(other, { delegation: hooks });
    await waitFor(() => finished.mock.calls.length === 2);
    expect(finished.mock.calls[1][0]).toEqual({ outcome: "failed", reply: "", error: "cru" });
    await idle(other);
    expect(isRunning(other.meta.sessionId)).toBe(false);
  });
});

describe("the system prompt", () => {
  test("introduces a new bot in its thread and lists delegates, connectors and the Mac", async () => {
    const bot = await makeBot({ instructions: "" });
    bot.capabilities = { ...bot.capabilities, computer: true };
    track(spyOn(computer, "watchComputerEvents").mockReturnValue(() => undefined));
    const other = await makeBot({ role: "Analista" });
    setKnownConnectors(["linear"]);
    try {
      const session = await newSession(bot.id, "thread");
      await run(session);
      const prompt = lastRequest().systemPrompt;
      expect(prompt).toContain(`Você é ${bot.name}, um bot novo`);
      expect(prompt).toContain(`- \`${other.id}\`: ${other.name}, Analista`);
      expect(prompt).toContain("Serviços conectados liberados (runelay): linear.");
      expect(prompt).toContain("## Uso do Mac da pessoa");
      expect(prompt).toContain("Você acabou de ser criado.");
      expect(prompt).toContain("## Seus ajustes");
      expect(prompt).not.toContain("A pessoa deixou você trocar de modelo");
      expect(prompt).toContain("## Terminal na VPS");
      expect(prompt).toContain(botHomePath(bot.id));
      expect(prompt).not.toContain("Neste modelo você não tem terminal");
      expect(lastRequest().code).toEqual({ cwd: botHomePath(bot.id) });
      expect(existsSync(botHomePath(bot.id))).toBe(true);
      await updateBot(bot.id, { engine: { autoSwitch: true } });
      await run(session);
      expect(lastRequest().systemPrompt).not.toContain("Você acabou de ser criado.");
      expect(lastRequest().systemPrompt).toContain("A pessoa deixou você trocar de modelo quando achar melhor");
    } finally {
      setKnownConnectors([]);
    }
  });

  test("adds recalled memories, the team log, a canvas edit and the voice note", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    quiet.recall.mockResolvedValue([{ slug: "metas", name: "Metas", description: "Metas do mês" }]);
    quiet.team.mockResolvedValue("## O que o time fez hoje\n- 10:00 Ana: fechou o relatório");
    track(spyOn(canvas, "canvasEditNote").mockResolvedValue("A pessoa editou o canvas X."));
    await run(session, { text: "como vão as metas?", voice: true });
    const request = lastRequest();
    expect(request.systemPrompt).toContain("Metas do mês (memória `metas`)");
    expect(request.systemPrompt).toContain("Ana: fechou o relatório");
    expect(request.systemPrompt).toContain("A pessoa editou o canvas X.");
    expect(request.systemPrompt).toContain("chamada de voz");
    expect((await factsOfType(session, "memory.recalled"))[0].data).toEqual({ slugs: ["metas"], titles: ["Metas"] });
    const reply = (await factsOfType(session, "content.completed")).find((fact) => fact.data.phase === "reply");
    expect(reply?.data.voice).toBe(true);
    expect((await factsOfType(session, "delivery.consumed"))[0].data.voice).toBe(true);
  });

  test("ignores failing canvas and blocks notes and skips recall when memory is off", async () => {
    const bot = await makeBot({ memory: { recall: false, capture: false } });
    const session = await newSession(bot.id);
    track(spyOn(canvas, "canvasEditNote").mockRejectedValue(new Error("sem canvas")));
    const blocks = track(spyOn(blockTools, "blocksEditNote").mockRejectedValue(new Error("sem blocos")));
    await run(session);
    expect(quiet.recall).not.toHaveBeenCalled();
    expect(quiet.capture).not.toHaveBeenCalled();
    expect(blocks).toHaveBeenCalledWith(bot.id);
    expect((await settledOf(session))?.outcome).toBe("completed");
  });
});

describe("the user prompt", () => {
  const skill = (slug: string, name: string) => ({ slug, name, body: `Passos de ${name}.`, files: [] });

  test("marks attached skill commands where they were typed and explains the skills", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    await run(session, { text: "/revisar   agora   /Revisar", skills: [skill("revisar", "Revisar")] });
    const prompt = lastRequest().prompt;
    expect(prompt).toContain("A pessoa anexou a skill “Revisar”");
    expect(prompt).toContain("Passos de Revisar.");
    expect(prompt.endsWith("[skill: Revisar] agora [skill: Revisar]")).toBe(true);
    expect((await factsOfType(session, "delivery.consumed"))[0].data.skills).toEqual([
      { slug: "revisar", name: "Revisar" },
    ]);
    await run(session, { text: "/revisar", skills: [skill("revisar", "Revisar")] });
    expect(lastRequest().prompt).toContain("Faça o que a skill anexada pede, nesta ordem: Revisar.");
    await run(session, { text: "", skills: [skill("a", "A"), skill("b", "B")] });
    expect(lastRequest().prompt).toContain("as skills anexadas pedem, nesta ordem: A, B.");
    expect(lastRequest().prompt).toContain("as skills “A” e “B”");
  });

  test("adds the delivery note when the person asks for commit, push or PR", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    await run(session, { text: "faz o commit" });
    expect(lastRequest().prompt).toContain("A pessoa pediu o commit nesta mensagem.");
    await run(session, { text: "dá push nisso" });
    expect(lastRequest().prompt).toContain("Ela pediu push, não PR");
    await run(session, { text: "abre o PR" });
    expect(lastRequest().prompt).toContain("A pessoa pediu commit, push e PR");
    expect(lastRequest().prompt).toContain("gh pr list --head");
    await run(session, { text: "só responde" });
    expect(lastRequest().prompt).toBe("só responde");
  });

  test("prepares attachments and titles the turn by them", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const prepare = track(
      spyOn(uploads, "prepareAttachments").mockResolvedValue({
        text: "Imagem anexada: foto.png",
        images: [{ path: "/tmp/foto.png", mime: "image/png", label: "foto.png" }],
      }),
    );
    const attachment: uploads.UploadMeta = {
      uploadId: "up_1",
      name: "foto.png",
      mime: "image/png",
      size: 10,
      kind: "image",
      file: "foto.png",
      createdAt: new Date().toISOString(),
      source: "user",
    };
    await run(session, { text: "", attachments: [attachment] });
    expect(prepare).toHaveBeenCalledWith(bot.id, [attachment], true);
    expect((await factsOfType(session, "attachments.preparing"))[0].data).toEqual({ count: 1 });
    expect(lastRequest().prompt.endsWith("\n\nImagem anexada: foto.png")).toBe(true);
    expect(lastRequest().prompt).not.toContain("\n\n\nImagem");
    expect(lastRequest().images).toEqual([{ path: "/tmp/foto.png", mime: "image/png", label: "foto.png" }]);
    expect(session.meta.title).toBe("📎 foto.png");
    await run(session, { text: "olha isso", attachments: [attachment] });
    expect(lastRequest().prompt.endsWith("olha isso\n\nImagem anexada: foto.png")).toBe(true);
    const consumed = (await factsOfType(session, "delivery.consumed")).at(-1)?.data.attachments as Array<{
      url: string;
    }>;
    expect(consumed[0].url).toBe(`/bots/${encodeURIComponent(bot.id)}/uploads/up_1`);
  });

  test("hands over the earlier context when the engine changed", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    track(spyOn(handoff, "handoffBlock").mockResolvedValue("Contexto anterior: falamos de metas."));
    session.meta.lastEngine = { account: "vps:codex", model: "gpt" };
    await run(session, { text: "continua" });
    expect((await factsOfType(session, "context.handoff"))[0].data).toMatchObject({
      from: "vps:codex",
      to: "vps:claude",
    });
    expect(lastRequest().prompt).toBe("Contexto anterior: falamos de metas.\n\n---\n\ncontinua");
  });

  test("drops the provider session when the context overflows and logs summary and capture failures", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const warn = track(spyOn(console, "warn").mockImplementation(() => undefined));
    quiet.summary.mockRejectedValue(new Error("resumo falhou"));
    quiet.capture.mockRejectedValue("memória falhou");
    fakeProviders.next(({ emit }) => {
      emit({ type: "session", id: "prov-big" });
      emit({ type: "text", part: "a", text: "feito" });
      emit({ type: "usage", usage: usageOf({ outputTokens: 1 }), contextTokens: 500_000 });
      emit({ type: "done", ok: true });
    });
    await run(session);
    expect(session.meta.providerSessions).toEqual({});
    expect(quiet.summary.mock.calls[0][4]).toBe(true);
    expect(warn).toHaveBeenCalledWith("summary failed", "resumo falhou");
    expect(warn).toHaveBeenCalledWith("memory capture failed", "memória falhou");
    quiet.summary.mockRejectedValue("cru");
    quiet.capture.mockRejectedValue(new Error("captura"));
    await run(session);
    expect(warn).toHaveBeenCalledWith("summary failed", "cru");
    expect(warn).toHaveBeenCalledWith("memory capture failed", "captura");
  });
});

describe("schedules", () => {
  test("carries the last summary, triages quiet runs and notes them for the next chat", async () => {
    const bot = await makeBot({
      schedules: [{ name: "diaria", cron: "0 9 * * *", prompt: "Resumo do dia." }],
    });
    const session = await newSession(bot.id, "thread");
    const triage = track(spyOn(decisions, "decideTriage").mockResolvedValue(decision("quiet")));
    fakeProviders.next(replyWith("Nada de novo hoje."));
    await run(session, { source: "schedule", scheduleId: "diaria", text: "Resumo do dia." });
    expect(triage).toHaveBeenCalledWith(bot.role, "diaria", "Resumo do dia.", "Nada de novo hoje.", null);
    expect(await settledOf(session)).toMatchObject({ outcome: "completed", quiet: true });
    expect((await factsOfType(session, "decision.made"))[0].data.outcome).toBe("quiet");
    expect((await factsOfType(session, "delivery.admitted")).at(-1)?.data.source).toEqual({
      channel: "channel:schedule",
      scheduleId: "diaria",
    });
    expect(session.meta.scheduleSummaries).toEqual({ diaria: "Nada de novo hoje." });
    expect(session.meta.pendingNotes?.[0]).toContain("- diaria (");
    expect(session.meta.providerSessions).toBeUndefined();

    triage.mockResolvedValue(decision("notify"));
    await run(session, { source: "schedule", scheduleId: "diaria", text: "Resumo do dia." });
    expect(lastRequest().prompt).toBe(
      "Resumo da última rodada desta rotina, para continuidade:\nNada de novo hoje.\n\n---\n\nResumo do dia.",
    );
    expect(lastRequest().resume).toBeNull();
    expect((await settledOf(session)).quiet).toBeUndefined();
    expect(triage).toHaveBeenLastCalledWith(
      bot.role,
      "diaria",
      "Resumo do dia.",
      "Nada de novo hoje.",
      "Nada de novo hoje.",
    );

    await run(session, { source: "schedule", text: "Rotina sem nome." });
    expect(triage).toHaveBeenLastCalledWith(bot.role, "rotina", "Rotina sem nome.", "Nada de novo hoje.", null);
    expect(session.meta.scheduleSummaries?.rotina).toBe("Nada de novo hoje.");

    await run(session, { text: "e aí?" });
    expect(lastRequest().prompt).toContain("Rotinas que rodaram desde a última mensagem:\n- diaria (");
    expect(session.meta.pendingNotes).toEqual([]);
  });

  test("keeps a schedule run silent when it has no reply", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id, "thread");
    const triage = track(spyOn(decisions, "decideTriage").mockResolvedValue(decision("notify")));
    fakeProviders.next(({ emit }) => emit({ type: "done", ok: true }));
    await run(session, { source: "schedule", scheduleId: "x", text: "Rodar." });
    expect(triage).not.toHaveBeenCalled();
    expect(session.meta.scheduleSummaries).toBeUndefined();
  });
});

describe("usage limits", () => {
  test("starts on the fallback while the account is limited and returns when it frees up", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    markLimited("vps:claude", "usage limit reached, resets in 2 hours");
    await run(session);
    expect(lastRequest().provider).toBe("codex");
    expect(lastRequest().effort).toBeNull();
    const failover = (await factsOfType(session, "account.failover"))[0].data;
    expect(failover).toMatchObject({
      from: "vps:claude",
      to: "vps:codex",
      line: "Limite do Claude acabou · continuei com Codex",
    });
    expect(typeof failover.until).toBe("string");
    expect(session.meta.failover).toMatchObject({ from: "vps:claude", to: "vps:codex" });
    await run(session);
    expect(await factsOfType(session, "account.failover")).toHaveLength(1);
    clearLimit("vps:claude");
    await run(session);
    expect(lastRequest().provider).toBe("claude");
    expect((await factsOfType(session, "account.restored"))[0].data).toMatchObject({
      account: "vps:claude",
      from: "vps:codex",
      line: "Voltei para o Claude",
    });
    expect(session.meta.failover).toBeUndefined();
  });

  test("stays on the limited account when the fallback is limited too", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    markLimited("vps:claude", "usage limit reached");
    markLimited("vps:codex", "usage limit reached");
    await run(session);
    expect(lastRequest().provider).toBe("claude");
    expect(await factsOfType(session, "account.failover")).toHaveLength(0);
    expect((await settledOf(session))?.outcome).toBe("completed");
  });

  test("goes to the other Claude first and keeps the model and effort", async () => {
    const bot = await makeBot();
    bot.engine = { account: "vps:claude", model: "m", effort: "high", fallback: { account: "vps:codex", model: "g" } };
    const session = await newSession(bot.id);
    withSecondClaude();
    markLimited("vps:claude", "usage limit reached");
    await run(session);
    const failover = (await factsOfType(session, "account.failover"))[0].data;
    expect(failover).toMatchObject({ from: "vps:claude", to: "claude-2:claude", toModel: "m" });
    expect(failover.line).toBe("Limite do Claude acabou · continuei com Claude Anderson");
    expect(failover.until).toBeNull();
    expect(lastRequest()).toMatchObject({ provider: "claude", model: "m", effort: "high" });
    expect((await settledOf(session))?.outcome).toBe("completed");
  });

  test("walks the chain Claude, other Claude, Codex when both Claudes hit the limit", async () => {
    const bot = await makeBot();
    bot.engine = { account: "vps:claude", model: "m", effort: null, fallback: { account: "vps:codex", model: "g" } };
    const session = await newSession(bot.id);
    withSecondClaude();
    fakeProviders.next(
      sequence(
        ({ emit }) => emit({ type: "done", ok: false, message: "usage limit reached" }),
        ({ emit }) => emit({ type: "done", ok: false, message: "usage limit reached" }),
        replyWith("Fechei no Codex."),
      ),
    );
    await run(session, { text: "faz" });
    expect(fakeProviders.turns.map((turn) => turn.request.provider)).toEqual(["claude", "claude", "codex"]);
    const hops = (await factsOfType(session, "account.failover")).map((fact) => [fact.data.from, fact.data.to]);
    expect(hops).toEqual([
      ["vps:claude", "claude-2:claude"],
      ["claude-2:claude", "vps:codex"],
    ]);
    expect(await repliesOf(session)).toEqual(["Fechei no Codex."]);
  });

  test("moves to the other Claude when the account goes down mid-turn", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    withSecondClaude();
    const carry = track(spyOn(handoff, "handoffBlock"));
    fakeProviders.next(
      sequence(
        ({ emit }) => emit({ type: "done", ok: false, message: "API Error: 401 authentication_error" }),
        replyWith("Segui na outra conta."),
      ),
    );
    await run(session, { text: "faz" });
    const failover = (await factsOfType(session, "account.failover"))[0].data;
    expect(failover.line).toBe("Claude fora do ar · continuei com Claude Anderson");
    expect(failover.reason).toBe("Claude fora do ar");
    expect(carry.mock.calls.at(-1)?.[1].reason).toContain("o Claude caiu");
    expect(await repliesOf(session)).toEqual(["Segui na outra conta."]);
    expect(limitOf("vps:claude")?.kind).toBe("down");
  });

  test("starts on the other Claude when the main one is logged out", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    withSecondClaude();
    const real = accounts.findAccount;
    track(
      spyOn(accounts, "findAccount").mockImplementation(async (id: string) => {
        const found = await real(id);
        return found && id === "vps:claude" ? { ...found, status: "logged_out", detail: "saiu" } : found;
      }),
    );
    await run(session);
    const failover = (await factsOfType(session, "account.failover"))[0].data;
    expect(failover).toMatchObject({ from: "vps:claude", to: "claude-2:claude" });
    expect(failover.line).toBe("Claude fora do ar · continuei com Claude Anderson");
    expect((await settledOf(session))?.outcome).toBe("completed");
  });

  test("fails over from a missing account to the reserve", async () => {
    const bot = await makeBot();
    bot.engine = { account: "vps:nada", model: "x", effort: "low", fallback: { account: "vps:codex", model: "g" } };
    const session = await newSession(bot.id);
    await run(session);
    expect((await factsOfType(session, "account.failover"))[0].data.line).toBe(
      "vps:nada fora do ar · continuei com Codex",
    );
    expect(lastRequest()).toMatchObject({ provider: "codex", model: "g", effort: null });
  });

  test("retries on the fallback when the limit hits mid-turn", async () => {
    const bot = await makeBot();
    const session = await newSession(bot.id);
    const carry = track(spyOn(handoff, "handoffBlock"));
    fakeProviders.next(
      sequence(
        ({ emit }) => emit({ type: "done", ok: false, message: "Claude usage limit reached|1999999999" }),
        replyWith("Segui no Codex."),
      ),
    );
    await run(session, { text: "faz o relatório" });
    expect(fakeProviders.turns.map((turn) => turn.request.provider)).toEqual(["claude", "codex"]);
    expect(fakeProviders.turns[1].request.prompt).toContain("faz o relatório");
    expect(carry.mock.calls.at(-1)?.[1].reason).toContain("o limite do Claude acabou");
    expect(await repliesOf(session)).toEqual(["Segui no Codex."]);
    expect((await factsOfType(session, "account.failover"))[0].data.until).toBe(
      new Date(1999999999 * 1000).toISOString(),
    );
  });

  test("offers the suggested account when there is no fallback", async () => {
    const bot = await makeBot();
    bot.engine = { account: "vps:claude", model: "m", effort: null, fallback: null };
    const session = await newSession(bot.id);
    fakeProviders.next(({ emit }) => {
      emit({ type: "text", part: "a", text: "You've hit your usage limit · resets 3pm" });
      emit({ type: "done", ok: true });
    });
    await run(session);
    const error = (await settledOf(session))?.error;
    expect(error).toMatchObject({ code: "ACCOUNT_LIMIT", suggest: { account: "vps:codex", label: "Codex" } });
    expect(error?.message).toContain("O limite do Claude acabou, volta");
    expect(error?.message).toContain("Quer que eu continue com o Codex?");
    expect(await repliesOf(session)).toEqual([]);
  });

  test("offers nothing when the only fallback is the limited account", async () => {
    const bot = await makeBot();
    bot.engine = { account: "vps:claude", model: "m", effort: null, fallback: { account: "vps:claude", model: "m" } };
    const session = await newSession(bot.id);
    fakeProviders.next(({ emit }) => emit({ type: "done", ok: false, message: "429 too many requests" }));
    await run(session);
    const error = (await settledOf(session))?.error;
    expect(error?.code).toBe("ACCOUNT_LIMIT");
    expect(error?.suggest).toBeUndefined();
    expect(error?.until).toBeNull();
    expect(error?.message).toBe("O limite do Claude acabou.");
  });

  test("does not offer a suggestion that is limited too", async () => {
    const bot = await makeBot();
    bot.engine = { account: "vps:claude", model: "m", effort: null, fallback: null };
    const session = await newSession(bot.id);
    markLimited("vps:codex", "quota");
    fakeProviders.next(({ emit }) => emit({ type: "done", ok: false, message: "quota exceeded" }));
    await run(session);
    expect((await settledOf(session))?.error?.suggest).toBeUndefined();
  });
});

describe("the Mac computer", () => {
  test("stops the turn when the person presses stop or takes over", async () => {
    const bot = await makeBot();
    bot.capabilities = { ...bot.capabilities, computer: true };
    const session = await newSession(bot.id);
    let handler: (event: { type: string; botId?: string }) => void = () => undefined;
    let unwatched = 0;
    track(
      spyOn(computer, "watchComputerEvents").mockImplementation((next) => {
        handler = next;
        return () => {
          unwatched++;
        };
      }),
    );
    const held = hold();
    fakeProviders.next(held.script);
    send(session);
    await held.started;
    handler({ type: "stop", botId: "outro-bot" });
    expect(isRunning(session.meta.sessionId)).toBe(true);
    handler({ type: "stop", botId: bot.id });
    handler({ type: "stop" });
    await idle(session);
    expect(await settledOf(session)).toMatchObject({ outcome: "cancelled", reason: "A pessoa apertou Parar." });
    expect(unwatched).toBe(1);

    const again = hold();
    fakeProviders.next(again.script);
    send(session);
    await again.started;
    handler({ type: "user_took_over" });
    await idle(session);
    expect((await settledOf(session))?.reason).toBe("Você assumiu o computador.");
  });
});
