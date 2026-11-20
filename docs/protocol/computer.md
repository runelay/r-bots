# Navegador, computador virtual e Mac

## runelay bots: verified protocol

### Custom routes

#### `GET /bots/:id/browser`

200:
```json
{"url":"https://example.com/","title":"Example Domain","updatedAt":"2026-11-19T12:18:22.831Z","screenshotPath":"/bots/lia/browser/latest.png"}
```
404 when the bot never opened a page:
```json
{"ok":false,"error":"Essa bot ainda não abriu nenhuma página."}
```

#### `GET /bots/:id/browser/latest.png`

200 `image/png`, `cache-control: no-store`, `last-modified` set. 404 JSON `{"ok":false,"error":"Nenhum print ainda."}`. Updated after every browser tool call (open, snapshot, click, fill, screenshot). Poll it when a `call.settled` for a `browser_*` capability arrives, or when `updatedAt` from `/browser` changes.

## v3 (19/11): AI proxy with connected accounts

### Live browser view

#### `POST /bots/:id/browser/open` → 200

```json
{"url":"https://example.com"}
```
→ `{"url":"https://example.com/","title":"Example Domain","updatedAt":"2026-11-19T13:26:08.948Z","screenshotPath":"/bots/lia/browser/latest.png"}`. No model turn. `400 {"ok":false,"error":"Use uma URL http ou https.","field":"url"}`; `409 {"ok":false,"code":"no_browser","error":"Esse bot não tem navegador."}`; `502` if agent-browser fails.

While a turn runs for a bot with `capabilities.browser` (or one of its delegates) that has a page open, the server refreshes `latest.png` and `/browser` state about once per second (skipped while one is in flight), and stops when the turn ends. Every browser action still saves its own print. Poll `/bots/:id/browser` (`updatedAt`) and the PNG at ~1 s during a turn.

### Browser behavior (19/11)

- Every bot browser session uses a desktop viewport of 1280×800, set before the first action and again on every open. `latest.png` is a 1280×800 viewport screenshot.
- `GET /bots/:id/browser/full.png` takes a full-page screenshot on demand and returns `200 image/png` (captured 1265×843 on example.com), `404 {"ok":false,"error":"Nenhum print ainda."}` when the bot never opened a page, `502` if agent-browser fails.
- Click and fill scroll the element into view first, wait 500 ms and then for `document.readyState === "complete"`, and only then take the screenshot and re-read `url`/`title`. The old bug was a 1280×577 viewport with the example.com link at y=732, below the fold, so the click did nothing. Verified without a model turn: open example.com, snapshot `- link "Learn more" [ref=e1]`, click e1, state `https://www.iana.org/help/example-domains` / "Example Domains" (open 1.9 s, click 1.6 s).
- Every action writes `url`, `title` and `updatedAt` to `/bots/:id/browser` right after its screenshot. The ~1 s live refresh during a turn uses the same agent-browser session (`runelay-<botId>`) and skips a frame while an action is in flight.

---

## v4 (19/11): live, operable browser

### `GET /bots/:id/browser/live` (WebSocket)

`wss://<servidor>:10447/bots/lia/browser/live` (through tailscale serve) or `ws://127.0.0.1:2000/...`. Only for bots with `capabilities.browser`, otherwise the upgrade gets 404. If the bot never opened a page, the server opens `about:blank` at 1280×800 first, so there is always a page.

The server attaches to the bot's agent-browser Chrome through CDP (`agent-browser --session runelay-<botId> get cdp-url`, `Target.attachToTarget` on the open tab) and runs `Page.startScreencast {format:"jpeg", quality:70, maxWidth:1280, maxHeight:800, everyNthFrame:1}`, acking each frame. The screencast runs only while at least one client is connected; the last client leaving stops it.

Server → client:
```json
{"type":"frame","data":"<base64 jpeg>","width":1280,"height":800,"ts":1795095601234}
{"type":"state","url":"https://www.iana.org/help/example-domains","title":"Example Domains","canGoBack":true,"canGoForward":false,"loading":false,"controller":"user"}
{"type":"error","message":"Assuma o controle do navegador antes de interagir."}
{"type":"pong","ts":1795095601234}
```
On connect the client gets a `state` and then the last frame (if any), so the view is never empty. `state` is sent on navigation (`Page.frameNavigated`, `loadEventFired`, `navigatedWithinDocument`, `frameStartedLoading` / `frameStoppedLoading`) and whenever the controller changes. `width`/`height` are the page's CSS size; frames arrive when the page repaints. A static page sends almost nothing, an animated or scrolling page sends up to ~19 fps.

