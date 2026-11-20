import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type Query,
  query,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { childEnv } from "@runelay-bots/providers/proc";
import { spawnMarked } from "@runelay-bots/providers/proc-tree";
import { dataDir } from "../../../config/env";
import { type BotDefinition, voiceOf } from "../../bots/services/bots.service";
import type { Fact, StoredSession } from "../../conversations/services/sessions.service";
import { getStoredSession } from "../../conversations/services/sessions.service";
import { ensureThread } from "../../conversations/services/threads.service";
import { answerQuestion, deliver } from "../../engine/services/engine.service";
import { integrationSecret, onIntegrationChange } from "../../integrations/services/integration-store.service";
import { trustedServiceUrl } from "../../integrations/services/integrations.service";
import {
  isSpokenSkip,
  matchSpokenOption,
  otherOptionId,
  type Question,
  spokenQuestion,
} from "../../questions/services/questions.service";

function apiBase() {
  return trustedServiceUrl(process.env.ELEVENLABS_API_URL, "https://api.elevenlabs.io");
}

export const tokenLimit = { perMinute: 30, concurrent: 4 };
const mintWindows = new Map<string, number[]>();
const mintsInFlight = new Map<string, number>();

function reserveMint(who: string, count: number) {
  const now = Date.now();
  const recent = (mintWindows.get(who) ?? []).filter((at) => at > now - 60_000);
  const running = mintsInFlight.get(who) ?? 0;
  if (recent.length + count > tokenLimit.perMinute || running + 1 > tokenLimit.concurrent) {
    mintWindows.set(who, recent);
    throw new VoiceError("Muitos pedidos de token de voz agora. Espere um minuto e tente de novo.", 429);
  }
  mintWindows.set(who, [...recent, ...Array(count).fill(now)]);
  mintsInFlight.set(who, running + 1);
  return () => {
    const left = (mintsInFlight.get(who) ?? 1) - 1;
    if (left > 0) mintsInFlight.set(who, left);
    else mintsInFlight.delete(who);
  };
}

export function resetTokenLimits() {
  mintWindows.clear();
  mintsInFlight.clear();
}
const wsBase = "wss://api.elevenlabs.io";
export const fastModel = process.env.VOICE_FAST_MODEL ?? "claude-haiku-5-5";
const sttModel = process.env.VOICE_STT_MODEL ?? "scribe_v2_realtime";
const ttsModel = process.env.VOICE_TTS_MODEL ?? "eleven_flash_v2_5";
const sttSampleRate = 16_000;
const ttsSampleRate = 24_000;
const vadSilence = Number(process.env.VOICE_VAD_SILENCE ?? 0.9);
const vadThreshold = Number(process.env.VOICE_VAD_THRESHOLD ?? 0.6);
const minSpeechMs = Number(process.env.VOICE_MIN_SPEECH_MS ?? 250);
const fillerGapMs = 6_000;
const maxFillersPerTurn = 3;
const idleCallMs = 90_000;
const hangupFallbackMs = 8_000;

export class VoiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function apiKey() {
  const key = integrationSecret("elevenlabs");
  if (!key) throw new VoiceError("Conecte o ElevenLabs em Configurações › Integrações para usar a voz.", 503);
  return key;
}

export function voiceEnabled() {
  return Boolean(integrationSecret("elevenlabs"));
}

