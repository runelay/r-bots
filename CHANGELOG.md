# Changelog

## Unreleased

### Tests

- `test_playwright` and `test_maestro` find a spec given relative to the task's worktree. Before, a path like `.prints/home.spec.ts` resolved against the server's own folder and failed with "Esse caminho não está num repositório liberado".

## v0.1.15

### Boxes

- Images you paste or attach reach the model again when the bot runs in a box. The box now mounts the bot's uploads folder read-only. Before, the agent inside the box could not read the image, dropped it without a word, and the bot answered that it could not see it.

## v0.1.14

### Releases

- The image is no longer signed with cosign, so a release stops adding a `sha256-<digest>` version to the GHCR package. `SHA256SUMS` stays signed, and the image digest is in the release notes.

## v0.1.13

### Your Mac

- Bots ask far less often before running a command on your Mac. Reads (ls, cat, grep, rg, sed -n, find, git status/diff/log, screencapture) run straight away, pipes and quotes included. Other commands go to Jev, run directly in Acesso total, and "allow until the end of the task" now covers them. Only risky commands always ask: sudo, rm -r/-f, git push, curl sending data, ssh, a shell inside a shell, $(…) and credential paths.

### Updates

- The server checks GitHub for a new release every 10 minutes instead of every 6 hours, so Versões offers the update soon after it is published.

## v0.1.12

### Boxes

- Two conversations with the same bot no longer fail with "A caixa deste bot está ocupada com outras montagens." Every conversation of a bot mounts the bot's work folder, so they share one box. A turn that needs other mounts (another code workspace) waits for the box to free up instead of failing.

## v0.1.11

### Brand

- New r/bots icon: a light "r" with an orange slash, so the app no longer looks like runelay in the Dock. It replaces the shared mark in the Mac and iPhone app icons, the in-app logo, the device sign-in page, the README banners and the hero screenshot.

## v0.1.10

### Releases

- A release is one run of the `release` workflow with the version: it bumps every package, the `bun.lock` and the iPhone app, moves these notes under the version, commits, tags and publishes. The GitHub release notes are now this CHANGELOG section.

### Security

- Route errors that are not an `Error` answer "Erro interno." instead of the raw value (code scanning `js/stack-trace-exposure`).

## v0.1.9

### Mac

- Links in conversations open in the side panel browser, with back, forward, reload and Open in browser. ⌘-click still opens your default browser.

### Security

