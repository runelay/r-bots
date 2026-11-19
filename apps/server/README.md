# runelay bots: server

The bots gateway: one Node 24 process (tsx, raw `node:http`, no database) on `127.0.0.1:2000` that serves every route of the contract in [docs/protocol](../../docs/protocol/README.md). It runs each turn on the Claude Agent SDK logged in through the Claude subscription of the local Claude Code (`~/.claude/.credentials.json`), or on Codex, Grok and Cursor through `@runelay-bots/providers`. No `ANTHROPIC_API_KEY`: `start.sh` and `src/index.ts` unset it. `tailscale serve` on 10447 (tailnet only) points at it.

## Run

Production runs in Docker from the repo root (`compose.yaml`, image built from `apps/server/Dockerfile`, container `runelay-bots`, `network_mode: host`, `restart: unless-stopped`, healthcheck on `GET /bots`):

```bash
docker compose up -d --build           # rebuild after changing apps/server or packages
docker compose restart                 # restart (picks up .env.local changes, not code changes)
docker compose logs -f --tail 200      # logs
docker compose ps                      # status + health
```

Never restart with a bot working: check `GET /status` first.

Development on the host (Node 24 at `~/.local/node24/bin`), with its own port and data so production is untouched:

```bash
npm ci                                  # once, at the repo root
cd apps/server
env -u CLAUDE_CONFIG_DIR GATEWAY_PORT=2100 BOTS_DATA_DIR=/path/to/data-copy BOTS_SCHEDULES=off \
  node --import tsx src/index.ts
```

What the image carries: Node 24, git, gh, supabase CLI, ffmpeg, agent-browser + its Chrome, Claude Code and Codex CLIs (versions pinned as build args), pnpm, bun, and the virtual desktop (Xvfb, openbox, xterm, xdotool, user `runelaybot` uid 1501 with sudo from `app`, Chrome copied to `/opt/runelay-chrome`). It runs as `app` (1000:1000, `HOME=/home/app`); the entrypoint starts as root, copies the uid/gid of the mounted HOME (or `/data`) onto `app` when they differ, and drops to `app` with `setpriv`, so files it writes in repos stay yours. Dependencies come from the root `package-lock.json` (npm workspaces, `npm ci --omit=dev`).

Mounts, fixed (no `.env`): `$HOME` at the same absolute path (worktrees store absolute paths; access is limited to the repositories the person allowed with `workspace_add`), `~/.local/share/runelay-bots` at `/data`, `~/.local/share/runelay-bots-backups` at `/backups`, from `$HOME` into `/home/app`: `.claude`, `.claude.json`, `.codex` (read-write, tokens refresh), `.config/gh`, `.supabase`, `.gitconfig` (ro), and the `desktop-home` volume at `/home/runelaybot` (desktop Chrome profiles). The vault key lives in the data dir (`vault.key`, created on first boot). Mac runner over HTTP stays off without `MAC_RUNNER_URL` and `PUBLIC_MCP_BASE` in `.env.local`.

Test a second instance without touching production: copy the data dir somewhere and write an override compose file that replaces the server's `/data` mount with the copy (`volumes: !override`) and sets `container_name: runelay-bots-test`, `GATEWAY_PORT=2100`, `BOTS_SCHEDULES=off`; then `docker compose -p runelay-bots-test -f compose.yaml -f <override.yaml> up -d --no-deps server` (and `down` with the same flags).

Roll back to systemd (the unit at `~/.config/systemd/user/runelay-bots.service` runs `apps/server/start.sh`):

```bash
docker compose down
systemctl --user enable --now runelay-bots
```

Env: `GATEWAY_PORT` (2000), `GATEWAY_HOST` (127.0.0.1), `BOTS_MODEL` (`claude-sonnet-5-5`; aliases `sonnet`, `opus`, `haiku` also work), `BOTS_DATA_DIR` (`<repo>/data`), `BOTS_SCHEDULES` (`on`), `BOTS_MAX_TURNS` (3), `VOICE_MAX_WARM` (3), `VAULT_KEY_FILE` (default `<data>/vault.key`). Secrets in `.env.local` (chmod 600): `RUNNER_TOKEN`, `MAC_RUNNER_URL`, `PUBLIC_MCP_BASE`, `JEV_API_KEY`, `RUNELAY_MCP_URL`, `RUNELAY_MCP_TOKEN`, `ELEVENLABS_API_KEY`.

## Layout

