import type { NativeToolHooks, ProviderEvent, SyncResult, TurnRequest } from "@runelay-bots/protocol";
import { runRemoteTurn } from "../../accounts/services/mac-runner.service";
import { beginMacTurn, finishMacTurn, type MacSyncPlan, prepareMacSync } from "../../code/services/mac-sync.service";
import { environmentsText } from "../constants/environments-messages.constants";
import { hostBoxSpec } from "./box-spec.service";
import { onHost } from "./host-turns.service";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function planFor(cwd: string | null): Promise<MacSyncPlan> {
  if (!cwd) return { kind: "plain" };
  try {
    return await prepareMacSync(cwd);
  } catch (error) {
    return { kind: "refused", message: environmentsText("macPrepareFailed", { reason: errorText(error) }) };
  }
}

export function macTurnOf(request: TurnRequest): TurnRequest {
  return { ...request, configDir: null };
}

export async function runOnMac(
  environmentId: string,
  botId: string,
  request: TurnRequest,
  signal: AbortSignal,
  emit: (event: ProviderEvent) => void,
  hooks?: NativeToolHooks,
) {
  const cwd = request.code?.cwd ?? null;
  const plan = await planFor(cwd);
  if (plan.kind === "refused") return emit({ type: "done", ok: false, message: plan.message });
  const sync = plan.kind === "sync" ? plan.sync : null;
  let result: SyncResult | null = null;
  if (sync) beginMacTurn(sync.cwd, environmentId, request.turnId);
  const outcome = await runRemoteTurn(
    environmentId,
    {
      turn: macTurnOf(request),
      botId,
      box: hostBoxSpec(),
      ...(hooks ? { hooks: onHost(hooks, "mac") } : {}),
      ...(sync
        ? {
            sync,
            onSync: (synced, failure) => {
              result = synced;
              if (failure) console.warn(`${new Date().toISOString()} mac sync ${request.turnId}: ${failure}`);
            },
          }
        : {}),
    },
    signal,
    emit,
  );
  if (outcome === "refused") emit({ type: "done", ok: false, message: environmentsText("macOffline") });
  if (!sync) return;
  await finishMacTurn(sync.cwd, result).catch((error) =>
    console.warn(`${new Date().toISOString()} mac sync ${request.turnId}: ${errorText(error)}`),
  );
}