- Fixed code-scanning findings: a voice hang-up regex that could backtrack exponentially (ReDoS), double decoding of HTML entities in exports, size checks that raced with the read in the code workspace, `export_create` staging files in a shared `/tmp` folder (now in the bot's data folder, 0700/0600, removed after sending), `nice` passed into a shell string, and the runner heartbeat file following symlinks.

## v0.1.8

### Server and Mac

- Update the server from the Mac app (Settings › Versions): the server queues the update and `rbots update-agent` (systemd watcher) applies it on the host.

### iPhone

- The r/bots mark sits left of the server switcher, and search and shortcuts are two round buttons at the bottom right; search opens as a capsule.
- `install-device.sh` finds the paired iPhone again (the id came with a "(UDID)" suffix).

### Fixes

- New conversations on a box no longer fail with "permission denied": the server creates the conversation folder before the box starts. Before, Docker created it as root and the bot could not write to it.
- Pasting an image or file with ⌘V in the Mac composer attaches it to the conversation you are typing in. Before, another open tab or side thread could take it, or nothing happened.

## v0.1.7

### iPhone

- The bot list works like the Mac sidebar: sections (Fixados, your sections, Todos), conversations as a tree with sub-threads that collapse, provider logo and state on each conversation, server-side search, the r/bots mark next to the title and a shortcuts button at the bottom right.
- Server profiles get the Mac default names (Principal, Local, VPS) instead of the raw host, and name, address, color and icon can be edited.

### Docs

- The README hero shows the iPhone app next to the Mac app, with a step-by-step to install it.

### Fixes

- The update notice works with a private release repo: without `RBOTS_GITHUB_TOKEN`, the server checks GitHub with its `gh` login. Before, GitHub answered 404 and the app never offered the update.

## v0.1.6

### iPhone

- New iPhone app (`apps/ios`, built with XcodeGen on top of the Mac sources): conversations, server switcher at the leading edge with the server name, settings tiles and shortcuts.

### Fixes

- A new session that opens the same repo for the same task takes over the worktree a previous session left with pending work (uncommitted files or unpushed commits), as long as no other session has it open. Before, it opened an empty `-2` worktree from the base branch, the box could not see the earlier work, and the bot went looking for it elsewhere.

## v0.1.5

### Fixes

- Boxes also mount the folders an account links to outside itself (like `~/.claude-2/projects` pointing to `~/.claude/projects`). Before, Claude saved those sessions inside the box and lost them whenever the box was recreated (update, new worktree), and the next turn failed with "No conversation found with session ID".
- The Mac app shows its real version (from the bundle, stamped from the root `package.json` by `make-app.sh`) instead of a fixed 0.5.0.

## v0.1.4

### Voice

- Bots generate spoken audio with the new `speech_create` tool: the ElevenLabs key saved in Settings › Integrations makes an MP3 with the bot's voice, attached to the conversation with a player. The key never reaches the model, and the generated audio is not transcribed again.

## v0.1.3

### Jobs

- The job queue runs on BullMQ 6.7.8 with ioredis 6. Jobs and schedules already in Redis keep working after the update.

## v0.1.2

### Fixes

- Turns in a box on the default Claude or Codex account now find the account folder, so conversations started before the boxes keep resuming instead of failing with "No conversation found with session ID".

## v0.1.1

### Install and update

- One image, `ghcr.io/runelay/r-bots:<version>`, replaces the server, runner and box images. The role comes from the command: the server by default, the runner with `rbots-runner` as entrypoint, the box with `rbbox-init`. Layers are zstd and ordered so a release that only changes r/bots code downloads one layer of about 15 MB. The whole image is about 940 MB compressed, down from about 2.9 GB for the three images of v0.1.0. Tags: `<version>`, `<major>.<minor>` and `latest` on stable. `RBOTS_IMAGE` (or the old `BOTS_IMAGE`) overrides it; `BOTS_RUNNER_IMAGE` is gone.
- The runner no longer mounts `~/.docker`. While the repo is private, the installer and `rbots update` save the GitHub token for it as `RBOTS_REGISTRY_TOKEN` in the persistent `.env.local`. Images and checksums are signed with cosign only once the repo is public.
- Chrome and the image cutout model left the image: they download on first use into `~/.local/share/runelay-bots-tools`, mounted at `/opt/rbots-tools` in the server and read only in the boxes.
- The server and the runner run as Bun bundles with bytecode instead of compiled binaries.
- The runner pulls the box image itself, recreates idle boxes built from an older image and removes old boxes and images.

### Project

- MIT license, contributing guide, security policy, issue and PR templates, Dependabot, and CI with Biome, typecheck, tests, shellcheck, hadolint, actionlint, CodeQL (once public) and swift-format.

## v0.1.0

### Install and update

- One command installs r/bots from the latest GitHub Release: `install.sh` downloads `r-bots-<version>.tar.gz`, checks it against `SHA256SUMS`, pulls the prebuilt server, runner and box images from GHCR and waits for `/health`. Nothing is built on your machine. Running it again is safe.
- Releases come in two channels, `stable` and `beta` (pre-releases). `RBOTS_CHANNEL` and `RBOTS_VERSION` pick one. Every image ships with an SBOM and provenance and is signed with cosign, and so is `SHA256SUMS`.
- The `rbots` CLI handles the day to day: `status`, `logs`, `version`, `start`, `stop` and `update`. `rbots update` refuses while a turn is running, backs up the database first, pulls the new images while the old version keeps running and rolls back if `/health` does not answer within 180 s.
- The server has a `backup` command that writes a database snapshot, used by `rbots update`.

### Boxes per bot

- With `BOTS_SANDBOX=docker`, each bot turn runs in its own container with a memory and CPU cap, so a heavy bot no longer takes the others down. The box uses gVisor or Kata when the machine has them, and runc otherwise. The installer turns it on, and `--harden` installs the stronger runtime.
- A runner (`packages/runner`) connects to `/runner/connect`, announces what it has and starts the boxes through the Docker API.
- The server exposes `/metrics` in the Prometheus format, and `--observability` starts cAdvisor, Prometheus and Grafana next to it.

### CLIs and versions

- The server manages the Claude Code and Codex CLI versions the bots run on: it lists the installed and the latest version, updates to a chosen version and rolls back.
- The server checks GitHub Releases for a newer r/bots version on its channel.
- The Mac app has a Versions screen in Settings: the server version with the new release's notes and the command to update, and each CLI with Update and Roll back. A button in the window shows when a new release is out.

### Conversations

- Messages take emoji reactions, from you in the app and from the bots through a tool.
