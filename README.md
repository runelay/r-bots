<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg" />
  <img src="docs/assets/banner-light.svg" alt="runelay bots: your own team of bots" width="100%" />
</picture>

<p align="center">
  <img alt="self-hosted" src="https://img.shields.io/badge/self--hosted-docker-2496ED?style=flat-square&logo=docker&logoColor=white" />
  <img alt="Claude Agent SDK" src="https://img.shields.io/badge/engine-Claude%20Agent%20SDK-d97757?style=flat-square" />
  <img alt="Bun" src="https://img.shields.io/badge/server-bun-000000?style=flat-square&logo=bun&logoColor=white" />
  <img alt="TypeScript strict" src="https://img.shields.io/badge/typescript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="Coverage gate 99%" src="https://img.shields.io/badge/coverage%20gate-99%25%20per%20file-2ea44f?style=flat-square" />
  <img alt="macOS 15" src="https://img.shields.io/badge/app-macOS%2015%20·%20SwiftUI-111111?style=flat-square&logo=apple&logoColor=white" />
  <img alt="Tailscale" src="https://img.shields.io/badge/network-tailnet%20only-242424?style=flat-square&logo=tailscale&logoColor=white" />
</p>

<p align="center">
  A team of bots that is <b>yours</b>: each one with its own instructions, model, tools and conversations.<br />
  They run on <b>your</b> server with the Claude subscription you already pay for, and you talk to them from a native Mac app.
</p>

<p align="center">
  <a href="#-quick-start"><b>Quick start</b></a> ·
  <a href="#-install-the-mac-app"><b>Mac app</b></a> ·
  <a href="#-development"><b>Development</b></a> ·
  <a href="docs/protocol/README.md"><b>Protocol</b></a> ·
  <a href="#-security"><b>Security</b></a>
</p>

<br />

## ✨ Why

Chat apps give you one assistant that forgets which repo it was in, cannot touch your computer, and stops when the tab closes. runelay bots is the opposite: a small team that lives on your server, keeps every conversation and worktree, and works while the Mac is closed.

