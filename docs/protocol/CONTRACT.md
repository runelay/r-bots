# r/bots: backend ↔ Mac app contract

Backend: v2 runs `apps/server/` (Claude Agent SDK); v1 was eve in `server/` (kept as fallback).
Mac app: SwiftUI in `mac/` (Swift Package, macOS 15+).

Base URL seen by the Mac: `https://<servidor>:10445` (tailscale serve → 127.0.0.1:2000). Configurable in the app settings.

## Bots

| id | name | role | accent | tools | schedule |
|---|---|---|---|---|---|
| boss | Boss | Chefe do time | indigo | delegates to the others | briefing 08:30 weekdays |
| davi | Davi | Vigia de produção | green | `prod_query` (SELECT-only, read-only) | every 30 min 08:00–22:00 |
| nina | Nina | QA e navegador | pink | `browser_*` (agent-browser) | none |

## Endpoints

### `GET /bots`
```json
[{ "id": "davi", "name": "Davi", "role": "Vigia de produção", "accent": "green",
   "sessionBasePath": "/bots/davi/eve/v1",
   "schedules": [{ "name": "watch", "cron": "*/30 8-22 * * *", "description": "..." }],
   "hasBrowser": false }]
```
If eve cannot host several root agents on one server, `sessionBasePath` may point to a different prefix or port path; the Mac must only ever use `sessionBasePath` and never hardcode it.

### eve session API (standard, under `sessionBasePath`)
- `POST {sessionBasePath}/session` with `{ "message": "<text>" }` (or whatever body eve documents) → `{ sessionId, ... }`
- `POST {sessionBasePath}/session/:sessionId` with a follow-up message or an answer to an interaction → `{ deliveryId }`
- `GET {sessionBasePath}/session/:sessionId/stream` → NDJSON events (see `.eve-docs/concepts/sessions-runs-and-streaming.md`). The Mac renders:
  - `content.completed` kind `text` phase `reply` → assistant bubble; phase `narration` → muted narration line
  - `call.requested` / `call.settled` → compact tool row (capability name, input summary, outcome)
  - `interaction.opened` → approval card with Approve / Deny, answered via the documented answer body; `interaction.settled` closes it
  - `turn.started` / `turn.settled` → bot status (working / idle)
  - `usage.recorded` → token counter
  The exact field names come from the eve docs; the backend writes the real request/response bodies it verified into `docs/protocol/`.

### `GET /bots/:id/browser`
`{ "url": "...", "title": "...", "updatedAt": "ISO", "screenshotPath": "/bots/nina/browser/latest.png" }` or 404 when the bot never opened a page.

### `GET /bots/:id/browser/latest.png`
Last screenshot taken by that bot's browser tools (taken automatically after every browser action).

### `GET /bots/:id/sessions`
`[{ "sessionId": "...", "title": "first user message, truncated", "startedAt": "ISO", "source": "chat" | "schedule" }]`, newest first. Lets the Mac list past runs, including schedule runs.

---

# v2 (19/11): Claude Agent SDK engine + bots created by the user

