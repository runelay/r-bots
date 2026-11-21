# Changelog

## Unreleased

### Install and update

- One image, `ghcr.io/runelay/r-bots:<version>`, replaces the server, runner and box images. The role comes from the command: the server by default, the runner with `rbots-runner` as entrypoint, the box with `rbbox-init`. Layers are zstd and ordered so a release that only changes r/bots code downloads one layer of about 70 MB. Tags: `<version>`, `<major>.<minor>` and `latest` on stable. `RBOTS_IMAGE` (or the old `BOTS_IMAGE`) overrides it; `BOTS_RUNNER_IMAGE` is gone.
- The runner no longer mounts `~/.docker`. While the repo is private, the installer and `rbots update` save the GitHub token for it as `RBOTS_REGISTRY_TOKEN` in the persistent `.env.local`. Images and checksums are signed with cosign only once the repo is public.

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
