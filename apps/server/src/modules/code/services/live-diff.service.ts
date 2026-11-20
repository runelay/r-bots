import { join } from "node:path";
import type { EventLog } from "../../conversations/services/sessions.service";
import {
  baseContent,
  changedFiles,
  clipText,
  diffTexts,
  type FileChange,
  followHead,
  invalidateStatus,
  isAncestor,
  readHead,
  readMaybe,
  type WorkspaceState,
} from "./workspace.service";

const bulkLimit = Number(process.env.CODE_LIVE_BULK_LIMIT ?? 25);
const prUrlPattern = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

export type CodeSignal =
  | { sessionId: string; kind: "head"; workspaceId?: string }
  | { sessionId: string; kind: "pr"; urls: string[]; created: boolean };

let signalHandler: ((signal: CodeSignal) => void) | null = null;

export function onCodeSignal(handler: ((signal: CodeSignal) => void) | null) {
  signalHandler = handler;
}

function signal(value: CodeSignal) {
  try {
    signalHandler?.(value);
  } catch (error) {
    console.warn("code signal failed", error);
  }
}

function textOf(value: unknown) {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export interface ToolTrace {
  input?: unknown;
  output?: unknown;
}

export class CodeLive {
  private last = new Map<string, string | null>();
  private baseline = new Map<string, string | null>();
  private chain: Promise<void> = Promise.resolve();
  private lastStatus = "";
  private head: { branch: string | null; sha: string } | null = null;

  constructor(
    private readonly log: EventLog,
    private readonly turnId: string,
    readonly workspace: WorkspaceState,
    private readonly snapshot: Map<string, string | null>,
  ) {
    this.chain = readHead(workspace.path)
      .then((head) => {
        this.head = head;
      })
      .catch(() => undefined);
  }

  scan(callId: string | null, source: "tool" | "sweep", trace?: ToolTrace, notePrs = true) {
    if (trace && notePrs) this.notePullRequests(trace);
    const next = this.chain
      .then(() => this.run(callId, source))
      .catch((error) => console.warn("code scan failed", error));
    this.chain = next;
    return next;
  }

  private async start(rel: string) {
    if (this.baseline.has(rel)) return this.baseline.get(rel) ?? null;
    const value = this.snapshot.has(rel) ? (this.snapshot.get(rel) ?? null) : await baseContent(this.workspace, rel);
    this.baseline.set(rel, value);
    return value;
  }

  private notePullRequests(trace: ToolTrace) {
    const urls = [...new Set(textOf(trace.output).match(prUrlPattern) ?? [])];
    if (urls.length === 0) return;
    const input = trace.input as { command?: unknown } | null | undefined;
    const created = /\bpr\s+create\b/.test(textOf(input?.command));
    signal({ sessionId: this.log.sessionId, kind: "pr", urls, created });
  }

  private async moved() {
    const head = await readHead(this.workspace.path).catch(() => null);
    const previous = this.head;
    if (head) this.head = head;
    if (!previous || !head) return false;
    if (head.branch === previous.branch && head.sha === previous.sha) return false;
    if (head.branch === previous.branch && (await isAncestor(this.workspace.path, previous.sha, head.sha)))
      return false;
    const change = await followHead(this.workspace);
    if (change)
      this.log.emit({
        type: "code.branch",
        data: { workspaceId: this.workspace.id, from: change.from, to: change.to },
        scope: { turnId: this.turnId },
      });
    signal({ sessionId: this.log.sessionId, kind: "head", workspaceId: this.workspace.id });
    return true;
  }

  private async run(callId: string | null, source: "tool" | "sweep") {
    const switched = await this.moved();
    invalidateStatus(this.workspace);
    const files = await changedFiles(this.workspace, true).catch(() => [] as FileChange[]);
    const paths = new Set([
      ...files.filter((file) => !file.binary).map((file) => file.path),
      ...this.snapshot.keys(),
      ...this.last.keys(),
    ]);
    if (switched) {
      for (const rel of paths) {
        const current = await readMaybe(join(this.workspace.path, rel));
        this.last.set(rel, current);
        this.baseline.set(rel, current);
      }
      paths.clear();
    }
    const changed: { rel: string; absPath: string; after: string | null }[] = [];
    for (const rel of paths) {
      const absPath = join(this.workspace.path, rel);
      const after = await readMaybe(absPath);
      const previous = this.last.has(rel) ? (this.last.get(rel) ?? null) : await this.start(rel);
      if (previous === after) continue;
      this.last.set(rel, after);
      changed.push({ rel, absPath, after });
    }
    if (changed.length > bulkLimit) {
      const touched = new Set(changed.map((item) => item.rel));
      const stats = files.filter((file) => touched.has(file.path));
      this.log.emit({
        type: "code.bulk",
        data: {
          callId,
          workspaceId: this.workspace.id,
          files: changed.length,
          added: stats.reduce((sum, file) => sum + file.added, 0),
          removed: stats.reduce((sum, file) => sum + file.removed, 0),
          paths: changed.slice(0, 12).map((item) => item.rel),
          source,
          key: `${this.turnId}:bulk:${callId ?? source}`,
        },
        scope: { turnId: this.turnId },
      });
    }
    for (const { rel, absPath, after } of changed.length > bulkLimit ? [] : changed) {
      const before = await this.start(rel);
      const diff = await diffTexts(before, after);
      this.log.emit({
        type: "code.edit",
        data: {
          callId,
          workspaceId: this.workspace.id,
          path: rel,
          absPath,
          outside: false,
          before: clipText(before),
          after: clipText(after),
          hunks: diff.hunks,
          added: diff.added,
          removed: diff.removed,
          created: before === null,
          deleted: after === null,
          source,
          cumulative: true,
          key: `${this.turnId}:${rel}`,
        },
        scope: { turnId: this.turnId },
      });
    }
    const summary = {
      files: files.length,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
    };
    const signature = JSON.stringify(summary);
    if (signature === this.lastStatus) return;
    this.lastStatus = signature;
    this.log.emit({
      type: "code.status",
      data: { workspaceId: this.workspace.id, ...summary },
      scope: { turnId: this.turnId },
    });
  }
}

export interface LiveScanner {
  scan(callId: string | null, source: "tool" | "sweep", trace?: ToolTrace): Promise<void>;
}

export class CodeLives implements LiveScanner {
  private lives = new Map<string, CodeLive>();

  constructor(
    private readonly log: EventLog,
    private readonly turnId: string,
  ) {}

  has(workspace: WorkspaceState) {
    return this.lives.has(workspace.id);
  }

  add(workspace: WorkspaceState, snapshot: Map<string, string | null>) {
    const current = this.lives.get(workspace.id);
    if (current && current.workspace === workspace) return current;
    const live = new CodeLive(this.log, this.turnId, workspace, snapshot);
    this.lives.set(workspace.id, live);
    return live;
  }

  async scan(callId: string | null, source: "tool" | "sweep", trace?: ToolTrace) {
    let first = true;
    for (const live of [...this.lives.values()]) {
      if (!live.workspace.active) continue;
      await live.scan(callId, source, trace, first);
      first = false;
    }
  }
}