The eve server in `server/` is replaced by `apps/server/` (Claude Agent SDK, logged in with the user's Claude subscription via the local Claude Code credentials). The gateway stays on 127.0.0.1:2000 / https://<servidor>:10447 and keeps every v1 route and the eve-compatible session API and NDJSON event shapes already documented in `docs/protocol/`, so the Mac keeps working unchanged.

## Bot definition (stored as data, one JSON per bot)
```json
{ "id": "rafa", "name": "Rafa", "role": "Performance", "accent": "electric|teal|violet|royal|sky|indigo",
  "glyph": "auto" , "instructions": "markdown, pt-BR",
  "capabilities": { "browser": true, "prodQuery": false, "delegate": ["davi"] },
  "schedules": [{ "name": "manha", "cron": "0 9 * * 1-5", "timezone": "America/Sao_Paulo", "prompt": "..." , "description": "..." }],
  "createdAt": "ISO", "archivedAt": null, "builtIn": false }
```
`GET /bots` returns the same fields as v1 plus `instructions`, `capabilities`, `glyph`, `builtIn`, `archivedAt` (archived bots are excluded unless `?archived=1`). `hasBrowser` stays (= capabilities.browser). `sessionBasePath` stays `/bots/:id/eve/v1`.

## New routes
- `POST /bots` body `{ name, role, accent, instructions, capabilities, schedules }` → 201 with the bot. `id` is a slug of the name, unique (suffix -2, -3…). 400 `{ error, field }` on validation errors (name 1–40 chars, role ≤ 60, instructions ≤ 20k, cron valid, delegate ids exist and not self).
- `PATCH /bots/:id` partial update of the same fields → 200 with the bot. Built-in bots (boss, davi, nina) are editable too.
- `POST /bots/:id/archive` and `POST /bots/:id/unarchive` → 200 (no hard delete).
- `GET /meta` → `{ "accents": [...], "capabilities": [{ "id": "browser", "label": "Navegador", "description": "..." }, { "id": "prodQuery", ... }, { "id": "delegate", ... }], "engine": "claude-agent-sdk", "model": "..." }`.

---

# v3 (19/11): AI proxy with connected accounts

Each bot picks an **account + model**; the server routes the turn to that account. Accounts are the user's own logged-in CLIs (subscriptions), on any machine that runs a **runner**.

## Runners
- A runner is a small Node service (`runner/`) that runs on a machine, detects installed+logged-in CLIs, and executes turns headless, streaming normalized events back.
- `vps` runner: in-process in apps/server (claude via Agent SDK, codex).
- `mac` runner: the r/bots app on each Mac signed in to the account (a device). The app opens `wss://<server>/runner/connect` with its device token and runs claude, codex, grok, cursor-agent; MCP calls go back through the same connection (v38, [accounts](accounts.md)).
- Providers: `claude` (Claude Code / Agent SDK, Claude subscription), `codex` (Codex CLI, ChatGPT subscription), `grok` (Grok CLI), `cursor` (cursor-agent, Cursor subscription).

## Tools for every provider
Bot tools (browser_*, prod_query) are served by the gateway as an MCP endpoint `POST /mcp/:botId/:sessionId` (streamable HTTP, bearer token). Every provider CLI is launched with that MCP server configured and its own built-in shell/file tools disabled where the CLI allows it. Approvals happen inside the MCP tool handler (provider-agnostic): the handler emits interaction.opened on the session stream and blocks until the answer route resolves it.

## API
- `GET /accounts` → `[{ "id": "mac:claude", "runner": "mac", "provider": "claude", "label": "Claude · assinatura", "status": "ready|logged_out|offline|missing", "models": [{ "id": "...", "label": "..." }], "detail": "..." }]`
- `POST /accounts/refresh` → re-detect on all runners.
- Bot definition gains `"engine": { "account": "vps:claude", "model": "claude-sonnet-5-5", "effort": "low|medium|high" }` (PATCH-able). Default `vps:claude`.
- Session events gain `model.started.data.account` so the Mac can show which account answered.
- If the chosen account is offline/logged out, the turn fails fast with a friendly `turn.settled` error code `ACCOUNT_UNAVAILABLE` (no silent fallback).

---

# v8–v11 (19/11): runelay connectors, groups, notifications, desktop

## v8 · Connectors via runelay (partner)
- Server connects to the user's runelay MCP (same endpoint/credentials the user's Claude Code uses; never log the token).
- `GET /connectors` → `[{ "name": "linear_server", "label": "Linear", "icon": "linear|<url>", "status": "ok|needs_auth|error", "toolCount": 84, "reconnectUrl": "..." }]` (from runelay list_connections). `POST /connectors/refresh`.
- Bot gains `connectors: { allowed: ["linear_server", ...], memory: true }` (PATCH-able; default for new bots: none, memory true). Self-config tool `request_connector(name, reason)` → always human approval.
- Bot MCP tools: `connector_search(query)` (runelay search_tools filtered to allowed connections), `connector_call(tool, args)`, plus `memory_search`, `memory_read`, `memory_write`, `skill_read` when memory=true.
- Gate: read-only calls pass; any write/side-effect call (create/update/delete/send/post/merge/deploy, or anything Jev scores risky) → Jev + human approval card; anything that sends a message outside (email, Slack, Linear comment) is ALWAYS human.
- Event: `call.*` with `capability: "connector:<name>.<tool>"` so the Mac shows the service logo.