Client → server (ignored with an `error` message unless `controller` is `"user"`; `{"type":"ping"}` always works):
```json
{"type":"mouse","event":"move|down|up|wheel","x":633,"y":798,"button":"left","clickCount":1,"deltaX":0,"deltaY":120,"modifiers":0}
{"type":"key","event":"down|up|char","key":"Enter","code":"Enter","text":"\r","modifiers":0}
{"type":"navigate","url":"https://example.com"}
{"type":"back"} {"type":"forward"} {"type":"reload"}
```
`x`/`y` are page CSS pixels (the frame's `width`×`height` space). Mouse maps to `Input.dispatchMouseEvent`. `key` `down`/`up` map to `Input.dispatchKeyEvent`, and `char` maps to `Input.insertText` (send typed text this way). `navigate` accepts only http/https URLs. back/forward use the navigation history.

### Control

`POST /bots/:id/browser/control` `{"mode":"user"|"bot"}` → `200 {"ok":true,"controller":"user"}`; `400` with another mode, `409 no_browser`. While the mode is `user`, the bot's `browser_*` tools wait. After 120 s they fail with "O usuário está controlando o navegador. Tente de novo quando ele devolver o controle." Give control back with `{"mode":"bot"}`. `GET /bots/:id/browser` and every `state` message carry `controller`. Control lives in memory and resets to `bot` on server restart.

### REST history

`POST /bots/:id/browser/back`, `/forward`, `/reload` → `200 {"url","title","updatedAt","screenshotPath","controller"}` (no model turn, allowed in any control mode because the person sends it); `409 no_browser`; `502` on browser failure. `POST /bots/:id/browser/open` works as in v3 and is also never blocked by control.

### Measured (19/11, no model turns, Node ws client against Lia)

- Without control: navigate → `error` "Assuma o controle…".
- After `control user`: navigate example.com → mouse move/down/up at the link center (633, 798) → state `https://www.iana.org/help/example-domains` "Example Domains" → `back` → `https://example.com/` with `canGoForward:true` → `forward` → iana again.
- Frames: 1280×800 JPEG, average 55–65 KB. Navigating plus clicking gave 10 frames in 6.5 s (frames come on repaint). A page animating its background every 50 ms gave 99 frames in 5.3 s = 18.6 fps.

---

## v11 (19/11): bot computer (virtual desktop)

### Setup on the VPS (done once with `sudo -n`)

- Installed `xdotool` and `xterm` with apt. Xvfb, openbox and ffmpeg were already there.
- Created the system user `runelaybot` (uid/gid 1501, home `/home/runelaybot` 750, no sudo). It first got uid 999, which is the uid of the Docker postgres/redis processes on this host, so I moved it to 1501.
- Copied agent-browser's Chrome for Testing 158 to `/opt/runelay-chrome` (root-owned, world-readable) so the unprivileged user can run it.

### Per bot with `capabilities.desktop`

Started on first use, as `runelaybot`:
- `Xvfb :N -screen 0 1280x800x24 -nolisten tcp -ac`, with N from 90 upwards
- `openbox`
- headed Chrome (`--user-data-dir=/home/runelaybot/chrome-<botId>`)
- `xterm` on demand

Input is sent with `xdotool` against `DISPLAY=:N`. A desktop stops after 10 minutes without viewers or tool use, when the bot is archived or deleted, and when the server stops.

Residual risk: Chrome runs with `--no-sandbox`. Xvfb uses `-ac`, so any local user can connect to the display over the unix socket (TCP is off). The desktop user can still read world-readable files on the host. It has no sudo and cannot read the server user's home.

### `GET /bots/:id/desktop/live` (WebSocket)

Same protocol as `/browser/live`, for bots with `capabilities.desktop`:
- Frames: `{"type":"frame","data":"<base64 jpeg>","width":1280,"height":800,"ts":…}`, from `ffmpeg -f x11grab` (MJPEG, q 7) at 8 fps (`DESKTOP_FPS`), and only while a viewer is connected.
- `state`: `{"type":"state","url":"","title":"<active window name>","canGoBack":false,"canGoForward":false,"loading":false,"controller":"user|bot","surface":"desktop"}`.

Input works only when control is `user` (`POST /bots/:id/browser/control`, shared with the browser; it now also works for desktop-only bots):
- `mouse` (move/down/up/wheel)
- `key` (`down`/`up` with browser key names mapped to X keysyms and modifiers; `char` → `xdotool type`)
- `navigate {url}` opens the URL in the desktop Chrome; `back` / `forward` / `reload` send alt+Left / alt+Right / F5
- `{"type":"terminal"}` opens an xterm

`GET /bots/:id/desktop/latest.png` returns the last screenshot taken by `desktop_screenshot`.

### Bot tools

| tool | gate |
|---|---|
| `desktop_screenshot()` | none; returns the PNG as MCP image content + `{title, display, width, height}` |
| `desktop_click(x, y, button?, double?)` | Jev (auto when low risk) or human |
| `desktop_scroll(x, y, direction, amount?)` | none |
| `desktop_open(app:"browser"\|"terminal", url?)` | browser: Jev / human; terminal: always human |
| `desktop_type(text)`, `desktop_key(combo)` | Jev is asked and logged, then always human ("Digitar, teclas e terminal sempre passam por uma pessoa.") |

All desktop tools wait while the user has control (same 120 s rule as the browser).

Verified 19/11 on a test bot `desk-teste`. Lia had been deleted from the app, so she couldn't be used.
- **No model:** the socket gave 20 frames in the first 5 s (1280×800, ~55 KB). Input before taking control was refused. With control: `terminal` opened an xterm, then a click, then typing `echo ok | tee ~/desk-check.txt` and Enter. `/home/runelaybot/desk-check.txt` contained `ok`. 74 frames in 9.1 s = 8.2 fps.
- **One real turn** ("tira um print, clica no meio do Chromium"): `desktop_screenshot`, then `desktop_click(640,400)`. Jev: risk 0.46, confidence 0.54, so a human card; approved, then completed. Reply: "Cliquei no meio da janela do Chromium e ela é só uma página em branco (about:blank), com avisos de "Chrome for Testing" e do flag --no-sandbox no topo." So the model saw the image. Usage 6 / 198 / 10,783 / 6,299.

---

## v12 (19/11): computer use on the user's Mac — server and runner side

### Bot fields

- `capabilities.computer` (boolean; `/meta` lists `{"id":"computer","label":"Seu Mac",…}`).
- `"computer":{"allowedRoots":["~/Desktop","~/Downloads","~/Documents"]}`: can be changed with PATCH; up to 10 absolute or `~/` paths, no `..`, otherwise 400 `field:"computer.allowedRoots"`. It is passed through to the executor on every call.
- Enabled for testing only on Lia. Lia is currently soft-deleted, `deletedAt` 14:21, done in the app; I didn't restore her.

### Wire path

Bot MCP tool → server → `computer.tool` request over the app's `/runner/connect` connection → the app's executor (since v21; the HTTP runner path was removed in v38, see [accounts](accounts.md)).

**Executor protocol (what the app must implement):**
- `GET /health` → `{"ok":true,"permissions":{"accessibility":bool,"screenRecording":bool,"automation":bool},…}`
- `POST /tools/<tool>` with `Authorization: Bearer <executor.token>` and body `{"args":{…},"context":{"botId","botName","sessionId","allowedRoots":[…]}}`
  - success: `{"ok":true,"result":…}`. Screenshots: `result = {"imageBase64","mimeType","scale",…}`. Act tools may add `screenshotPath`.
  - failure: `{"ok":false,"code":"…","error":"pt-BR message"}`. `code` `stopped` (Parar) or `user_took_over` cancels the turn. The executor enforces roots and workspace limits too.
- `GET /events` → NDJSON `{"type":"stop"|"user_took_over","botId?":"lia"}`. While a computer-capable bot's turn runs, the server follows this stream through the runner and cancels the turn: `turn.settled {"outcome":"cancelled","reason":"A pessoa apertou Parar."|"Você assumiu o computador."}`.

Unavailable (app closed, no token file, executor down): the runner answers `503 {"ok":false,"code":"COMPUTER_UNAVAILABLE","error":"O app runelay bots não está disponível no Mac (…)."}`. The tool returns `COMPUTER_UNAVAILABLE: …` to the model, and `call.settled` has `error.code:"COMPUTER_UNAVAILABLE"`. `GET /computer/health` on the server goes through the runner to the executor's `/health`.

### Tools (bot MCP, when `capabilities.computer`)

- **Observe, no gate:** `computer_screenshot({display?, region?})`, `computer_ui_tree({app?})`, `computer_apps`, `computer_windows`, `files_list({path})`, `files_read({path})`, `record_status`.
- **Act, Jev + human gate** (auto only when Jev rates it low risk with confidence ≥ threshold): `computer_click({elementId}|{x,y}, button?, double?)`, `computer_type({text})`, `computer_key({combo})`, `computer_scroll`, `computer_drag`, `computer_open({app?|url?|path?})`, `computer_applescript({script})`, `files_move`, `files_rename`, `files_mkdir`, `files_trash({paths})`, `files_write({path, content})`, `shell_run({cmd, cwd})`, `record_start`, `record_stop`.
- **Always human** (rule, Jev not asked):
  - AppleScript mentioning send / deliver / delete / empty trash / purchase / buy / pay / Mail / Messages
  - `files_trash` with more than 10 paths
  - `shell_run` outside the allowlist (`npm|pnpm|bun|node|swift|xcodebuild|ls|cat|mkdir|git status|diff|add|commit`), or containing sudo / `rm -rf`
  - typing card or CPF numbers
  - opening checkout/payment URLs
  - Typing into secure (password) fields is left to the executor, which knows the AX secure attribute.

Events:
- `call.requested.data.capability` has `"surface":"computer"`.
- After every act: `{"type":"computer.action","data":{"tool":"computer_click","summary":"Clicar em …","screenshotPath?":"…","callId":"…"}}`.
- Screenshots go to the model as MCP image content. For non-Claude providers, a `computer_ui_tree` text is appended.

A computer-capable bot's system prompt gets a section: prefer `computer_ui_tree` / `elementId` / AppleScript over pixels, ask before anything irreversible, files only in allowed roots, never sudo, and how to tell the person when the app is closed.

### Status 19/11

The executor isn't live yet. `~/Library/Application Support/runelay bots/` doesn't exist on the Mac and nothing listens on 4791, so `/computer/health` and `files_list ~/Downloads` both return `COMPUTER_UNAVAILABLE (sem token do executor)`. No real Lia turn was run.

---
