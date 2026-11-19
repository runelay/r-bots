export interface DeliveryAsk {
  commit: boolean;
  push: boolean;
  pr: boolean;
}

export const noDeliveryAsk: DeliveryAsk = { commit: false, push: false, pr: false };

const commitText = /\b(commit(s|ar|a|e|ou|ando|ado|ados|em)?|comit(ar|a|e|ou|ando|ado)?)\b/i;
const prText = /\b((abr(e|ir|a|indo)|cri(a|ar|e)|mand(a|ar|e))\s+(o\s+|um\s+)?pr|pull\s*request|pr\s+summary)\b/i;
const pushText =
  /\b(push|pusha(r)?|d(á|a|ar)\s+(um\s+)?push|sob(e|ir|a)(\s+(a|o|essa|esse|isso|pro|para\s+o))?\s+(branch|c[oó]digo|commits?|corre[cç][aã]o|isso|pr|github|remoto|origin)|manda(r)?\s+(pro|para\s+o)\s+github|envia(r)?\s+(pro|para\s+o)\s+github|atualiz(a|ar|e)\s+(o\s+)?pr)\b/i;
const negation = /\b(n[ãa]o|sem|nunca|nem)\s+(\S+\s+){0,3}$/i;

const commitSkill = /(^|[-_])(commit|commita|commitar)([-_]|$)/i;
const prSkill = /(^|[-_])(pr|pull-request)([-_]|$)/i;
const pushSkill = /(^|[-_])push([-_]|$)/i;

function mentions(text: string, pattern: RegExp) {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (const match of text.matchAll(global)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0);
    if (!negation.test(before)) return true;
  }
  return false;
}

export function askedDelivery(text: string, skills: { slug: string; name?: string }[] = []): DeliveryAsk {
  const names = skills.flatMap((skill) => [skill.slug, skill.name ?? ""]).filter(Boolean);
  const pr = names.some((name) => prSkill.test(name) && !/^review-pr$/i.test(name)) || mentions(text, prText);
  const push = pr || names.some((name) => pushSkill.test(name)) || mentions(text, pushText);
  const commit = push || names.some((name) => commitSkill.test(name)) || mentions(text, commitText);
  return { commit, push, pr };
}

export function askedReason(kind: "commit" | "push" | "pr") {
  if (kind === "pr") return "Você pediu o PR.";
  if (kind === "push") return "Você pediu o push.";
  return "Você pediu o commit.";
}
