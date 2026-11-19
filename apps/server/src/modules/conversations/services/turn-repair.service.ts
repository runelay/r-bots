import { allStoredSessions, type Fact } from "./sessions.service";

export async function settleOrphanTurns() {
  let repaired = 0;
  for (const session of allStoredSessions()) {
    const open = new Set<string>();
    for (const line of session.log.lines) {
      if (!line.includes("turn.")) continue;
      try {
        for (const fact of (JSON.parse(line) as { facts?: Fact[] }).facts ?? []) {
          const turnId = String((fact.data as { turnId?: unknown } | undefined)?.turnId ?? "");
          if (!turnId) continue;
          if (fact.type === "turn.started") open.add(turnId);
          else if (fact.type === "turn.settled") open.delete(turnId);
        }
      } catch {}
    }
    if (open.size === 0) continue;
    session.log.emit(
      ...[...open].map(
        (turnId) =>
          ({
            type: "turn.settled",
            data: { outcome: "cancelled", turnId, reason: "server_restart" },
            scope: { turnId },
          }) as Fact,
      ),
    );
    await session.save().catch(() => undefined);
    repaired += open.size;
  }
  return repaired;
}
