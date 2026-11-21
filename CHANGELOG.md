# Changelog

## Unreleased

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
