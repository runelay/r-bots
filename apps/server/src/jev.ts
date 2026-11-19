export const jevModel = process.env.JEV_MODEL ?? "jev-1.14.0";
const jevUrl = process.env.JEV_URL ?? "https://api.typesafe.ai/v1/systemone";
const timeoutMs = Number(process.env.JEV_TIMEOUT_MS ?? 1500);
const pricePerToken = 0.042 / 1_000_000;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface GradedAnswer {
  type: "score" | "choice";
  score?: number;
  choice?: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export type JevAnswer = NoulAnswer | GradedAnswer;

export interface JevQuestion {
  type: "noul" | "score" | "choice";
  instructions: string;
  criteria?: string[] | Record<string, string>;
}

export interface JevResult {
  answers: Record<string, JevAnswer>;
  model: string;
  inputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export function jevEnabled() {
  return Boolean(process.env.JEV_API_KEY);
}

export async function askJev(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult> {
  const key = process.env.JEV_API_KEY;
  if (!key) throw new Error("JEV_API_KEY ausente.");
  const started = Date.now();
  const response = await fetch(jevUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: jevModel, state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Jev respondeu ${response.status}.`);
  const body = (await response.json()) as { model?: string; answers?: Record<string, JevAnswer>; usage?: { input_tokens?: number } };
  const inputTokens = body.usage?.input_tokens ?? 0;
  const result: JevResult = {
    answers: body.answers ?? {},
    model: body.model ?? "desconhecido",
    inputTokens,
    costUsd: inputTokens * pricePerToken,
    latencyMs: Date.now() - started,
  };
  console.log(`jev ${result.model} ${result.latencyMs}ms ${inputTokens} tok`);
  return result;
}

export function noul(result: JevResult, id: string) {
  const answer = result.answers[id];
  return answer?.type === "noul" ? answer.noul : null;
}

export function graded(result: JevResult, id: string) {
  const answer = result.answers[id];
  return answer && answer.type !== "noul" ? answer : null;
}