export async function mintToken(type: "realtime_scribe" | "tts_websocket") {
  const response = await fetch(`${apiBase()}/v1/single-use-token/${type}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey() },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new VoiceError(`ElevenLabs recusou o token (${response.status}).`, 502);
  const body = (await response.json()) as { token?: string };
  if (!body.token) throw new VoiceError("ElevenLabs não devolveu o token.", 502);
  return body.token;
}

export interface VoiceOption {
  voiceId: string;
  name: string;
  category: string;
  language: string | null;
  accent: string | null;
  gender: string | null;
  description: string | null;
  previewUrl: string | null;
}

let voicesCache: { at: number; items: VoiceOption[] } | null = null;
onIntegrationChange((id) => {
  if (id === "elevenlabs") voicesCache = null;
});

export async function listVoices(refresh = false) {
  if (!refresh && voicesCache && Date.now() - voicesCache.at < 10 * 60_000) return voicesCache.items;
  const items: VoiceOption[] = [];
  let token: string | null = null;
  for (let page = 0; page < 5; page++) {
    const url = new URL(`${apiBase()}/v2/voices`);
    url.searchParams.set("page_size", "100");
    if (token) url.searchParams.set("next_page_token", token);
    const response = await fetch(url, { headers: { "xi-api-key": apiKey() }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new VoiceError(`ElevenLabs não listou as vozes (${response.status}).`, 502);
    const body = (await response.json()) as {
      voices?: Array<{
        voice_id: string;
        name?: string;
        category?: string;
        description?: string | null;
        preview_url?: string | null;
        labels?: Record<string, string>;
      }>;
      has_more?: boolean;
      next_page_token?: string | null;
    };
    for (const voice of body.voices ?? []) {
      const labels = voice.labels ?? {};
      items.push({
        voiceId: voice.voice_id,
        name: voice.name ?? voice.voice_id,
        category: voice.category ?? "",
        language: labels.language ?? null,
        accent: labels.accent ?? null,
        gender: labels.gender ?? null,
        description: labels.descriptive ?? voice.description ?? null,
        previewUrl: voice.preview_url ?? null,
      });
    }
    if (!body.has_more || !body.next_page_token) break;
    token = body.next_page_token;
  }
  const rank = (voice: VoiceOption) => (voice.language === "pt" ? 0 : 1);
  items.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "pt-BR"));
  voicesCache = { at: Date.now(), items };
  return items;
}

function sttUrl(token: string, language: string) {
  const url = new URL(`${wsBase}/v1/speech-to-text/realtime`);
  url.searchParams.set("model_id", sttModel);
  url.searchParams.set("language_code", language);
  url.searchParams.set("audio_format", `pcm_${sttSampleRate}`);
  url.searchParams.set("commit_strategy", "vad");
  url.searchParams.set("vad_silence_threshold_secs", String(vadSilence));
  url.searchParams.set("vad_threshold", String(vadThreshold));
  url.searchParams.set("min_speech_duration_ms", String(minSpeechMs));
  url.searchParams.set("token", token);
  return url.toString();
}

function ttsUrl(voiceId: string, token: string, language: string) {
  const url = new URL(`${wsBase}/v1/text-to-speech/${encodeURIComponent(voiceId)}/multi-stream-input`);
  url.searchParams.set("model_id", ttsModel);
  url.searchParams.set("output_format", `pcm_${ttsSampleRate}`);
  url.searchParams.set("language_code", language);
  url.searchParams.set("inactivity_timeout", "180");
  url.searchParams.set("single_use_token", token);
  return url.toString();
}

class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter: ((item: SDKUserMessage | null) => void) | null = null;
  private closed = false;

  push(text: string) {
    const item: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    };
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  close() {
    this.closed = true;
    this.waiter?.(null);
    this.waiter = null;
  }

  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      const item =
        this.items.shift() ?? (await new Promise<SDKUserMessage | null>((resolve) => (this.waiter = resolve)));
      if (!item) return;
      yield item;
    }
  }
}

interface Job {
  id: string;
  prompt: string;
  speak: boolean;
  text: string;
  cancelled: boolean;
  onDelta: (text: string) => void;
  resolve: (text: string | null) => void;
}

const noop = () => undefined;

const maxWarmLayers = Math.max(1, Number(process.env.VOICE_MAX_WARM ?? 3));
const warmIdleMs = Number(process.env.VOICE_WARM_IDLE_MS ?? 5 * 60_000);
const warmLayers = new Set<FastLayer>();

class FastLayer {
  private inbox = new Inbox();
  private stream: Query | null = null;
  private current: Job | null = null;
  private jobs: Job[] = [];
  private closed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  lastUsed = Date.now();

  constructor(
    private systemPrompt: string,
    private workDir: string,
  ) {}

  private open() {
    if (this.stream || this.closed) return;
    for (const other of [...warmLayers].sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (warmLayers.size < maxWarmLayers) break;
      if (!other.busy) other.evict();
    }
    this.inbox = new Inbox();
    const stream = query({
      prompt: this.inbox,
      options: {
        model: fastModel,
        systemPrompt: this.systemPrompt,
        tools: [],
        allowedTools: [],
        mcpServers: {},
        permissionMode: "dontAsk",
        settingSources: [],
        strictMcpConfig: true,
        settings: { disableClaudeAiConnectors: true },
        includePartialMessages: true,
        cwd: this.workDir,
        env: childEnv({ CLAUDE_AGENT_SDK_CLIENT_APP: "runelay-bots-voice/1.0.0" }),
        ...(Bun.env.CLAUDE_CODE_EXECUTABLE ? { pathToClaudeCodeExecutable: Bun.env.CLAUDE_CODE_EXECUTABLE } : {}),
        ...(process.platform === "linux"
          ? {
              spawnClaudeCodeProcess: (options: SpawnOptions) =>
                spawnMarked(options.command, options.args, {
                  cwd: options.cwd,
                  env: options.env,
                  marker: `voice-${randomUUID().slice(0, 8)}`,
                  nice: 0,
                  signal: options.signal,
                }) as unknown as SpawnedProcess,
            }
          : {}),
      },
    });
    this.stream = stream;
    warmLayers.add(this);
    void this.read(stream);
  }

  private touch() {
    this.lastUsed = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.busy) this.evict();
    }, warmIdleMs);
    this.idleTimer.unref();
  }

  evict() {
    const stream = this.stream;
    if (!stream) return;
    this.stream = null;
    warmLayers.delete(this);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.inbox.close();
    try {
      stream.close();
    } catch {}
  }

  ask(prompt: string, speak: boolean, onDelta: (text: string) => void = noop) {
    const { promise: done, resolve } = Promise.withResolvers<string | null>();
    const job: Job = { id: randomUUID(), prompt, speak, text: "", cancelled: false, onDelta, resolve };
    if (this.closed) job.resolve(null);
    else {
      this.open();
      this.touch();
      this.jobs.push(job);
      this.next();
    }
    return { job, done };
  }

  get busy() {
    return this.current !== null || this.jobs.length > 0;
  }

  cancelAll() {
    for (const job of this.jobs.splice(0)) {
      job.cancelled = true;
      job.resolve(null);
    }
    if (this.current && !this.current.cancelled) {
      this.current.cancelled = true;
      this.current.resolve(null);
      void this.stream?.interrupt().catch(() => undefined);
    }
  }

  close() {
    this.cancelAll();
    this.closed = true;
    this.evict();
  }

  private next() {
    if (this.current || this.closed) return;
    const job = this.jobs.shift();
    if (!job) return;
    this.current = job;
    this.inbox.push(job.prompt);
  }

  private finish() {
    const job = this.current;
    this.current = null;
    if (job && !job.cancelled) job.resolve(job.text.trim());
    this.touch();
    this.next();
  }

  private async read(stream: Query) {
    try {
      for await (const message of stream) {
        if (message.type === "stream_event") {
          const event = message.event as { type: string; delta?: { type: string; text?: string } };
          if (
            event.type === "content_block_delta" &&
            event.delta?.type === "text_delta" &&
            this.current &&
            !this.current.cancelled
          ) {
            const text = event.delta.text ?? "";
            this.current.text += text;
            this.current.onDelta(text);
          }
        } else if (message.type === "result") {
          const failed = message as { is_error?: boolean; result?: string };
          if (failed.is_error && this.current && !this.current.cancelled) {
            console.warn(`voice fast layer error: ${String(failed.result ?? message.subtype).slice(0, 200)}`);
            this.current.text = "";
            this.current.cancelled = true;
            this.current.resolve(null);
          }
          this.finish();
        }
      }
    } catch (error) {
      if (!this.closed && this.stream === stream)
        console.warn("voice fast layer stopped", error instanceof Error ? error.message : error);
    }
    if (this.stream !== stream && this.stream !== null) return;
    if (this.stream === stream) {
      this.stream = null;
      warmLayers.delete(this);
    }
    this.current?.resolve(null);
    this.current = null;
    for (const job of this.jobs.splice(0)) job.resolve(null);
  }
}

export function warmVoiceLayers() {
  return warmLayers.size;
}

function fastPrompt(bot: BotDefinition) {
  return [
    `Você é a voz de ${bot.name} (${bot.role || "bot do time"}) numa chamada de voz com a pessoa, em português do Brasil.`,
    `Quem faz o trabalho de verdade é ${bot.name}, com ferramentas, memória e aprovações. Você só fala: confirma o que entendeu, preenche a espera e resume o resultado.`,
    "Cada mensagem começa com uma etiqueta:",
    '- PESSOA: a pessoa acabou de falar. Responda em uma frase curta confirmando o que entendeu e que vai ver ("Beleza, vou olhar seus e-mails do banco."). Nunca responda a pergunta você mesmo, nem diga o que o bot sabe ou consegue fazer: quem responde é o bot, e você resume depois. Se for só cumprimento, agradecimento ou despedida, responda exatamente (silêncio): o bot responde.',
    '- FERRAMENTA: o bot começou a usar uma ferramenta. Diga algo bem curto sobre a espera ("Tô abrindo o Gmail…"), ou responda exatamente (silêncio) se não acrescentar nada.',
    "- RESULTADO: a resposta escrita do bot. Resuma em no máximo duas frases curtas, faladas, sem markdown, sem links, sem listas, números por extenso quando curtos. Se você já disse tudo, responda (silêncio).",
    "- ERRO: o turno falhou. Diga em uma frase o que houve.",
    '- APROVACAO: o bot precisa de permissão. Pergunte em uma frase o que ele quer fazer e termine com "Posso?".',
    "- CLASSIFIQUE: diga só APROVAR, NEGAR ou OUTRO para a fala da pessoa sobre a pergunta de permissão. Nada mais.",
    voiceOf(bot).language === "pt"
      ? ""
      : `Fale sempre em ${voiceOf(bot).language === "en" ? "inglês" : "espanhol"}, mesmo que as instruções estejam em português.`,
    "Fale como gente, no máximo 25 palavras, sem emoji, sem aspas, sem markdown. Nunca diga que é uma IA nem fale das etiquetas.",
  ]
    .filter(Boolean)
    .join("\n");
}

export type CallEvent = Record<string, unknown> & { type: string };

interface PendingApproval {
  interactionId: string;
  prompt: string;
  questions?: Question[];
  answers?: Array<{ questionId: string; optionIds?: string[]; text?: string; skipped?: boolean }>;
}

export interface VoiceCall {
  id: string;
  botId: string;
  session: StoredSession;
  fast: FastLayer;
  listeners: Set<(event: CallEvent) => void>;
  pending: PendingApproval | null;
  speaking: string | null;
  lastSpeechAt: number;
  fillers: Map<string, number>;
  replies: Map<string, string[]>;
  turnStarts: Map<string, number>;
  lastUtteranceAt: number;
  idleTimer: NodeJS.Timeout | null;
  unsubscribe: () => void;
  ended: boolean;
  startedAt: number;
  spoken: number;
  lastAck: { partId: string; text: string; at: number } | null;
  language: string;
  hangup: { speechId: string; timer: NodeJS.Timeout } | null;
}

const calls = new Map<string, VoiceCall>();

function emit(call: VoiceCall, event: CallEvent) {
  for (const listener of call.listeners) listener(event);
}

function stripSpeech(text: string) {
  return text
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function speak(call: VoiceCall, kind: string, prompt: string, startedAt = Date.now()) {
  const id = `speech_${randomUUID().slice(0, 8)}`;
  let held = "";
  let released = false;
  let silent = false;
  let started = false;
  const begin = () => {
    if (started) return;
    started = true;
    call.speaking = id;
    emit(call, { type: "speech.started", id, kind, elapsedMs: Date.now() - startedAt });
    if (kind === "ack") console.log(`voice ${call.botId} ack first text ${Date.now() - startedAt}ms`);
  };
  const release = (force: boolean) => {
    if (released || silent) return;
    const probe = held.trimStart();
    if (probe.startsWith("(")) {
      if (!probe.includes(")") && !force) return;
      if (probe.toLowerCase().startsWith("(sil")) {
        silent = true;
        return;
      }
    } else if (!force && probe.length < 4) {
      return;
    }
    released = true;
    begin();
    const text = held.replace(/[*_`#>]/g, "");
    if (text.trim()) emit(call, { type: "speech.delta", id, text });
  };
  const { done } = call.fast.ask(
    `${kind === "ack" ? "PESSOA" : kind === "filler" ? "FERRAMENTA" : kind === "result" ? "RESULTADO" : kind === "error" ? "ERRO" : "APROVACAO"}: ${prompt}`,
    true,
    (delta) => {
      if (released) {
        const text = delta.replace(/[*_`#>]/g, "");
        if (text) emit(call, { type: "speech.delta", id, text });
        return;
      }
      held += delta;
      release(false);
    },
  );
  void done.then((text) => {
    if (text === null) {
      if (started) emit(call, { type: "speech.cancelled", id });
      if (call.speaking === id) call.speaking = null;
      return;
    }
    release(true);
    const spoken = stripSpeech(text);
    if (silent || !spoken || spoken.toLowerCase().startsWith("(sil")) {
      if (started) emit(call, { type: "speech.cancelled", id });
    } else {
      begin();
      emit(call, { type: "speech.done", id, text: spoken });
      call.lastSpeechAt = Date.now();
      if (kind !== "result") {
        const partId = recordSpoken(call, id, spoken);
        if (kind === "ack") call.lastAck = { partId, text: spoken, at: Date.now() };
      }
    }
    if (call.speaking === id) call.speaking = null;
  });
  return id;
}

function sayReply(call: VoiceCall, text: string) {
  const id = `speech_${randomUUID().slice(0, 8)}`;
  emit(call, { type: "speech.started", id, kind: "result", elapsedMs: 0 });
  emit(call, { type: "speech.delta", id, text });
  emit(call, { type: "speech.done", id, text });
  call.lastSpeechAt = Date.now();
  return id;
}

export function speakableReply(reply: string) {
  if (reply.length > 600 || /```|^\s*\|.*\|/m.test(reply) || /^\s*#/m.test(reply)) return null;
  const listLines = reply.split("\n").filter((line) => /^\s*([-*•]|\d+[.)])\s+/.test(line)).length;
  if (listLines > 2) return null;
  const spoken = reply
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*([-*•]|\d+[.)])\s+/gm, "")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return spoken && spoken.length <= 350 ? spoken : null;
}

function contentWords(text: string) {
  return normalized(text)
    .split(" ")
    .filter((word) => word.length >= 4);
}

export function repeatsReply(ack: string, reply: string) {
  const ackWords = contentWords(ack);
  if (ackWords.length < 4) return false;
  const replyWords = new Set(contentWords(reply));
  const shared = ackWords.filter((word) => replyWords.has(word)).length;
  return shared / ackWords.length >= 0.5;
}

function retractAck(call: VoiceCall) {
  const ack = call.lastAck;
  if (!ack) return;
  call.lastAck = null;
  const runId = `voice_${call.id}`;
  call.session.log.emit({
    type: "content.completed",
    data: {
      kind: "text",
      partId: ack.partId,
      phase: "reply",
      runId,
      value: "",
      voice: true,
      spoken: true,
      botId: call.botId,
      retracted: true,
    },
    scope: { runId },
  });
}

function sayFixed(call: VoiceCall, kind: string, text: string) {
  const id = `speech_${randomUUID().slice(0, 8)}`;
  emit(call, { type: "speech.started", id, kind, elapsedMs: 0 });
  emit(call, { type: "speech.delta", id, text });
  emit(call, { type: "speech.done", id, text });
  call.lastSpeechAt = Date.now();
  recordSpoken(call, id, text);
  return id;
}

function recordSpoken(call: VoiceCall, id: string, text: string) {
  call.spoken++;
  const runId = `voice_${call.id}`;
  const partId = `${runId}.${id}`;
  call.session.log.emit({
    type: "content.completed",
    data: { kind: "text", partId, phase: "reply", runId, value: text, voice: true, spoken: true, botId: call.botId },
    scope: { runId },
  });
  return partId;
}

function onFacts(call: VoiceCall, facts: Fact[]) {
  if (call.hangup) return;
  for (const fact of facts) {
    const turnId = fact.scope?.turnId ?? String(fact.data.turnId ?? "");
    if (fact.type === "turn.started") {
      call.turnStarts.set(turnId, Date.now());
      emit(call, { type: "bot.state", state: "working", turnId });
    } else if (fact.type === "call.requested") {
      const label = String((fact.data.capability as { label?: string } | undefined)?.label ?? "");
      emit(call, { type: "bot.tool", label, turnId });
      const used = call.fillers.get(turnId) ?? 0;
      if (
        !label ||
        call.pending ||
        call.fast.busy ||
        used >= maxFillersPerTurn ||
        Date.now() - call.lastSpeechAt < fillerGapMs
      )
        continue;
      call.fillers.set(turnId, used + 1);
      call.lastSpeechAt = Date.now();
      speak(call, "filler", label);
    } else if (fact.type === "content.completed" && fact.data.phase === "reply") {
      const list = call.replies.get(turnId) ?? [];
      list.push(String(fact.data.value ?? ""));
      call.replies.set(turnId, list);
    } else if (fact.type === "interaction.opened") {
      const request = fact.data.request as { prompt?: string; kind?: string; questions?: Question[] } | undefined;
      const interactionId = String(fact.data.interactionId ?? "");
      if (request?.kind === "question" && request.questions?.length) {
        call.pending = {
          interactionId,
          prompt: String(request.prompt ?? ""),
          questions: request.questions,
          answers: [],
        };
        emit(call, { type: "question.asked", interactionId, questions: request.questions });
        emit(call, { type: "bot.state", state: "awaiting", turnId });
        call.fast.cancelAll();
        sayFixed(call, "question", spokenQuestion(request.questions[0], 0, request.questions.length));
        continue;
      }
      call.pending = { interactionId, prompt: String(request?.prompt ?? "") };
      emit(call, { type: "approval.asked", interactionId, prompt: call.pending.prompt });
      emit(call, { type: "bot.state", state: "awaiting", turnId });
      call.fast.cancelAll();
      speak(call, "approval", call.pending.prompt);
    } else if (fact.type === "interaction.settled") {
      if (call.pending?.interactionId === fact.data.interactionId) call.pending = null;
      emit(call, { type: "approval.settled", interactionId: fact.data.interactionId, outcome: fact.data.outcome });
    } else if (fact.type === "turn.settled") {
      const outcome = String(fact.data.outcome ?? "");
      emit(call, { type: "bot.state", state: "idle", turnId, outcome });
      const reply = (call.replies.get(turnId) ?? []).join("\n").trim();
      call.replies.delete(turnId);
      call.fillers.delete(turnId);
      const startedAt = call.turnStarts.get(turnId) ?? 0;
      const superseded = call.lastUtteranceAt > startedAt && call.pending === null;
      call.turnStarts.delete(turnId);
      if (reply && call.lastAck && call.lastAck.at >= startedAt - 5_000 && repeatsReply(call.lastAck.text, reply)) {
        console.log(`voice ${call.botId} ack repeated the reply, removed from the thread`);
        retractAck(call);
      }
      if (superseded) continue;
      const direct = outcome === "completed" && reply ? speakableReply(reply) : null;
      if (direct) {
        call.fast.cancelAll();
        sayReply(call, direct);
      } else if (outcome === "completed" && reply) speak(call, "result", reply.slice(0, 4_000));
      else if (outcome === "failed") {
        const error = fact.data.error as { message?: string } | undefined;
        speak(call, "error", String(error?.message ?? "falhou sem detalhe").slice(0, 500));
      }
    }
  }
}

const yes =
  /^(sim|pode|pode sim|pode ir|pode fazer|pode seguir|claro|manda|manda ver|vai|vai la|ok|okay|beleza|isso|autorizo|aprovo|aprovado|confirmo|confirmado|segue|siga|faz|fa[cç]a|com certeza|positivo|bora|uhum|aham)\b/;
const no =
  /^(n[aã]o|nao|negativo|nega|para|pare|cancela|cancelar|nem pensar|melhor n[aã]o|deixa|esquece|n[aã]o pode)\b/;

function normalized(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const courtesy =
  /^(ok|okay|beleza|blz|certo|show|perfeito|otimo|tchau|tchau tchau|ate mais|ate logo|ate amanha|valeu|obrigad[oa]|muito obrigad[oa]|brigad[oa]|obrigad[oa] viu|bom dia|boa tarde|boa noite|oi|ola|e ai|tudo bem|tudo certo|de nada|por nada)( (ok|beleza|tchau|valeu|obrigad[oa]|entao|viu|mesmo|ai|pela ajuda|por tudo))*$/;
const hangupClause =
  /^((ok|okay|beleza|entao|bom|e|ja|agora|tchau|obrigad[oa]|valeu|pode|podemos|voce pode|pode ja|ja pode|pode ir|vou|vamos|por favor|pode sim)\s+)*(desliga|desligar|desligue|encerra|encerrar|encerre|finaliza|finalizar|finalize)( (a|essa|esta|nossa) (chamada|ligacao)| a chamada| a ligacao)?( (ai|agora|ja|entao|por favor|ok|obrigad[oa]|valeu|tchau|ta|beleza))*$/;
const hangupBlock = /\b(nao|espera|perai|ainda|antes)\b/;

export function isCourtesy(text: string) {
  const value = normalized(text);
  return value.length > 0 && value.split(" ").length <= 8 && courtesy.test(value);
}

export function wantsHangup(text: string) {
  const clauses = text
    .split(/[.,!?;:\n]+/)
    .map(normalized)
    .filter(Boolean);
  while (clauses.length > 0 && courtesy.test(clauses.at(-1) ?? "")) clauses.pop();
  const last = clauses.pop();
  if (!last || !hangupClause.test(last) || hangupBlock.test(last)) return false;
  const before = clauses.at(-1);
  return !before || !hangupBlock.test(before);
}

const farewells: Record<string, string> = {
  pt: "Combinado, até mais.",
  en: "Alright, talk soon.",
  es: "Listo, hasta luego.",
};

function hangUp(call: VoiceCall) {
  if (call.hangup) return { action: "hangup" as const, speechId: call.hangup.speechId };
  call.fast.cancelAll();
  const speechId = sayFixed(call, "goodbye", farewells[call.language] ?? farewells.pt);
  const timer = setTimeout(() => endCall(call), hangupFallbackMs);
  timer.unref();
  call.hangup = { speechId, timer };
  emit(call, { type: "call.hangup", speechId });
  console.log(`voice ${call.botId} hangup asked by voice`);
  return { action: "hangup" as const, speechId };
}

export function classifyAnswer(text: string): "approve" | "deny" | null {
  const value = normalized(text);
  if (no.test(value)) return "deny";
  if (yes.test(value)) return "approve";
  return null;
}

export async function onUtterance(call: VoiceCall, text: string, interrupted = false) {
  const startedAt = Date.now();
  if (call.hangup || (!call.ended && wantsHangup(text))) return hangUp(call);
  if (call.pending?.questions) return answerSpokenQuestion(call, text);
  if (call.pending) {
    call.fast.cancelAll();
    const pending = call.pending;
    let choice = classifyAnswer(text);
    if (!choice) {
      const { done } = call.fast.ask(`CLASSIFIQUE: pergunta "${pending.prompt}". A pessoa disse: "${text}"`, false);
      const verdict = ((await done) ?? "").toUpperCase();
      choice = verdict.includes("NEGAR") ? "deny" : verdict.includes("APROVAR") ? "approve" : null;
    }
    if (!choice) {
      sayFixed(call, "approval", "Não entendi. Posso seguir? Fala sim ou não.");
      return { action: "repeat" as const, interactionId: pending.interactionId };
    }
    sayFixed(call, "approval", choice === "approve" ? "Beleza, seguindo." : "Tá bom, não vou fazer.");
    return { action: "answer" as const, interactionId: pending.interactionId, optionId: choice };
  }
  const deliveryId = randomUUID();
  const continuation = call.turnStarts.size > 0 && !interrupted;
  if (continuation) {
    deliver(call.session, { deliveryId, text, source: "chat", voice: true });
    console.log(`voice ${call.botId} continuation while turn runs`);
    return { action: "message" as const, deliveryId, sessionId: call.session.meta.sessionId, continuation: true };
  }
  call.fast.cancelAll();
  call.lastUtteranceAt = Date.now();
  deliver(call.session, { deliveryId, text, source: "chat", voice: true });
  if (isCourtesy(text)) call.lastAck = null;
  else speak(call, "ack", text, startedAt);
  return { action: "message" as const, deliveryId, sessionId: call.session.meta.sessionId, continuation: false };
}

function answerSpokenQuestion(call: VoiceCall, text: string) {
  call.fast.cancelAll();
  const pending = call.pending as PendingApproval & { questions: Question[] };
  const answers = pending.answers ?? [];
  const question = pending.questions[answers.length];
  if (isSpokenSkip(text)) answers.push({ questionId: question.id, skipped: true });
  else {
    const optionIds = matchSpokenOption(question, text);
    answers.push(
      optionIds.length > 0
        ? { questionId: question.id, optionIds }
        : { questionId: question.id, optionIds: [otherOptionId], text },
    );
  }
  pending.answers = answers;
  const next = pending.questions[answers.length];
  if (next) {
    sayFixed(call, "question", spokenQuestion(next, answers.length, pending.questions.length));
    return { action: "question" as const, interactionId: pending.interactionId, index: answers.length };
  }
  call.pending = null;
  const applied = answerQuestion(call.session, randomUUID(), pending.interactionId, { questions: answers });
  sayFixed(call, "question", answers.every((item) => item.skipped) ? "Tá bom, eu decido." : "Beleza, seguindo.");
  return { action: "answered" as const, interactionId: pending.interactionId, applied };
}

export function armIdle(call: VoiceCall) {
  if (call.idleTimer) clearTimeout(call.idleTimer);
  call.idleTimer = null;
  if (call.listeners.size > 0 || call.ended) return;
  call.idleTimer = setTimeout(() => endCall(call), idleCallMs);
  call.idleTimer.unref();
}

export function endCall(call: VoiceCall) {
  if (call.ended) return;
  call.ended = true;
  if (call.idleTimer) clearTimeout(call.idleTimer);
  if (call.hangup) clearTimeout(call.hangup.timer);
  call.unsubscribe();
  call.fast.close();
  const durationSecs = Math.max(1, Math.round((Date.now() - call.startedAt) / 1000));
  call.session.log.emit({
    type: "voice.call.ended",
    data: { callId: call.id, botId: call.botId, durationSecs, startedAt: new Date(call.startedAt).toISOString() },
  });
  void call.session.save();
  emit(call, { type: "call.ended", durationSecs });
  calls.delete(call.id);
  endedCalls.set(call.id, call.session);
}

const endedCalls = new Map<string, StoredSession>();

async function ensureThreadSession(bot: BotDefinition) {
  const thread = await ensureThread(bot.id);
  return getStoredSession(thread.sessionId) ?? null;
}

export async function startCall(bot: BotDefinition) {
  for (const existing of calls.values()) if (existing.botId === bot.id) endCall(existing);
  const thread = await ensureThread(bot.id);
  const session = getStoredSession(thread.sessionId);
  if (!session) throw new VoiceError("Não consegui abrir a conversa do bot.", 500);
  const workDir = join(dataDir, "work", "voice");
  await mkdir(workDir, { recursive: true });
  const fast = new FastLayer(fastPrompt(bot), workDir);
  const call: VoiceCall = {
    id: `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    botId: bot.id,
    session,
    fast,
    listeners: new Set(),
    pending: null,
    speaking: null,
    lastSpeechAt: 0,
    fillers: new Map(),
    replies: new Map(),
    turnStarts: new Map(),
    lastUtteranceAt: 0,
    idleTimer: null,
    unsubscribe: noop,
    ended: false,
    startedAt: Date.now(),
    spoken: 0,
    lastAck: null,
    language: voiceOf(bot).language,
    hangup: null,
  };
  call.unsubscribe = session.log.subscribe((line) => {
    try {
      const parsed = JSON.parse(line) as { facts?: Fact[] };
      if (parsed.facts) onFacts(call, parsed.facts);
    } catch {}
  });
  calls.set(call.id, call);
  armIdle(call);
  void fast.ask('CLASSIFIQUE: aquecimento. A pessoa disse: "ok"', false).done;
  return call;
}

export async function credentials(bot: BotDefinition, types: Array<"stt" | "tts">, who = "local") {
  const voice = voiceOf(bot);
  const release = reserveMint(who, types.length);
  const [stt, tts] = await Promise.all([
    types.includes("stt") ? mintToken("realtime_scribe") : Promise.resolve(null),
    types.includes("tts") ? mintToken("tts_websocket") : Promise.resolve(null),
  ]).finally(release);
  return {
    voice,
    ...(stt
      ? {
          stt: {
            url: sttUrl(stt, voice.language),
            token: stt,
            modelId: sttModel,
            sampleRate: sttSampleRate,
            vadSilenceSecs: vadSilence,
            vadThreshold,
            minSpeechMs,
          },
        }
      : {}),
    ...(tts
      ? {
          tts: {
            url: ttsUrl(voice.voiceId, tts, voice.language),
            token: tts,
            modelId: ttsModel,
            outputFormat: `pcm_${ttsSampleRate}`,
            sampleRate: ttsSampleRate,
          },
        }
      : {}),
  };
}

export function findCall(callId: string) {
  return calls.get(callId);
}

export async function rateCall(bot: BotDefinition, callId: string, rating: "up" | "down" | null) {
  const live = calls.get(callId);
  const session = live?.session ?? endedCalls.get(callId) ?? (await ensureThreadSession(bot));
  if (!session) return false;
  session.log.emit({ type: "voice.call.rated", data: { callId, rating } });
  return true;
}

export function endAllCalls() {
  for (const call of calls.values()) endCall(call);
}
