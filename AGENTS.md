# AGENTS.md

Rules for any agent working in this repo. Read this before changing code.

r/bots is a self-hosted team of bots: a TypeScript server (Bun) that runs each turn on the Claude Agent SDK (or Codex, Cursor, Grok), serves bot tools over MCP and pulls connectors, memory and skills from runelay; and a native SwiftUI Mac app that talks to it.

## Repo map

| Path | What lives there |
|---|---|
| `apps/server/src/index.ts`, `boot.ts`, `backup-command.ts` | Entry: `import "reflect-metadata"` first, then the `backup` subcommand or `boot.ts` (load data, timers, signals, `listen`). Keep side effects out of `index.ts` imports |
| `apps/server/src/app.ts` | Central router (path → module route) and WebSocket upgrades |
| `apps/server/src/config/env.ts`, `config/storage.ts` | Port, host, model, data dir, database URL (`config/database.ts`), blob driver (S3 or filesystem) |
| `apps/server/src/db/` | Postgres client (Bun.SQL + Drizzle), schema, migrations, settings table, text search helpers, SQLite import |
| `apps/server/src/shared/` | HTTP helpers, `ValidationError`, JSON file store, secret redaction (`redact.ts`) |
| `apps/server/src/modules/<domain>/` | One folder per domain: `routes/` (HTTP handlers), `services/` (logic and stores), `repositories/`, `types/`, `constants/` only where needed |
| `apps/server/bin/rb-secret-run.mjs` | Bash helper that injects vault secrets into a command and masks them in its output |
| `Dockerfile`, `apps/server/docker-entrypoint.sh` | The single production image `ghcr.io/runelay/r-bots` (server, runner and box roles) and the server entrypoint. Conventions in `docs/architecture/docker.md` |
| `packages/runner/` | Runner (connects to `/runner/connect`, starts one box per bot through the Docker API, pulls the box image, cleans up) and the `box-agent` that runs a turn inside a box |
| `infra/docker/` | `install.sh` (one-command install, release or checkout mode) and `rbots` (status, logs, version, update, start, stop); `install.sh` at the root downloads a release and calls it |
| `infra/hetzner/` | OpenTofu for a VPS that runs the same installer |
| `scripts/release/` | `render-compose.ts` (release compose without `build:`) and `pack.sh` (tarball and `SHA256SUMS`) |
| `.github/` | CI (`ci.yml`, `docker.yml`, `mac.yml`, `codeql.yml`, `infra.yml`), `release.yml`, Dependabot, issue and PR templates |
| `docs/architecture/` | Design of boxes (`ambientes.md`), releases (`releases.md`), Docker (`docker.md`) and provider sessions/CLIs (`sessoes-provider.md`) |
| `apps/server/test/` | Shared test helpers: `setup.ts`, fakes (`fake-providers`, `fake-process`, `fake-runelay`, `fake-s3`) and helpers per area (`engine-`, `engine-turn-`, `browser-`, `code-`, `media-`, `voice-`, `usage-helpers`) |
| `apps/mac/` | SwiftUI app (SwiftPM, macOS 15, Swift 6): `Sources/RunelayBots/{App,Common,Design,Features/<domain>,Models,Networking,Stores,Support,Resources}` |
| `apps/mac/scripts/` | `make-app.sh` (package, sign, install), `render-icon.swift`, `voice-e2e/` |
| `packages/protocol/` | Provider, event and turn types shared by server and providers |
| `packages/providers/` | Claude, Codex, Cursor and Grok adapters; process helpers (`proc.ts`, `proc-tree.ts`) |
| `docs/protocol/` | The verified HTTP/WS contract, one file per topic |
| `docs/research/` | Notes behind design decisions |
| `data/` (`BOTS_DATA_DIR`, default `~/.local/share/runelay-bots`) | Runtime state: Postgres and Redis data, generated secrets, blobs (uploads, artifacts) when `BLOB_DRIVER=fs`, workspaces. Git-ignored, never commit, never edit by hand from code changes |
| `compose.yaml`, `deploy/` | Production stack: server, Postgres, Redis, Garage, the runner (profile `sandbox`) and cAdvisor/Prometheus/Grafana (profile `observability`); `deploy/secrets` generates the passwords into `<data>/secrets/` |
| `/data/clis` (`<data>/clis`) | Claude Code and Codex versions installed by the server (`modules/providers`), one folder per version with `current`/`previous` links; mounted read only in the boxes |
| `/opt/rbots-tools` (`~/.local/share/runelay-bots-tools`) | Chrome and the image cutout, downloaded on first use (`modules/tools`); world readable, nothing sensitive, read only in the boxes |

Server domains: one folder each under `apps/server/src/modules/` (`ls` it; the list grows). Recent ones: `environments` (runners, boxes, placement), `providers` (managed CLI versions), `server-version` (GitHub release check), `tools` (Chrome and cutout on demand). Persistence goes through the domain's `repositories/` on the Postgres database; files go through the blob store in `storage`. Put new code in the domain that owns it; create a new module only for a new domain.

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

Production. Installed from a release (`~/.local/share/runelay-bots-app/current`), use `rbots`:

```sh
rbots status                        # containers, running turns, boxes
rbots update [--check|--to vX]      # backup, pull, switch, roll back if /health fails
rbots logs [server|runner|...]
```

