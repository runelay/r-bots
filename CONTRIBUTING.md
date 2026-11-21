# Contributing

Thanks for helping with r/bots.

## Setup

You need [Bun](https://bun.sh) 1.4 and Docker (the tests start their own Postgres and Redis containers).

```sh
bun install
cd apps/server
env -u CLAUDE_CONFIG_DIR GATEWAY_PORT=2100 BOTS_DATA_DIR=/path/to/data-copy BOTS_SCHEDULES=off bun src/index.ts
```

Use your own port and a copy of the data dir, never a production instance. The engine needs a logged-in Claude Code on the machine; API keys are unset at boot on purpose. The Mac app builds with `swift build` inside `apps/mac` (macOS 15, Swift 6) and is formatted with `swift format -i -r -p Sources Tests Package.swift`.

## Before opening a PR

```sh
bun run check       # biome format + lint
bun run typecheck
bun run test        # bun:test with the coverage gate
```

`bun run test` starts a throwaway Postgres on `127.0.0.1:55432` (`TEST_DATABASE_URL` points elsewhere) and the queue tests start their own Redis. The gate is 99% lines and 99% functions per file: new or changed code ships with its tests, and the threshold is never lowered.

CI runs the same three steps on every pull request, plus shellcheck, CodeQL (once the repo is public) and, when `apps/mac` changes, `swift format lint --strict` and `swift build`.

## Pull requests

- One change per PR. Open an issue first for anything large.
- Branch names: `feat/...`, `fix/...`, `refactor/...`, `chore/...`, `docs/...`, `test/...`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org): `feat(server): add emoji reactions to messages`.
- A change to a route, event or bot tool updates [docs/protocol](docs/protocol/README.md) in the same PR.
- User-facing changes get a line in `CHANGELOG.md`.

The full rules for code, tests and security are in [AGENTS.md](AGENTS.md).

## Security

Never open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
