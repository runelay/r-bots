import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type BotDefinition, voiceOf } from "../../bots/services/bots.service";
import type { BotTool } from "../../engine/services/bot-tools.service";
import { integrationSecret } from "../../integrations/services/integration-store.service";
import { trustedServiceUrl } from "../../integrations/services/integrations.service";
import { outboxDir } from "../../uploads/services/send-file.service";
import { importBotFile, publicUpload } from "../../uploads/services/uploads.service";

export const maxSpeechChars = 5000;
const speechModel = process.env.SPEECH_MODEL ?? "eleven_multilingual_v2";

function apiBase() {
  return trustedServiceUrl(process.env.ELEVENLABS_API_URL, "https://api.elevenlabs.io");
}

export function speechFileName(title: string | undefined, now = new Date()) {
  const slug = (title ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${slug || "audio"}-${stamp}.mp3`;
}

async function failureOf(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    detail?: { message?: string; status?: string } | string;
  } | null;
  const detail = typeof body?.detail === "string" ? body.detail : (body?.detail?.message ?? body?.detail?.status);
  return detail ? `${response.status}: ${detail.slice(0, 200)}` : String(response.status);
}

export async function synthesizeSpeech(
  bot: BotDefinition,
  input: { text: string; voiceId?: string; title?: string },
  signal?: AbortSignal,
) {
  const key = integrationSecret("elevenlabs");
  if (!key) throw new Error("A ElevenLabs não está conectada. Peça para a pessoa conectar em Configurações › Integrações.");
  const voice = voiceOf(bot);
  const voiceId = input.voiceId ?? voice.voiceId;
  const url = new URL(`${apiBase()}/v1/text-to-speech/${voiceId}`);
  url.searchParams.set("output_format", "mp3_44100_128");
  const response = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text: input.text,
      model_id: speechModel,
      language_code: voice.language,
      voice_settings: { speed: voice.speed },
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`A ElevenLabs não gerou o áudio (${await failureOf(response)}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error("A ElevenLabs devolveu um áudio vazio.");
  const dir = join(outboxDir(bot.id), "audios");
  await mkdir(dir, { recursive: true });
  const name = speechFileName(input.title);
  const path = join(dir, name);
  await writeFile(path, bytes);
  const meta = await importBotFile(bot.id, path, name, input.text);
  return { meta, path };
}

export function speechTools(bot: BotDefinition): BotTool[] {
  return [
    {
      name: "speech_create",
      description: `Gera um áudio falado (MP3) a partir de um texto com a voz da ElevenLabs configurada para você, usando a chave que a pessoa salvou em Configurações › Integrações (você nunca vê a chave). Use sempre que pedirem para ouvir, narrar, gravar uma locução ou mandar um áudio: não chame a API da ElevenLabs com http_request. Mande o texto exatamente como deve ser falado, sem markdown, até ${maxSpeechChars} caracteres; texto maior, divida em partes. O áudio é salvo na pasta de saída e já aparece na conversa como player: não use send_file para ele. voiceId troca a voz só nesta chamada.`,
      shape: {
        text: z.string().trim().min(1).max(maxSpeechChars),
        title: z.string().max(80).optional(),
        voiceId: z
          .string()
          .regex(/^[A-Za-z0-9]{8,64}$/)
          .optional(),
      },
      approval: null,
      label: (input) => (typeof input.title === "string" && input.title ? `Gerar áudio: ${input.title}` : "Gerar áudio"),
      run: async (input, signal) => {
        const { meta, path } = await synthesizeSpeech(
          bot,
          {
            text: String(input.text),
            voiceId: typeof input.voiceId === "string" ? input.voiceId : undefined,
            title: typeof input.title === "string" ? input.title : undefined,
          },
          signal,
        );
        return {
          uploadId: meta.uploadId,
          name: meta.name,
          path,
          size: meta.size,
          fileEvent: { type: "file.sent", data: { attachment: publicUpload(bot.id, meta) } },
        };
      },
    },
  ];
}