## v9 · Groups (multi-bot conversations)
- `POST /groups {name, members: [botId...]}` → `{id, name, members, thread}`; `GET /groups`; `PATCH /groups/:id {name, members}`; `POST /groups/:id/archive`. Group has one thread (same session/events API under `sessionBasePath` `/groups/:id/eve/v1`).
- Each user message: if it @mentions bots, they answer in order; otherwise Jev chooses who answers (choice question over members with their roles + recent context), logged as `decision.made {kind:"route"}`. A bot may hand off to another member (`handoff(botId, note)` tool); max 4 bot turns per user message.
- Every bot reply event carries `data.botId` so the Mac shows per-bot bubbles/characters. Groups appear in `/bots`-like sidebar data: `GET /groups` includes `thread {lastMessage, unread, total}`.

## v10 · Notifications
- Server emits nothing new; the Mac app (now a real .app) posts local notifications (UNUserNotificationCenter) for: bot reply while app not focused or bot not visible, approval needed, routine with non-quiet result, turn failed. Click opens the conversation. Settings toggle.

## v11 · Desktop (bot computer)
- Optional per bot `capabilities.desktop`. Server runs a virtual desktop per bot (Xvfb + lightweight WM + headed Chromium + terminal) as an unprivileged user, streamed on the same live WebSocket protocol as the browser at `/bots/:id/desktop/live` (frames + mouse/key input + control mode).
- Bot tools: `desktop_screenshot`, `desktop_click(x,y)`, `desktop_type(text)`, `desktop_key(combo)`, `desktop_scroll`. Typing/keys and any terminal use → Jev + human approval; no sudo, no host filesystem outside the desktop user's home.

---

# v12 (19/11): Computer use on the user's Mac

Goal: bots operate the user's real Mac: sites, apps, files/folders, Mail, building apps in a workspace, recording demos. (v11 desktop on the VPS stays for sandboxed work.)

## Where actions execute
- Inside the **rbots.app** (it holds the macOS permissions: Accessibility, Screen Recording, Automation, Files). The app exposes a local executor `http://127.0.0.1:4791` (bearer token stored in the app's Application Support and shared with the Mac runner via a file chmod 600). Only works while the app is running; otherwise tools return `COMPUTER_UNAVAILABLE`.
- Mac runner (`runner/`) proxies tool calls from the VPS server to that executor. Server exposes them as bot MCP tools when `capabilities.computer` is on.

## Tools (all via the executor)
- Observe: `computer_screenshot({display?, region?})` (downscaled PNG/JPEG + scale), `computer_ui_tree({app?})` (Accessibility tree: role, title, value, frame, id; preferred over pixels), `computer_apps()` (running apps, frontmost), `computer_windows()`.
- Act: `computer_click({x,y}|{elementId})`, `computer_type(text)`, `computer_key(combo)`, `computer_scroll`, `computer_drag`, `computer_open({app?|url?|path?})`, `computer_applescript(script)` (for Mail/Finder/Safari automation).
- Files (only inside allowed roots, default ~/Desktop ~/Downloads ~/Documents, configurable): `files_list`, `files_read` (text, small), `files_move`, `files_rename`, `files_mkdir`, `files_trash` (move to Trash, never rm), `files_write` (only inside ~/runelay-bots-workspace by default).
- Build: `shell_run({cmd, cwd})` only with cwd inside ~/runelay-bots-workspace; allowlist (npm/pnpm/bun/node/swift/xcodebuild/git status|diff|add|commit local/ls/cat/mkdir) runs after Jev check; anything else → human approval; never sudo, never outside workspace.
- Record: `record_start({display|window|region, audio?: false})` → ScreenCaptureKit recording to ~/Movies/runelay bots/<bot>-<date>.mov; `record_stop()` → path; `record_status()`.
## Safety
- Every act/file/shell tool passes the Jev + human gate (same events). Always human: sending email/messages, deleting (trash) more than 10 items or anything outside allowed roots, typing into password fields (AX secure text), any purchase/payment UI, shell outside allowlist.
- While a bot uses the computer the app shows a floating HUD (glass pill, always on top): bot character + "Nina está usando o computador" + current action + **Parar** (also global hotkey ⌃⌥⌘.), which aborts the turn and releases control. User input (mouse/keyboard) during bot control pauses the bot ("você assumiu").
- Executor events streamed to the session: `computer.action {tool, summary, screenshotPath?}`.
