# AGENTS.md

Rules for any agent working in this repo. Read this before changing code.

runelay bots is a self-hosted team of bots: a TypeScript server (Bun) that runs each turn on the Claude Agent SDK (or Codex, Cursor, Grok), serves bot tools over MCP and pulls connectors, memory and skills from runelay; and a native SwiftUI Mac app that talks to it.

## Repo map

| Path | What lives there |
|---|---|
| `apps/server/src/index.ts` | Boot: load data, timers, signals, `listen` |
| `apps/server/src/app.ts` | Central router (path → module route) and WebSocket upgrades |
| `apps/server/src/config/env.ts`, `config/storage.ts` | Port, host, model, data dir, SQLite file, blob driver (S3 or filesystem) |
| `apps/server/src/db/` | SQLite client (Drizzle), schema, migrations, settings table, legacy JSON import |
| `apps/server/src/shared/` | HTTP helpers, `ValidationError`, JSON file store, secret redaction (`redact.ts`) |
| `apps/server/src/modules/<domain>/` | One folder per domain: `routes/` (HTTP handlers), `services/` (logic and stores), `repositories/`, `types/`, `constants/` only where needed |
| `apps/server/bin/rb-secret-run.mjs` | Bash helper that injects vault secrets into a command and masks them in its output |
| `apps/server/Dockerfile`, `apps/server/start.sh` | Production image and entrypoint |
| `apps/server/test/` | Shared test helpers: `setup.ts`, fakes (`fake-providers`, `fake-process`, `fake-runelay`, `fake-s3`) and helpers per area (`engine-`, `engine-turn-`, `browser-`, `code-`, `media-`, `voice-`, `usage-helpers`) |
| `apps/mac/` | SwiftUI app (SwiftPM, macOS 15, Swift 6): `Sources/RunelayBots/{App,Common,Design,Features/<domain>,Models,Networking,Stores,Support,Resources}` |
| `apps/mac/scripts/` | `make-app.sh` (package, sign, install), `render-icon.swift`, `voice-e2e/` |
| `packages/protocol/` | Provider, event and turn types shared by server and providers |
| `packages/providers/` | Claude, Codex, Cursor and Grok adapters; process helpers (`proc.ts`, `proc-tree.ts`) |
| `docs/protocol/` | The verified HTTP/WS contract, one file per topic |
| `docs/research/` | Notes behind design decisions |
| `data/` (`BOTS_DATA_DIR`, default `~/.local/share/runelay-bots`) | Runtime state: the SQLite database `runelay-bots.db`, blobs (uploads, artifacts) when `BLOB_DRIVER=fs`, workspaces. Git-ignored, never commit, never edit by hand from code changes |
| `compose.yaml`, `deploy/` | Production stack: server, Postgres, Redis, Garage; `deploy/secrets` generates the Postgres and Redis passwords into `<data>/secrets/` |

Server domains: `accounts`, `agenda`, `approvals`, `artifacts`, `auth`, `blocks`, `bots`, `browser`, `canvas`, `code`, `computer`, `connectors`, `conversations`, `engine`, `exports`, `groups`, `integrations`, `jobs`, `memory`, `notes`, `schedules`, `sections`, `sheets`, `skills`, `status`, `storage`, `uploads`, `usage`, `vault`, `voice`. Persistence goes through the domain's `repositories/` on the SQLite database; files go through the blob store in `storage`. Put new code in the domain that owns it; create a new module only for a new domain.

## Commands

Bun workspaces: `apps/server`, `packages/*`. Run from the repo root unless noted.

```sh
bun install                 # install workspace dependencies (bun.lock)
bun run dev                 # server with --watch
bun run start               # server once
bun run test                # bun:test in every TS workspace, with the coverage gate
bun run check               # Biome format + lint, writes fixes
bun run lint                # Biome lint only
bun run typecheck           # tsc --noEmit in every workspace
```

Never point a dev server at production data or port. Use a second instance:

```sh
cd apps/server
env -u CLAUDE_CONFIG_DIR GATEWAY_PORT=2100 BOTS_DATA_DIR=/path/to/data-copy BOTS_SCHEDULES=off bun src/index.ts
```

Production (Docker, repo root):

```sh
docker compose up -d --build        # rebuild after changing apps/server or packages
docker compose restart              # picks up .env.local, not code
docker compose logs -f --tail 200
docker compose ps
curl -s 127.0.0.1:2000/status       # check before any restart
```

Never restart or rebuild while a bot is working: check `GET /status` first.

Mac app (on the Mac, inside `apps/mac`):

```sh
swift build                 # debug build
swift run                   # run from the terminal
./scripts/make-app.sh       # release build, icon, sign with "runelay bots Local", install ~/Applications/RunelayBots.app
```

## Testing (hard rule)

