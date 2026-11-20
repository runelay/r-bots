import { defineJob, schedule } from "../../jobs/services/jobs.service";
import { listConnections, runelayEnabled } from "./runelay.service";

export const refreshJobType = "connectors.refresh";

export async function runRefreshJob() {
  if (!runelayEnabled()) return { skipped: true };
  await listConnections(true);
  return { skipped: false };
}

defineJob<Record<string, never>>(refreshJobType, { attempts: 3, backoffMs: 15_000, handler: runRefreshJob });

export function startConnectionsRefresh() {
  return schedule(refreshJobType, { pattern: "*/5 * * * *" }, refreshJobType, {});
}