From a checkout (repo root), the same stack builds locally:

```sh
docker compose --env-file .env.local --profile sandbox up -d --build --remove-orphans
docker compose logs -f --tail 200
docker compose ps
curl -s -H "Authorization: Bearer $(cat ~/.local/share/runelay-bots/runner.token)" 127.0.0.1:2000/status  # check before any restart
```

Never restart or rebuild while a bot is working: check `GET /status` first (it needs the runner token since v38; the file `<data>/runner.token` is rewritten with a new token at every boot since v51).

Mac app (on the Mac, inside `apps/mac`):

```sh
swift build                 # debug build
swift format -i -r -p Sources Tests Package.swift  # format with .swift-format (CI lints it with --strict)
swift run                   # run from the terminal
./scripts/make-app.sh       # release build, icon, sign with "runelay bots Local", install ~/Applications/rbots.app; version from the root package.json (or VERSION=x.y.z when copied alone)
```

## CI and releases

- CI on every PR and push to main: Biome, typecheck, tests with the coverage gate (`ci.yml`), shellcheck, hadolint, actionlint, `docker compose config` and an image build (`docker.yml`), swift-format and `swift build` when `apps/mac/**` changes (`mac.yml`), CodeQL once the repo is public (`codeql.yml`). Keep all of them green; fix the cause, never disable a rule or a check to pass.
- Locally, run the test files you touched (`bun test <file>`); CI runs the whole suite.
- Actions are pinned by commit SHA with the version in a trailing comment (the only comment allowed). Permissions minimal per job.
- Release: run the `release` workflow with `vX.Y.Z`. It runs `scripts/release/bump.ts` (every workspace `package.json`, the `bun.lock` workspace versions, the iPhone app version, and `## Unreleased` in `CHANGELOG.md` moved under `## vX.Y.Z`), commits `chore(release): vX.Y.Z` to main, tags it, builds, scans and tags the image and publishes the release with that CHANGELOG section as its notes. Never bump or tag by hand; an empty `## Unreleased` fails the run. A suffix (`-beta.1`) is a pre-release. Details in `docs/architecture/releases.md`.
- User-facing changes get a line under `## Unreleased` in `CHANGELOG.md` in the same PR.
- Migrations are additive within a release: `rbots update` can roll the containers back, but never the database. Drop or rename a column only in a later release than the one that stopped using it.

## Docker

- One image for every role. Never add a second image or a fake service to build one; a new role is a command or entrypoint on the same image.
- Pin base images by tag and digest, every downloaded binary by version and sha256 in an `ARG`, apt with `--no-install-recommends`. hadolint must pass with `.github/hadolint.yaml`.
- Layer order follows change rate: system and third-party tools first, r/bots bundles last, so a code-only release downloads one small layer. Server and runner ship as Bun bundles (`bun build --target=bun --bytecode`), not compiled binaries.
- Heavy or rarely used tools do not go in the image: download them on first use through `modules/tools` (or `modules/providers` for CLIs).
- Only the runner gets the Docker socket. Boxes run with no capabilities, no socket, no `$HOME`, capped memory, CPU and pids, and mount only the paths in their `BoxSpec`, at the same path the server sees.
- Every long-running service in `compose.yaml` has a healthcheck, memory/CPU/pids limits, log rotation and `no-new-privileges` (the server is the documented exception: it needs sudo internally).
- Nothing personal in the repo: no names, `/home/<user>`, IPs, tailnet names or e-mails. Use `${HOME}` and placeholders.

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
- Test files of one workspace share a process: reset module state you change (singletons, listeners, rate limits, installed console hooks) and give requests their own client IP when the auth rate limit is involved.
- Never read the real home directory (`~/.agent-browser`, `~/.claude*`, `~/.codex`) or depend on what the CI machine has installed (pnpm, browsers); fake `homedir`, `findBinary` and the process runner.
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

- Never log, return or write a secret. Console output is redacted by `installConsoleRedaction()` from `src/shared/redact.ts`; any secret value the server handles must be registered there (`rememberSecretValue`) before it can appear anywhere. Never print generated secrets from `<data>/secrets/`, `<data>/auth.secret`, `<data>/runner.token` or integration keys.
- Vault: tools and the model get aliases only. Values live in the Mac keychain, with an optional AES-256-GCM copy on the server whose key (`VAULT_KEY_FILE`) lives outside the repo. Secrets reach a command only through `bin/rb-secret-run.mjs`.
- `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are deleted at boot (`src/index.ts`), together with `OPENAI_API_KEY`, `CURSOR_API_KEY`, `XAI_API_KEY`. This is deliberate: turns run on the logged-in subscriptions. Do not reintroduce API keys.
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

- Conventional commits in English, imperative, short subject: `feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert(scope)?: subject`. Scopes in use: `server`, `mac`, `runner`, `providers`, `sandbox`, `infra`, `docker`.
- Branches: `feat/`, `fix/`, `refactor/`, `chore/`, `docs/`, `test/` + subject.
- Never commit secrets, `data/` or build output (`.build/`, `node_modules/`).
- The project is MIT (`LICENSE`); contribution rules in `CONTRIBUTING.md`, vulnerability reports in `SECURITY.md`.
