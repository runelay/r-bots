# runelay bots: server-sdk

Backend v2 of runelay bots. It replaces the eve stack in `../server` (kept on disk as the fallback) with the Claude Agent SDK, logged in through the Claude subscription of the local Claude Code (`~/.claude/.credentials.json`). No `ANTHROPIC_API_KEY`: `start.sh` and `src/main.ts` unset it, so the SDK reports `apiKeySource: "none"` (OAuth login).

One Node process on `127.0.0.1:2000` serves every route (v1, v2, `/meta`, the eve-compatible session API). `tailscale serve` on 10447 already points at it.

## Run

Since 19/11/2026 it runs on the VPS in Docker (`Dockerfile` + `docker-compose.yml` in this folder, container `runelay-bots`, `network_mode: host`, `restart: unless-stopped`, healthcheck on `GET /bots`). Run everything from `server-sdk/`:

```bash
docker compose restart                 # restart (picks up .env.local changes, not code changes)
docker compose logs -f --tail 200      # logs (data/server.log is no longer written)
docker compose up -d --build           # rebuild after changing src/ or shared/ (npm ci is cached in its own layer)
docker compose ps                      # status + health
./start.sh                             # foreground on the host, only for debugging (stop the container first)
```

What the image carries: Node 24, git, gh, supabase CLI, ffmpeg, agent-browser + its Chrome, Claude Code and Codex CLIs (versions pinned as build args), pnpm, bun, and the virtual desktop (Xvfb, openbox, xterm, xdotool, user `runelaybot` uid 1501 with sudo from `anderson`, Chrome copied to `/opt/runelay-chrome`). It runs as `anderson` (uid/gid 1000), so files it writes in repos stay yours.

Mounts, all at the same absolute path inside and outside: `/home/anderson/projects` (repos, `worktrees/`, and this folder, so `data/` sits at its host path), `~/.claude`, `~/.claude.json`, `~/.codex` (read-write, tokens refresh), `~/.config/gh`, `~/.supabase`, `~/.gitconfig` (ro), `/home/runelaybot` (desktop Chrome profiles). `.env.local` is mounted read-only at `/app/server-sdk/.env.local` and `start.sh` sources it.

Test a second instance without touching production: copy `data/` somewhere, write an env file without `RUNELAY_MCP_*`, and an override file with `BOTS_CONTAINER_NAME=runelay-bots-test`, `GATEWAY_PORT=2100`, `BOTS_DATA_DIR=<copy>`, `BOTS_SCHEDULES=off`, `BOTS_ENV_FILE=<env>`; then `docker compose -p runelay-bots-test --env-file <override> up -d` (and `down` with the same flags).

Roll back to systemd (the unit is kept at `~/.config/systemd/user/runelay-bots.service`):

```bash
docker compose down
systemctl --user enable --now runelay-bots
```

Env: `GATEWAY_PORT` (2000), `GATEWAY_HOST` (127.0.0.1), `BOTS_MODEL` (`claude-sonnet-5-5`; aliases `sonnet`, `opus`, `haiku` also work), `BOTS_DATA_DIR` (`./data`), `CONTY_API_DIR` (supabase link for `prod_query`).

Stop: `docker compose stop` (or `kill -- -<pgid>` of `node --import tsx src/main.ts` when running `./start.sh` on the host).

To roll back to eve: stop this process and run `../server/dev.sh` with `SKIP_BUILD=1`.

## Layout

```
src/main.ts       HTTP routes (v1 + v2 + eve session API)
src/bots.ts       bot store (data/bots/<id>.json), validation (no built-in bots: the store starts empty)
src/engine.ts     one turn = one query() call; SDK messages -> eve-shaped events; approvals; cancel
src/tools.ts      in-process MCP servers per bot: prod_query, browser_*
src/sessions.ts   session metadata + NDJSON event log (data/sessions/<id>.json|.ndjson)
src/threads.ts    one main thread per bot (data/threads/<botId>.json), unread
src/scheduler.ts  croner jobs, timezone-aware, reloaded when a bot changes
src/browser.ts    agent-browser wrapper (session runelay-<botId>), print + state after every action
src/prod-query.ts SELECT-only guard + `supabase db query --remote --read-only`
data/             bots, sessions, threads, browser prints, per-bot empty workspaces, server.log
```

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

## v3: accounts and runners

Each bot has `engine: {account, model, effort}`; `account` is `vps|mac:claude|codex|grok|cursor`. Provider adapters live in `../shared/providers` (used in-process here and by `../runner` on the Mac). Bot tools are served to every provider by the gateway MCP endpoint `/mcp/:botId/:sessionId` (per-turn bearer token); approvals happen in the MCP handler (`src/mcp.ts`). `src/accounts.ts` detects accounts (VPS probes + `GET /accounts` on the Mac runner) and routes turns. Secrets: `RUNNER_TOKEN`, `MAC_RUNNER_URL`, `PUBLIC_MCP_BASE` in `.env.local` (chmod 600, read by `start.sh`).

Mac runner deploy:

```bash
rsync -a --delete --exclude node_modules --exclude data --exclude .env --exclude runner.log -e "ssh -i ~/.ssh/id_ed25519_mac_qa" ../runner/ andersonbrdev@100.122.172.127:runelay-bots/runner/
rsync -a --delete --exclude node_modules -e "ssh -i ~/.ssh/id_ed25519_mac_qa" ../shared/ andersonbrdev@100.122.172.127:runelay-bots/shared/
ssh -i ~/.ssh/id_ed25519_mac_qa andersonbrdev@100.122.172.127 'launchctl kickstart -k gui/$(id -u)/com.runelay.bots.runner'
```

The runner runs `/opt/homebrew/bin/node` (v26) from `start.sh`, sources `~/runelay-bots/runner/.env` (chmod 600) and logs to `~/runelay-bots/runner/runner.log`. It must run in the GUI launchd domain: over plain ssh the login keychain is locked and cursor-agent/grok cannot read their logins.

## Limites de recurso (19/11)

- Container: 6 GB de RAM sem swap extra (`BOTS_MEM_LIMIT`), 3 CPUs (`BOTS_CPUS`), core dumps desligados. A VPS tem 15 GB e 4 núcleos; o resto fica para os outros serviços.
- Turnos: no máximo 3 ao mesmo tempo (`BOTS_MAX_TURNS`); o excedente fica na fila e a conversa mostra a posição. Voz não espera.
- Comandos de teste do modo código: um por vez, `nice 10`, 20 min de teto, 2 GB de heap por processo Node e 2 workers. Build/tsc/lint: mesmo teto, sem a trava.
- Voz: no máximo 3 processos quentes, fecham após 5 min parados.
- Chrome dos bots fecha após 10 min sem uso.
- Processos de turno levam `RUNELAY_TURN` no ambiente; turno encerrado ou cancelado mata a árvore inteira, e uma varredura por minuto mata órfãos.
- Detalhes do contrato em PROTOCOL.md (v30).