The server runs each turn on the **Claude Agent SDK** logged in with your Claude subscription (or on Codex, Cursor and Grok), serves the bots their tools over MCP, and pulls connectors, memory and skills from [runelay](https://runelay.com). The Mac app is where you talk to them, watch them work and approve what they want to do.

```mermaid
flowchart LR
  subgraph M[" Your Mac "]
    APP[runelay bots app]
    RUN[runner inside the app]
  end
  subgraph V[" Your server · Docker "]
    S((bots server<br/>127.0.0.1:2000))
    D[(data/)]
  end
  subgraph P[" Models "]
    CL[Claude Agent SDK]
    CX[Codex]
    CU[Cursor]
    GK[Grok]
  end
  R[runelay<br/>connectors · memory · skills]
  APP -- "HTTPS · tailnet :10447" --> S
  RUN -- "wss /runner/connect" --> S
  S --> CL & CX & CU & GK
  S --> R
  S --- D
  classDef hub fill:#f0a050,stroke:#f0a050,color:#111,font-weight:bold
  class S hub
```

## 🧩 What you get

| | |
|---|---|
| 💬 **Conversations per bot** | Every bot keeps a main thread plus as many conversations as you open, each with its own history, queue and worktree. Bots delegate to each other and work together in groups. |
| 🛠️ **Code mode** | A git worktree per conversation, a live diff while the bot edits, checkpoints you can rewind, and commit, push and PR with CI status right on the conversation. |
| 🖥️ **Computer use** | A browser per bot, a virtual desktop on the server, and your own Mac through the app, always with your approval. |
| 🎙️ **Voice calls** | Talk to a bot out loud: a warm fast model answers while the bot does the work, with ElevenLabs for speech. |
| 📄 **Artifacts and canvas** | Bots publish HTML pages and editable canvases, versioned, that you open and edit in the app. |
| 🔐 **Vault** | Secrets are called by alias. The value lives in the Mac keychain and only enters inside the tool, at the last moment. The model never sees it. |
| 🔌 **runelay connectors** | Linear, GitHub, Supabase and the rest of your runelay accounts, plus shared memory and skills, in every bot. |
| 🚦 **Permissions** | Read only, edit, default or full per conversation. Jev judges routine calls; anything risky waits for you. |
| 🔁 **Handoff between models** | A bot moves to its backup account when one hits its limit, carrying the context with it. |
| ⏰ **Routines and usage** | Scheduled prompts per bot, and a usage screen with limits, tokens and cost per provider. |

## 🚀 Quick start

### Docker (production)

The server runs in Docker on the VPS, from the repo root:

```sh
git clone https://github.com/<you>/runelay-bots.git && cd runelay-bots
docker compose up -d
```

No `.env` and no variable to set: data in `~/.local/share/runelay-bots`, backups in `~/.local/share/runelay-bots-backups`, your Claude Code, Codex, gh and supabase logins mounted from `$HOME`, the vault key created in the data dir. The container adapts to the uid of your HOME. Bots only touch repositories you allow: when you ask for work in a new repo, the bot asks with a card (`workspace_add`) and remembers what the repo is.

That builds `apps/server/Dockerfile` (Bun runtime plus the Claude Code, Codex, gh, supabase, agent-browser and `pg_dump` CLIs), starts the `runelay-bots` container on the host network at `127.0.0.1:2000` and keeps the bots in `~/.local/share/runelay-bots`, outside the code. Next to it run Postgres 17 (`127.0.0.1:5432`, data in `<data>/postgres`) and Redis 7 for the job queue (`127.0.0.1:6379`, AOF, data in `<data>/redis`); their passwords are generated on first boot into `<data>/secrets/` (mode 600) and the server reads them from there. Service keys are not files: ElevenLabs (voice), Jev (automatic approvals) and runelay (connectors, memory, skills) are pasted in the app under **Settings › Integrations**, validated on the spot and stored encrypted on the server. All three are optional; without one, that part turns off and everything else works. The runner token and the session secret are generated on first boot into the data dir. `tailscale serve` exposes the port on the tailnet at `:10447`.

```sh
docker compose logs -f --tail 200   # logs
docker compose ps                   # status and health
docker compose restart              # restarts the server, not a rebuild
curl -s 127.0.0.1:2000/status       # never restart with a bot working
```

### Bun (on the host)

```sh
bun install
cd apps/server
env -u CLAUDE_CONFIG_DIR GATEWAY_PORT=2100 BOTS_DATA_DIR=/path/to/data-copy BOTS_SCHEDULES=off \
  bun src/index.ts
```

A second instance on its own port and a copy of `data/` never touches production. The engine needs a logged-in Claude Code on the machine; `ANTHROPIC_API_KEY` is unset at boot on purpose. Env vars, a test container and the systemd rollback: [apps/server](apps/server/README.md).

## 🧪 Development

```sh
bun install          # workspaces: apps/server + packages/*
bun run dev          # server with --watch
bun run test         # bun:test, coverage gate
bun run check        # Biome: format and lint (writes fixes)
bun run typecheck    # tsc --noEmit in every workspace
```

Queue tests start their own throwaway Redis container (`redis:7.4-alpine`, random port on `127.0.0.1`), so Docker must be running.

**Tests are part of the change.** The suite is `bun:test`, with a gate of 99% lines and 99% functions per file (`coverageThreshold` in each workspace's `bunfig.toml`). New code ships with its tests in the same PR. Tests live in `src/**/__tests__/*.test.ts`, use a temporary data dir, talk only to `127.0.0.1` and run every CLI and the Agent SDK through fakes. The Swift app is outside the gate.

**The contract moves with the code.** A change to a route, event or bot tool updates [docs/protocol](docs/protocol/README.md) in the same PR.

The full rules for humans and agents (layout, testing, protocol, code style, security, git) are in [AGENTS.md](AGENTS.md).

## 🍎 Install the Mac app

The app is a SwiftPM package (macOS 15, Swift 6, no external dependencies). On the Mac:

```sh
cd ~/runelay-bots/mac
./scripts/make-app.sh
```

`make-app.sh` builds in release, signs with the local **runelay bots Local** certificate (so macOS keeps the microphone, speech and automation permissions between builds) and installs `~/Applications/RunelayBots.app`. From the server, sync the source first:

```sh
rsync -az --delete --exclude .build \
  apps/mac/ <seu-usuário>@<mac>:runelay-bots/mac/
```

Install an app that calls a new route only after the server with that route is up. Shortcuts, settings and pointing the app at another server: [apps/mac](apps/mac/README.md).

## 🗂️ Monorepo

| Path | What it is |
|---|---|
| [`apps/server`](apps/server/README.md) | Bun gateway: `src/{index,app}.ts`, `config/`, `db/` (Postgres + Drizzle), `shared/`, `modules/<domain>/{routes,services,repositories}` |
| [`apps/mac`](apps/mac/README.md) | SwiftUI app: `App/`, `Features/<domain>/`, `Common/`, `Design/`, `Networking/`, `Stores/`, `Models/` |
| `packages/providers` | Claude, Codex, Cursor and Grok adapters, process tree helpers |
| `packages/protocol` | Provider, event and turn types shared by server and providers |
| [`docs/protocol`](docs/protocol/README.md) | The verified contract, split by topic (v1 to v30) |
| `docs/research` | Notes behind design decisions |
| `data/` | Postgres and Redis data, generated secrets and local blobs; default `~/.local/share/runelay-bots`, set by `BOTS_DATA_DIR` (git-ignored) |
| `compose.yaml` | Production stack: server, Postgres, Redis, Garage and the secret bootstrap (`deploy/`) |

## 📖 Docs

- [AGENTS.md](AGENTS.md): rules for working in this repo, for people and coding agents
- [Protocol](docs/protocol/README.md): every route, event and payload, with a version → file index
- [Contract](docs/protocol/CONTRACT.md): what the app and the server promise each other
- [Server](apps/server/README.md): run, env, layout, engine and resource limits
- [Mac app](apps/mac/README.md): build, settings and shortcuts
- [Hosting](docs/hosting.md): the path to a hosted, multi-user product

## 🔒 Security

- **Nothing on the internet.** The server listens on `127.0.0.1:2000`; only `tailscale serve` reaches it, on the tailnet.
- **Accounts, not an open port.** With `BOTS_AUTH=on`, every route, stream and WebSocket (including the Mac runner and voice) needs a session or an API key; only `/health` and the auth routes are open. Auth is [better-auth](https://better-auth.com): email and password, passkeys (Touch ID through the browser), revocable sessions, bearer tokens for the app and `rbk_` API keys for the runner. The first person to open a fresh server creates the owner, once; after that new people join only by an invite from the owner. On the Mac, tokens live in a 0600 file in Application Support, sealed with AES-GCM under a key bound to that Mac and excluded from backups (no keychain prompt on every rebuild); on the server they are compared in constant time and never reach the logs, and logins are rate limited. `BETTER_AUTH_SECRET` is generated on first boot into `<data>/auth.secret` (mode 600) when missing. Details: [docs/protocol/auth.md](docs/protocol/auth.md).
- **Secrets stay out of the model.** The vault keeps values in the Mac keychain, with an optional AES-256-GCM copy on the server whose key lives outside the repo. Tools receive aliases, logs are redacted.
- **Permission modes and approvals.** Every conversation runs read only, edit, default or full. Writes outside the worktree, messages to the outside world and protected paths (`.env*`, `.ssh`, `data/`, agent configs) are denied or wait for you.
- **Your subscription, no API keys.** `ANTHROPIC_API_KEY` and friends are unset at boot; turns use the local Claude Code login.
- **Bounded.** The container is capped in memory and CPU, turns queue at three, and every process a turn starts is killed with it.

## 🗺️ Roadmap

- Break the remaining import cycle between the engine, conversations and the MCP gateway
- Bring every server module and package under the 99% coverage gate
- Measure scrolling in long conversations in fps

<br />

<p align="center">
  <img src="docs/assets/runelay-symbol.svg" alt="runelay" width="28" /><br />
  runelay bots · made by <a href="https://x.com/andersonbrdev"><b>@andersonbrdev</b></a> · <a href="https://runelay.com">runelay.com</a>
</p>
