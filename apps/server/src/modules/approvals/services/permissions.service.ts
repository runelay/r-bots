import type { Gate } from "../../code/services/policy.service";

export const permissionModes = ["readonly", "edit", "default", "full"] as const;
export type PermissionMode = (typeof permissionModes)[number];

export const permissionLabels: Record<PermissionMode, string> = {
  readonly: "Somente leitura",
  edit: "Editar",
  default: "Padrão",
  full: "Acesso total",
};

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (permissionModes as readonly string[]).includes(value);
}

export function effectivePermission(
  sessionMode: PermissionMode | undefined,
  botMode: PermissionMode | undefined,
): PermissionMode {
  return sessionMode ?? botMode ?? "default";
}

export type ActionClass = "read" | "edit" | "command" | "deliver";

const readonlyDeny =
  "Esta conversa está em Somente leitura: não edito arquivos, não rodo comandos que mudam algo, não faço commit nem escrevo em conectores. Diga em uma linha o que você faria e que a pessoa pode trocar o modo no seletor de permissão.";

export function applyCodePermission(
  mode: PermissionMode,
  action: ActionClass,
  gate: Gate,
  fixedViolation: string | null,
  summary: string,
): Gate {
  if (fixedViolation) return { kind: "deny", message: fixedViolation };
  if (mode === "default") return gate;
  if (gate.kind === "deny") return gate;
  if (mode === "full") return gate.kind === "asked" ? gate : { kind: "allow" };
  if (mode === "readonly") {
    if (action === "read") return gate.kind === "human" ? gate : { kind: "allow" };
    return { kind: "deny", message: readonlyDeny };
  }
  if (action === "read" || action === "edit") return gate.kind === "jev" ? { kind: "allow" } : gate;
  if (gate.kind === "human") return { ...gate, reason: gate.reason || "Modo Editar: comandos pedem sua confirmação." };
  return {
    kind: "human",
    prompt: `${summary}?`,
    reason: "Modo Editar: comandos e entregas pedem sua confirmação.",
    hard: false,
  };
}

export type RemoteKind = "read" | "write" | "outbound" | "free";

export function remotePermission(mode: PermissionMode, kind: RemoteKind): "allow" | "card" | "deny" {
  if (kind === "read") return "allow";
  if (mode === "full") return "allow";
  if (mode === "readonly") return "deny";
  if (mode === "edit") return "card";
  return kind === "outbound" ? "card" : "allow";
}

export const readonlyRemoteMessage = readonlyDeny;

export function permissionGuide(mode: PermissionMode) {
  const lines: Record<PermissionMode, string> = {
    readonly:
      "Modo Somente leitura (vale acima de qualquer regra de autonomia deste prompt): você lê, busca e roda comandos de leitura (git status, git diff, ls, cat, rg, testes que não escrevem nada). Não edita arquivos, não faz commit, push nem PR, não roda comando que muda algo e não escreve em conectores: essas ações são negadas na hora. Se o pedido precisar disso, explique o que faria e diga que a pessoa pode trocar o modo da conversa.",
    edit: "Modo Editar (vale acima de qualquer regra de autonomia deste prompt): você lê e edita arquivos da worktree direto. Todo comando que não seja só leitura, commit, push, PR e escrita em conectores pedem um card de aprovação à pessoa. Peça uma vez por passo, sem repetir o que já foi negado.",
    default: "Modo Padrão: autonomia normal. Só a lista dura pede aprovação.",
    full: "Modo Acesso total: terminal, arquivos, conectores, commit, push, PR e rotinas rodam direto, sem card. Só a lista dura de produção ainda abre card: deploy, escrita em banco de produção, dinheiro e mensagem para fora. Continuam proibidos, e são negados sem card: assinatura de IA em commit ou PR (Co-Authored-By, Generated with) e push --force em main, master ou develop. Mesmo com acesso total, faça só o que a pessoa pediu.",
  };
  return `## Permissão desta conversa\n${lines[mode]}`;
}
