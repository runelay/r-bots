import { getStoredSession } from "../../conversations/services/sessions.service";
import { startWorktreeCollector } from "../repositories/code.repository";
import { startPrWatcher } from "./pull-request.service";
import { activeWorkspace, listRepos } from "./workspace.service";

export function startCodeHousekeeping() {
  void listRepos().catch(() => undefined);
  startPrWatcher();
  startWorktreeCollector((record) => {
    const session = getStoredSession(record.sessionId);
    return activeWorkspace(session)?.id === record.id;
  });
}
