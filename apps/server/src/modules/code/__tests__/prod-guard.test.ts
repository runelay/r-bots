import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withLanguage } from "../../../shared/i18n";
import { botHomePath, ensureBotHome, shellSupported } from "../services/bot-home.service";
import { criticalCommand, prodReadCommand } from "../services/prod-guard.service";
import { worktreesRoot } from "../services/repos.service";

const prod = "Isso mexe em produção, então preciso do seu ok.";
const deploy = "Isso coloca algo no ar, então preciso do seu ok.";
const outbound = "Isso fala com gente de fora ou mexe com dinheiro, então preciso do seu ok.";

describe("criticalCommand", () => {
  test("flags production writes", () => {
    for (const command of [
      `supabase db query --remote=abc "delete from t"`,
      `supabase db query --linked -f x.sql`,
      "supabase db push",
      "supabase db reset --linked",
      "supabase migration up --linked",
      "supabase functions deploy hello",
      "supabase secrets set A=1",
      "supabase storage rm ss:///b/x --linked",
      "wrangler secret put TOKEN",
      "wrangler kv key delete k",
      "wrangler d1 execute db --remote --command 'select 1'",
      "psql postgres://user@db.example.com/postgres -c 'select 1'",
    ]) {
      expect(criticalCommand(command)?.reason).toBe(prod);
    }
    expect(withLanguage("en", () => criticalCommand("wrangler kv key delete k")?.reason)).toBe(
      "This touches production, so I need your ok.",
    );
  });

  test("flags deploys, merges and publishing", () => {
    for (const command of [
      "wrangler deploy",
      "npx wrangler deploy --env production",
      "wrangler versions deploy",
      "wrangler triggers deploy",
      "gh pr merge 12 --squash",
      "gh workflow run deploy-prod.yml",
      "gh release create v1",
      "gh api -X POST repos/a/b/merges",
      "vercel --prod",
      "npm publish",
      "bun run deploy:prod",
      "pnpm release",
      "make deploy",
      "FOO=1 env BAR=2 wrangler deploy",
      `bash -c "wrangler deploy"`,
    ]) {
      expect(criticalCommand(command)?.reason).toBe(deploy);
    }
  });

  test("flags money and messages to outside services", () => {
    for (const command of [
      "curl -X POST https://api.asaas.com/v3/transfers -d '{}'",
      "curl https://slack.com/api/chat.postMessage --data 'x'",
      "curl -XPOST https://sandbox.asaas.com/api/v3/payments",
      "curl --request DELETE https://api.stripe.com/v1/x",
      "xh POST api.resend.com/emails to=a",
    ]) {
      expect(criticalCommand(command)?.reason).toBe(outbound);
    }
  });

  test("lets reads and ordinary commands through", () => {
    for (const command of [
      `supabase db query --remote=abc --read-only "select 1"`,
      "supabase db query 'select 1'",
      "supabase projects list",
      "wrangler whoami",
      "wrangler tail api --format json",
      "wrangler d1 execute db --local --command 'select 1'",
      "gh auth status",
      "gh run list --limit 5",
      "gh api repos/a/b/merges",
      "gh api -X GET repos/a/b/merges",
      "gh pr view 3",
      "curl -s https://api.example.com/health",
      "curl https://api.asaas.com/v3/status",
      "npm test",
      "bun",
      "psql postgres://localhost/db",
      "bash -c",
      "ls -la",
      "git status",
    ]) {
      expect(criticalCommand(command)).toBeNull();
    }
  });

  test("an unparseable command is left to the policy", () => {
    expect(criticalCommand('echo "unterminated')).toBeNull();
  });
});

describe("prodReadCommand", () => {
  test("accepts read-only remote queries and listings, piped into readers", () => {
    expect(prodReadCommand(`supabase db query --remote=abc --read-only "select 1"`)).toBe(true);
    expect(prodReadCommand(`cd /tmp && supabase db query --linked --read-only -f q.sql | jq . | head -5`)).toBe(true);
    expect(prodReadCommand("supabase projects list")).toBe(true);
    expect(prodReadCommand("supabase migration list --linked")).toBe(true);
    expect(prodReadCommand(`supabase db query --remote=abc --read-only "select 1" > /dev/null`)).toBe(true);
  });

  test("rejects writes, local queries, other commands and tricks", () => {
    for (const command of [
      "",
      `supabase db query --remote=abc "update t set a=1"`,
      `supabase db query --read-only "select 1"`,
      "supabase db push",
      "supabase functions list",
      `supabase db query --remote=abc --read-only "select 1" > out.txt`,
      `supabase db query --remote=abc --read-only "select 1" | sh`,
      `supabase db query --remote=abc --read-only "select 1" &`,
      `supabase db query --remote=$REF --read-only "select 1"`,
      "ls",
      "cd /tmp",
      'echo "unterminated',
    ]) {
      expect(prodReadCommand(command)).toBe(false);
    }
  });
});

describe("bot home", () => {
  test("only Claude on the VPS gets the terminal", () => {
    expect(shellSupported("claude", "vps")).toBe(true);
    expect(shellSupported("claude", "mac")).toBe(false);
    expect(shellSupported("codex", "vps")).toBe(false);
  });

  test("lives under the worktrees root and is created on demand", async () => {
    expect(botHomePath("davi")).toBe(join(worktreesRoot, ".bots", "davi"));
    expect(botHomePath("a/../b")).toBe(join(worktreesRoot, ".bots", "a____b"));
    const home = await ensureBotHome("prod-guard-home");
    expect(home).toMatchObject({ id: "home:prod-guard-home", path: botHomePath("prod-guard-home"), branch: "" });
    expect(await ensureBotHome("prod-guard-home")).toEqual(home);
  });
});
