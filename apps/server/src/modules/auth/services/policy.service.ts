import type { Principal } from "./auth.middleware";
import { ownerRole } from "./auth.service";

export type Decision = "allow" | "owner" | "deny-internal";

type MethodRule = "*" | "write" | string[];

interface OwnerRule {
  method: MethodRule;
  path: string[];
}

const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const ownerRoutes: OwnerRule[] = [
  { method: "write", path: ["integrations", "**"] },
  { method: "*", path: ["vault", "**"] },
  { method: "*", path: ["code", "grants"] },
  { method: "*", path: ["jobs", "**"] },
  { method: "write", path: ["connectors", "**"] },
  { method: ["POST"], path: ["bots"] },
  { method: ["PATCH"], path: ["bots", "*"] },
  { method: ["POST"], path: ["bots", "*", "delete"] },
  { method: ["POST"], path: ["bots", "*", "restore"] },
  { method: ["POST"], path: ["accounts", "refresh"] },
  { method: "write", path: ["accounts", "**"] },
  { method: "write", path: ["servers", "**"] },
  { method: "write", path: ["preferences"] },
  { method: "write", path: ["tests", "**"] },
  { method: "write", path: ["simulators", "**"] },
];

export const internalRoutes: Array<{ method: string; path: string[] }> = [
  { method: "GET", path: ["status"] },
  { method: "GET", path: ["health"] },
];

function methodMatches(rule: MethodRule, method: string) {
  if (rule === "*") return true;
  if (rule === "write") return writeMethods.has(method);
  return rule.includes(method);
}

export function pathMatches(pattern: string[], parts: string[]) {
  for (let index = 0; index < pattern.length; index++) {
    const segment = pattern[index];
    if (segment === "**") return true;
    const part = parts[index];
    if (part === undefined) return false;
    if (segment !== "*" && segment !== part) return false;
  }
  return pattern.length === parts.length;
}

export function requiresOwner(method: string, parts: string[], search: URLSearchParams = new URLSearchParams()) {
  if (method === "GET" && parts.length === 1 && parts[0] === "accounts" && search.get("refresh") === "1") return true;
  return ownerRoutes.some((rule) => methodMatches(rule.method, method) && pathMatches(rule.path, parts));
}

export function internalAllowed(method: string, parts: string[]) {
  return internalRoutes.some((rule) => rule.method === method && pathMatches(rule.path, parts));
}

export function authorize(
  method: string,
  parts: string[],
  principal: Principal,
  search: URLSearchParams = new URLSearchParams(),
): Decision {
  if (principal.method === "internal") return internalAllowed(method, parts) ? "allow" : "deny-internal";
  if (requiresOwner(method, parts, search) && principal.role !== ownerRole) return "owner";
  return "allow";
}

export function forbiddenResponse(decision: Exclude<Decision, "allow">) {
  const error =
    decision === "owner" ? "Só o dono da conta pode fazer isso." : "O token interno não tem acesso a esta rota.";
  return Response.json(
    { ok: false, error, code: "forbidden" },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}