- Runner: `bun:test`. Import `describe`, `test`, `expect`, `mock` from `"bun:test"`. No Jest, no Vitest.
- Gate: 99% lines and 99% functions **per file**, set by `coverageThreshold` in each TS workspace's `bunfig.toml`. `bun run test` at the root fails below it. Do not lower the threshold, and do not exclude files to pass it.
- New or changed code ships with its tests in the same PR. A PR that drops a file below the gate is not done.
- Tests live next to the code in `src/**/__tests__/*.test.ts`. Shared helpers and fakes live in `apps/server/test/`; reuse them before writing a new one.
- `apps/server/test/setup.ts` points `BOTS_DATA_DIR` at a temporary directory. Tests never read or write the real `data/`, `~/.claude`, `~/.codex` or `.env.local`.
- Redis: queue tests start their own container with `startTestJobs()` (`test/jobs-helpers.ts`) or `startRedis()` (`test/redis.ts`) and stop it in `afterAll`. Never point a test at the production Redis.
- Network: `127.0.0.1` only. Start local servers on an ephemeral port. No calls to runelay, ElevenLabs, GitHub, model APIs or any external host.
- Never run a real CLI (`claude`, `codex`, `cursor-agent`, `grok`, `gh`, `git` against real repos, `agent-browser`, `supabase`) or the real Claude Agent SDK. Use the fakes.
- Leave no live process: every server, child process, timer and interval a test starts is stopped in the test or its `afterEach`/`afterAll`.
- No fixed sleeps. Wait on an event, a promise or a condition; control time with fake timers where needed.
- Test behavior: inputs, outputs, HTTP status and body, emitted events, files written. Never a test without a meaningful assertion just to color a line.
- The Swift app is outside the gate and outside `bun test`.

## Protocol

`docs/protocol/` is the contract between server and app. Any change to a route, request/response body, WebSocket message, stream event or bot tool updates it in the same PR:

- Add a section `## vN (dd/mm): <subject>` at the end of the topic file it belongs to (`bots.md`, `conversations.md`, `events.md`, `code.md`, ...), with the routes, bodies and a `### Verificado` block captured from the running server. Bodies are captured, never invented.
- Add the version row to the "Versão → arquivo" table in `docs/protocol/README.md`.
- Since v21 these files are written in pt-BR; keep that.
- The app uses only paths the server reports (for example `sessionBasePath`); never make it hardcode one.
- Ship the server first. Install an app build that calls a new route only after the server with that route is up.

## Code

- No comments in code.
- Identifiers in English. User-facing strings in the app and bot prompts are pt-BR.
- Biome owns formatting and lint (2 spaces, double quotes, semicolons, trailing commas, line width 120, organized imports). Run `bun run check`; never hand-format against it.
- TypeScript strict (`tsconfig.base.json`). No `any` (`noExplicitAny` is an error); type unknown input and narrow it. `import type` for types (`useImportType`), `node:` prefix for built-ins (`useNodejsImportProtocol`). No unused imports or variables. Avoid non-null assertions.
- Routes stay thin: HTTP in `routes/`, logic in `services/`. Invalid input throws `ValidationError` (`src/shared/errors.ts`); `src/shared/http.ts` turns it into a 400.
- Shared types between server and providers go in `packages/protocol`, not duplicated.
- Do not add a dependency when Bun or Node built-ins cover it.
- Work that must survive a restart (turns, routines, exports, retries of external calls) goes through `modules/jobs`: `defineJob` at module load, then `enqueue`, `runJob` or `schedule`. No fire-and-forget promise or in-memory cron for it. A job that must exist only if a database write commits is written with `enqueueInTx(tx, job)` in the same transaction; the outbox relay publishes it.

## Security

- Never log, return or write a secret. Console output is redacted by `installConsoleRedaction()` from `src/shared/redact.ts`; any secret value the server handles must be registered there (`rememberSecretValue`) before it can appear anywhere. Never print tokens from `.env.local` (`RUNNER_TOKEN`, `RUNELAY_MCP_TOKEN`, `JEV_API_KEY`, `ELEVENLABS_API_KEY`, ...).
- Vault: tools and the model get aliases only. Values live in the Mac keychain, with an optional AES-256-GCM copy on the server whose key (`VAULT_KEY_FILE`) lives outside the repo. Secrets reach a command only through `bin/rb-secret-run.mjs`.
- `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are deleted at boot (`src/index.ts`), and `start.sh` also unsets `OPENAI_API_KEY`, `CURSOR_API_KEY`, `XAI_API_KEY`. This is deliberate: turns run on the logged-in subscriptions. Do not reintroduce API keys.
- The server listens on `127.0.0.1` (`GATEWAY_HOST`) and is reached only through `tailscale serve` on the tailnet (`:10447`). Never bind `0.0.0.0` or expose a port publicly.
- Bot sessions load nothing from `~/.claude` (`settingSources: []`, `strictMcpConfig: true`). Keep it that way.
- Never commit `.env*`, `data/`, keys or tokens.

## Mac app

- SwiftUI, macOS 15, Swift 6 language mode, no external dependencies. Not part of `bun test` or the coverage gate.
- Colors come from `Design/Theme.swift` tokens (light and dark per token). No raw color literals in features.
- Motion uses `Design/Motion.swift`: the single `Motion.spring`, with the `reduceMotion` fallback.
- Prefer the `Design/TypeScale.swift` fonts and `Design/Glass.swift` surfaces over ad hoc values.
- Stores are `@Observable` and `@MainActor`. Networking goes through `Networking/` (`BotsClient` for REST, `SessionStream` for NDJSON).
- One folder per domain under `Features/`.

## Git

- Conventional commits in English, imperative, short subject: `feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert(scope)?: subject`. Scopes in use: `server`, `mac`.
- Branches: `feat/`, `fix/`, `refactor/`, `chore/`, `docs/`, `test/` + subject.
- Never commit secrets, `data/` or build output (`.build/`, `node_modules/`).