```
src/index.ts        boot: load data, timers, signals, listen
src/app.ts          central router (path → module route) and WebSocket upgrades
src/config/env.ts   ports, data dir and paths
src/shared/         http helpers, ValidationError, JSON file store, secret redaction
src/modules/<domain>/
  routes/           HTTP handlers of the domain
  services/         domain logic (stores live here too)
  repositories/     persistence that is not a plain service store (code worktrees and grants)
  types/ constants/ only where a domain needed them
bin/rb-secret-run.mjs   Bash helper that injects vault secrets
```

Domains: `accounts` (accounts, rate limits, Mac runner WebSocket), `approvals` (decisions, Jev, permission modes, delivery intent), `artifacts`, `canvas`, `bots`, `browser` (browser, desktop, live view, control), `code` (workspace, policy, hooks, live diff, PR/CI, dev servers, actions), `computer`, `connectors` (runelay), `conversations` (threads, sessions, conversations, handoff, turn repair), `engine` (turn orchestration, bot tools, MCP gateway, turn slots), `groups`, `memory`, `schedules`, `sections`, `skills`, `status`, `uploads`, `usage`, `vault`, `voice`.

Data (`<repo>/data`, outside the code and git-ignored): bots, sessions, threads, conversations, code state, uploads, artifacts, vault, usage index.

## Engine

Each turn calls `query()` with:

- `systemPrompt`: the bot instructions plus a short pt-BR footer;
- `tools: []` (all built-in Claude Code tools off), or `["Agent"]` when the bot delegates;
- `mcpServers`: one in-process server per bot (`bot_<id>`) with that bot's tools, plus one per delegated bot;
- `allowedTools`: the bot's own non-approval tools (and `Agent`); everything else goes to `canUseTool`;
- `canUseTool`: `browser_click` / `browser_fill` open an approval (`interaction.opened`) and wait for the answer route; tools of a delegated bot are only allowed inside its subagent; anything unknown is denied;
- `agents`: one subagent per delegated bot, built from its current definition (`instructions`, its MCP tools, `model: "inherit"`);
- `settingSources: []`, `strictMcpConfig: true`, `settings.disableClaudeAiConnectors: true`: nothing from `~/.claude` (CLAUDE.md, skills, hooks, MCP, claude.ai connectors) reaches the bots;
- `cwd`: `data/workspaces/<botId>` (empty);
- `resume`: the SDK session id saved in the session metadata, so a thread keeps its context; Claude Code auto-compacts long contexts. If resuming fails, the turn reruns once with a fresh SDK session behind the same `sessionId`;
- `includePartialMessages: true` for live `content.delta`.

Messages that arrive while a turn runs are queued and run as the next turn (eve steered the running turn instead).

Schedule turns post into the bot's main thread but run in a fresh SDK session (no resume): system prompt + schedule prompt + a one-paragraph summary of that schedule's previous reply. Chat turns resume only the chat SDK session and get a short note of the schedule replies since the last chat message. Past ~120k input tokens of context (`BOTS_CONTEXT_LIMIT`), the next chat turn starts a new SDK session seeded with the recent exchanges, keeping the thread id. Approvals inside a schedule turn are denied automatically, since nobody is there to answer. `POST /bots/:id/schedules/:name/run` triggers a schedule by hand.

## Accounts and runners

Each bot has `engine: {account, model, effort}`; `account` is `vps|mac:claude|codex|grok|cursor`. Provider adapters live in `packages/providers`. Bot tools are served to every provider by the gateway MCP endpoint `/mcp/:botId/:sessionId` (per-turn bearer token; `src/modules/engine`). `src/modules/accounts` detects accounts and routes turns. Since v21 the Mac runs turns inside the app, which connects to `wss://…:10447/runner/connect`; without the app, `mac:*` is offline. The old Node runner is archived in `~/projects/runelay-bots-archive/runner`.

## Limites de recurso (19/11)

- Container: 6 GB de RAM sem swap extra (`BOTS_MEM_LIMIT`), 3 CPUs (`BOTS_CPUS`), core dumps desligados. A VPS tem 15 GB e 4 núcleos; o resto fica para os outros serviços.
- Turnos: no máximo 3 ao mesmo tempo (`BOTS_MAX_TURNS`); o excedente fica na fila e a conversa mostra a posição. Voz não espera.
- Comandos de teste do modo código: um por vez, `nice 10`, 20 min de teto, 2 GB de heap por processo Node e 2 workers. Build/tsc/lint: mesmo teto, sem a trava.
- Voz: no máximo 3 processos quentes, fecham após 5 min parados.
- Chrome dos bots fecha após 10 min sem uso.
- Processos de turno levam `RUNELAY_TURN` no ambiente; turno encerrado ou cancelado mata a árvore inteira, e uma varredura por minuto mata órfãos.
- Detalhes do contrato em [docs/protocol](../../docs/protocol/README.md) (v30).
