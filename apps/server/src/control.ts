export type Controller = "bot" | "user";

const controllers = new Map<string, Controller>();
const listeners = new Set<(botId: string, controller: Controller) => void>();

export function controllerOf(botId: string): Controller {
  return controllers.get(botId) ?? "bot";
}

export function setController(botId: string, controller: Controller) {
  controllers.set(botId, controller);
  for (const listener of listeners) listener(botId, controller);
}

export function onControllerChange(listener: (botId: string, controller: Controller) => void) {
  listeners.add(listener);
}

export async function waitForBotControl(botId: string, signal?: AbortSignal, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (controllerOf(botId) === "user") {
    if (signal?.aborted) throw new Error("Cancelado.");
    if (Date.now() > deadline) throw new Error("O usuário está controlando o navegador. Tente de novo quando ele devolver o controle.");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
