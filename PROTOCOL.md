# runelay bots: verified protocol

Every body below was captured from the running server (eve 1.1.0, stream version 27) on 2026-11-19.
The approval flow (`interaction.opened` → answer → `interaction.settled`, `call.*`, `content.completed`, `usage.recorded`) was captured from a temporary copy of Lia that used a mock model and the real `browser_click` tool, because there are no model credentials on the VPS yet. With real credentials the shapes are the same; only text, ids and token counts change.

## Deviations

1. **Tailnet port is 10447, not 10445.** `https://vps.taile89599.ts.net:10445` already serves the Spark HMR preview (vite 5176). Base URL for the Mac: `https://vps.taile89599.ts.net:10447`.
2. **Three eve processes behind a gateway.** eve 1.1.0 runs one root agent per server process (workspace members are built and started separately). The server is an eve agent workspace (`agents/boss`, `agents/davi`, `agents/lia`), each member on its own loopback port (3101, 3102, 3103), plus a small Node gateway on `127.0.0.1:2000` that serves the custom routes and proxies `/bots/:id/eve/*` to the member with the `/bots/:id` prefix stripped. The Mac only needs `sessionBasePath`, as the contract says.
3. **Boss delegates to local copies of Davi and Lia.** eve refuses remote-agent callbacks over loopback outside `eve dev`, so Boss has declared subagents `davi` and `lia` with the same instructions and the same tools. They share the same browser session and data dir as Lia, so `/bots/lia/browser` also reflects what Boss's Lia did. Their child sessions live on Boss's stream and do not appear in `/bots/davi/sessions` or `/bots/lia/sessions`.
4. **Paths inside events are member-relative.** Anything eve puts in an event that is a path (for example `child.opened.data.stream`) starts with `/eve/v1/...`. Prefix it with `/bots/<id>` (the part of `sessionBasePath` before `/eve/v1`).
5. **`GET /bots` schedules carry an extra `timezone` field** (`America/Sao_Paulo`). Davi's cron is the contract's `*/30 8-22 * * *`, so the last run of the day is 22:30.
6. **No route auth.** The eve channels use `none()` and the gateway has no token: the only protection is that it listens on loopback and is exposed only to the tailnet.
7. **Schedule runs in `/sessions` are unverified.** Schedules only fire under `eve start` on their cron. The hook marks a session as `"source": "schedule"` when the delivery carries a `scheduleId` or runs as the app identity; this path has not fired yet.
8. **A prewarmed session (create without `message`) appears in `/sessions` only after its first message.**

## Base

```
BASE = https://vps.taile89599.ts.net:10447     (Mac, over tailnet)
       http://127.0.0.1:2000                    (on the VPS)
```

All JSON. No auth header.

## Custom routes

### `GET /bots` → 200

```json
[
  {"id":"boss","name":"Boss","role":"Chefe do time","accent":"indigo","sessionBasePath":"/bots/boss/eve/v1",
   "schedules":[{"name":"briefing","cron":"30 8 * * 1-5","timezone":"America/Sao_Paulo","description":"Briefing dos dias úteis às 08:30, com o retrato de produção do Davi."}],
   "hasBrowser":false},
  {"id":"davi","name":"Davi","role":"Vigia de produção","accent":"green","sessionBasePath":"/bots/davi/eve/v1",
   "schedules":[{"name":"watch","cron":"*/30 8-22 * * *","timezone":"America/Sao_Paulo","description":"Ronda a cada 30 minutos, das 08:00 às 22:30, procurando problemas óbvios em produção."}],
   "hasBrowser":false},
  {"id":"lia","name":"Lia","role":"QA e navegador","accent":"pink","sessionBasePath":"/bots/lia/eve/v1",
   "schedules":[],"hasBrowser":true}
]
```

`GET /bots/:id` returns one of these objects. Unknown id → `404 {"ok":false,"error":"Bot não encontrada."}`.

### `GET /bots/:id/browser`

200:
```json
{"url":"https://example.com/","title":"Example Domain","updatedAt":"2026-11-19T12:18:22.831Z","screenshotPath":"/bots/lia/browser/latest.png"}
```
404 when the bot never opened a page:
```json
{"ok":false,"error":"Essa bot ainda não abriu nenhuma página."}
```

### `GET /bots/:id/browser/latest.png`

200 `image/png`, `cache-control: no-store`, `last-modified` set. 404 JSON `{"ok":false,"error":"Nenhum print ainda."}`. Updated after every browser tool call (open, snapshot, click, fill, screenshot). Poll it when a `call.settled` for a `browser_*` capability arrives, or when `updatedAt` from `/browser` changes.

### `GET /bots/:id/sessions` → 200, newest first

```json
[{"sessionId":"wrun_01M7SW01SG47J8MDJJGP31M92Y","title":"Como está a produção?","startedAt":"2026-11-19T12:20:10.784Z","source":"chat"}]
```
Schedule runs add `"source":"schedule"` and `"scheduleId":"watch"`. Title is the first user message, at most 80 characters.

## eve session API (under `sessionBasePath`, e.g. `/bots/lia/eve/v1`)

### Create a session with the first message

`POST {sessionBasePath}/session`
```json
{"message":"Abre https://example.com e me diz o título."}
```
→ `202`, header `x-eve-session-id`:
```json
{"ok":true,"sessionId":"wrun_01M7SVS11QFQ16PH7JZ5ASRMA7","deliveryId":"e9dc1213-0751-4a97-b7fe-8f233f958fb2"}
```
Without a body it creates a prewarmed session: same `202` and shape.

### Send a follow-up message

`POST {sessionBasePath}/session/:sessionId`
```json
{"message":"Tenta de novo."}
```
→ `202`
```json
{"ok":true,"sessionId":"wrun_01M7SVS11QFQ16PH7JZ5ASRMA7","deliveryId":"73609329-1316-4753-a5d2-4b1a46173724"}
```
A message sent while a turn runs steers that turn (default `turnPolicy: "steer"`).

### Answer an approval

`POST {sessionBasePath}/session/:sessionId`
```json
{"answers":[{"interactionId":"4WKDdxz39zyo4E6L","optionId":"approve"}]}
```
or `"optionId":"deny"`. → `202`
```json
{"ok":true,"sessionId":"wrun_01M7SVWDTXJ4YQM9W17529F20N","deliveryId":"6fd61b89-b3c2-40a7-bbe5-1dd6d0a8ba8e"}
```
Use `interaction.opened.data.interactionId` and one of `request.options[].id`.

### Cancel the running turn

`POST {sessionBasePath}/session/:sessionId/cancel` (optional body `{"turnId":"turn_0"}`) → `202 {"ok":true,"sessionId":"...","deliveryId":"..."}`.

### Errors

- Unknown or ended session: `409 {"ok":false,"code":"session_not_active","error":"The session is no longer active."}`
- Unknown body field: `400 {"ok":false,"error":"Unknown field 'text'. Accepted fields: inbox, message, answers, clientContext, outputSchema, turnPolicy, callback, forwardedPrincipal, idempotencyKey."}`
- Bot process down: `502 {"ok":false,"error":"Lia está fora do ar.","detail":"..."}` (gateway)

### Stream

`GET {sessionBasePath}/session/:sessionId/stream?startIndex=0` → NDJSON, header `x-eve-stream-version: 27`. Each line is one of:

- event line `{"at": ISO, "facts": [event, ...]}`. Stored lines are numbered from 0; `startIndex` is the next stored line to read.
- progress record `{"progress": event}` (text deltas; not stored state)
- transport `{"$eve":"heartbeat"}`, `{"$eve":"stream.lease-ended"}` (reconnect with `startIndex = last line + 1`), `{"$eve":"stream.ended"}` (stop)

`follow=false` (or `includeTailIndex=1`) returns what is recorded and closes. The live stream works through the gateway and tailnet (verified with `curl -N`).

Events the Mac renders, verbatim from the captures (one event per line, as it sits inside `facts` or `progress`):

```jsonl
{"data":{"runtime":{"agentId":"lia","agentName":"lia","eveVersion":"1.1.0"}},"type":"session.started"}
{"data":{"deliveryId":"8da8a830-d481-4375-a3fe-8fc403d0f476","principal":{"id":"anonymous","type":"anonymous"},"source":{"channel":"channel:eve"}},"type":"delivery.admitted"}
{"data":{"cause":{"deliveryId":"8da8a830-d481-4375-a3fe-8fc403d0f476"},"follows":null,"turnId":"turn_0"},"type":"turn.started","scope":{"turnId":"turn_0"}}
{"data":{"deliveryId":"8da8a830-d481-4375-a3fe-8fc403d0f476","parts":[{"kind":"text","text":"Clica no link."}],"turnId":"turn_0"},"type":"delivery.consumed","scope":{"turnId":"turn_0"}}
{"data":{"owner":{"turnId":"turn_0"},"runId":"run_0"},"type":"model.requested","scope":{"runId":"run_0","turnId":"turn_0"}}
{"data":{"attempt":0,"modelId":"mock/probe","runId":"run_0"},"type":"model.started","scope":{"runId":"run_0","turnId":"turn_0"}}
{"data":{"delta":"Vou clicar no link.","kind":"text","partId":"run_0.0"},"scope":{"runId":"run_0","turnId":"turn_0"},"type":"content.delta"}
{"data":{"kind":"text","partId":"run_0.0","phase":"narration","runId":"run_0","value":"Vou clicar no link."},"type":"content.completed","scope":{"runId":"run_0","turnId":"turn_0"}}
{"data":{"callId":"call_probe_1","capability":{"kind":"tool","name":"browser_click","label":"Clicar em e1"},"input":{"ref":"e1"},"owner":{"runId":"run_0"}},"type":"call.requested","scope":{"runId":"run_0","turnId":"turn_0"}}
{"data":{"finishReason":"tool-calls","outcome":"completed","runId":"run_0"},"type":"model.settled","scope":{"runId":"run_0","turnId":"turn_0"}}
{"data":{"kind":"model","owner":{"runId":"run_0"},"usage":{"cacheReadTokens":0,"cacheWriteTokens":0,"inputTokens":120,"outputTokens":30}},"type":"usage.recorded","scope":{"runId":"run_0","turnId":"turn_0"}}
{"data":{"interactionId":"4WKDdxz39zyo4E6L","request":{"allowFreeform":false,"display":"confirmation","kind":"approval","options":[{"id":"approve","label":"Approve"},{"id":"deny","label":"Deny"}],"prompt":"Posso clicar em e1?"},"subject":{"callId":"call_probe_1"}},"type":"interaction.opened","scope":{"turnId":"turn_0"}}
{"data":{"awaiting":[{"interactionId":"4WKDdxz39zyo4E6L"}],"turnId":"turn_0"},"type":"turn.paused","scope":{"turnId":"turn_0"}}
{"data":{"deliveryId":"8da8a830-d481-4375-a3fe-8fc403d0f476","outcome":"awaiting-input","turnId":"turn_0"},"type":"delivery.settled"}
{"data":{"deliveryId":"6fd61b89-b3c2-40a7-bbe5-1dd6d0a8ba8e","interactionId":"4WKDdxz39zyo4E6L","responseId":"response_6fd61b89-b3c2-40a7-bbe5-1dd6d0a8ba8e_0","value":{"optionId":"approve"}},"type":"response.submitted","scope":{"turnId":"turn_0"}}
{"data":{"outcome":"applied","responseId":"response_6fd61b89-b3c2-40a7-bbe5-1dd6d0a8ba8e_0"},"type":"response.settled","scope":{"turnId":"turn_0"}}
{"data":{"cause":{"responseId":"response_6fd61b89-b3c2-40a7-bbe5-1dd6d0a8ba8e_0"},"interactionId":"4WKDdxz39zyo4E6L","outcome":"accepted","response":{"optionId":"approve"}},"type":"interaction.settled","scope":{"turnId":"turn_0"}}
{"data":{"callId":"call_probe_1","clearedBy":{"interactionId":"4WKDdxz39zyo4E6L"}},"type":"call.started","scope":{"turnId":"turn_0","runId":"run_0"}}
{"data":{"callId":"call_probe_1","outcome":"completed","output":{"url":"https://example.com/","title":"Example Domain","updatedAt":"2026-11-19T12:18:22.831Z","screenshot":"/home/anderson/projects/runelay-bots/server/.data/bots/lia/browser/shots/2026-11-19T12-18-22-323Z.png"}},"type":"call.settled","scope":{"turnId":"turn_0","runId":"run_0"}}
{"data":{"kind":"text","partId":"run_1.0","phase":"reply","runId":"run_1","value":"Pronto, cliquei no link."},"type":"content.completed","scope":{"runId":"run_1","turnId":"turn_0"}}
{"data":{"outcome":"completed","reply":["run_1.0"],"turnId":"turn_0"},"type":"turn.settled","scope":{"turnId":"turn_0"}}
{"data":{"deliveryId":"6fd61b89-b3c2-40a7-bbe5-1dd6d0a8ba8e","outcome":"handled","turnId":"turn_0"},"type":"delivery.settled"}
```

Deny path (same session shape, `optionId":"deny"`):

```jsonl
{"data":{"cause":{"responseId":"response_c0a7188e-bf6e-44cd-9d94-bf3893693aac_0"},"interactionId":"8fuIbULrC9PrrXPY","outcome":"declined","response":{"optionId":"deny"}},"type":"interaction.settled","scope":{"turnId":"turn_0"}}
{"data":{"callId":"call_probe_1","cause":{"interactionId":"8fuIbULrC9PrrXPY"},"error":{"code":"TOOL_EXECUTION_DENIED","message":"Tool execution was denied."},"outcome":"rejected","output":{"approval":{"interactionId":"8fuIbULrC9PrrXPY","status":"denied"},"code":"TOOL_EXECUTION_DENIED","message":"Tool execution was denied.","tool":{"result":"not_run"}}},"type":"call.settled","scope":{"turnId":"turn_0","runId":"run_0"}}
```

Failed turn, real bot without credentials (what the Mac sees today):

```jsonl
{"data":{"attempt":0,"modelId":"anthropic/claude-sonnet-5.5","runId":"run_0"},"type":"model.started","scope":{"runId":"run_0","turnId":"turn_0"}}
{"data":{"runId":"run_0","outcome":"failed","error":{"code":"MODEL_CALL_FAILED","id":"72dd6479-5822-42ac-a2ab-254dbc027832","message":"Set ANTHROPIC_API_KEY in the server environment."}},"type":"model.settled","scope":{"runId":"run_0","turnId":"turn_0"}}
{"data":{"error":{"code":"MODEL_CALL_FAILED","id":"72dd6479-5822-42ac-a2ab-254dbc027832","message":"Set ANTHROPIC_API_KEY in the server environment."},"outcome":"failed","turnId":"turn_0"},"type":"turn.settled","scope":{"turnId":"turn_0"}}
{"data":{"deliveryId":"e9dc1213-0751-4a97-b7fe-8f233f958fb2","outcome":"handled","turnId":"turn_0"},"type":"delivery.settled"}
```

### Rendering rules

- Bubble: `content.completed` with `kind:"text"`, `phase:"reply"`. Muted line: same with `phase:"narration"`. Live typing: accumulate `progress` `content.delta` by `partId` and replace with `content.completed.value`.
- Tool row: open on `call.requested` (`capability.name`, `capability.label`, `input`), close on `call.settled` (`outcome`: `completed`, `failed`, `rejected`; `output` or `error`). Match by `callId`. Hide rows with `capability.hidden:true` or `capability.kind:"control"`.
- Approval card: `interaction.opened` with `request.kind:"approval"`, title `request.prompt`, buttons from `request.options`. Close on `interaction.settled` with the same `interactionId` (`outcome` `accepted` or `declined`, or another outcome when withdrawn).
- Status: working from `turn.started` until `turn.settled`; `turn.paused` means waiting for the person. A failed turn has `turn.settled.data.error.message`.
- Tokens: sum `usage.recorded.data.usage.inputTokens` and `outputTokens`.
- Boss delegating: the call to `davi` or `lia` shows as `call.requested` with `capability.name` `davi`/`lia`, plus `task.started` and `child.opened` (child stream path is member-relative, see Deviations 4). Approvals from Boss's Lia show up on Boss's own stream as `interaction.opened` with an `origin`, and are answered on Boss's session.

---

# v2 (19/11): Claude Agent SDK engine

Captured from `server-sdk/` (Claude Agent SDK 0.3.328, Claude Code 2.1.327, model `claude-sonnet-5-5`, subscription login) on 2026-11-19. Same base URL (`https://vps.taile89599.ts.net:10447`), same session API under `sessionBasePath`, same NDJSON line format (`{"at","facts"}`, `{"progress"}`, `{"$eve":...}`) and cursor semantics (`startIndex` = number of stored lines already read).

## Differences from v1 events

1. `session.started.data.runtime` is `{"agentId","agentName","engine":"claude-agent-sdk","model"}` (no `eveVersion`); a thread adds `"thread":true`.
2. Approval option labels are pt-BR: `{"id":"approve","label":"Aprovar"}`, `{"id":"deny","label":"Negar"}`. Ids unchanged.
3. Delegation: Boss calls a subagent with the SDK `Agent` tool. It shows as `call.requested` with `capability.name` = the delegated bot id and `capability.label` `"Delegar para Davi"`; its `call.settled.output` is the subagent's final report (string). The subagent's own tool calls come on the same stream as `call.requested` with `"owner":{"callId":"<delegation callId>"}` and `"origin":{"agent":"davi"}`. There are no `task.started` / `child.opened` events and no child stream. Approvals from a delegated Lia come as `interaction.opened` with `"origin":{"agent":"lia"}` and are answered on the Boss session.
4. Messages sent while a turn runs are queued and become the next turn (no steering).
5. `usage.recorded` comes once per turn, after the reply, and counts every model call in the turn (subagents included).
6. `delivery.consumed.data` carries `"source":"chat"|"schedule"` and, for schedules, `"scheduleId"`. `delivery.admitted.data.source` is `{"channel":"channel:schedule","scheduleId":"watch"}` for schedule deliveries.
7. Approvals in schedule turns are denied right away (`call.settled` `outcome:"rejected"`, `TOOL_EXECUTION_DENIED`) without an `interaction.opened`.
8. Cancel aborts the SDK query; the turn ends with `turn.settled` `outcome:"cancelled"`, and open approvals settle with `outcome:"withdrawn"`.
9. Event `at` values are unique within a session (bumped by 1 ms when needed), so the Mac's `at#index#type` key stays unique.

## Main thread per bot

Each bot has one continuous conversation. Talk to it like a messenger: get the thread, then use the normal session API on its `sessionId`.

### `GET /bots/:id/thread` → 200 (creates the thread on first call)

```json
{"sessionId":"wrun_01M7SY2J60VK52GW9WJ5BM1BJV","lastMessage":{"role":"bot","text":"Não está \"tudo normal\". Vi três pontos, o primeiro é o mais sério: - **`trackin…","at":"2026-11-19T13:00:28.419Z"},"unread":2,"running":false}
```

`lastMessage` is `null` before the first message. `role` is `"user"` or `"bot"`; `text` is at most 80 characters. Schedule prompts do not change `lastMessage`; the bot reply they produce does. `unread` counts bot replies since the last `POST /bots/:id/thread/read`.

### `POST /bots/:id/thread/read` → 200

```json
{"sessionId":"wrun_01M7SY2J60VK52GW9WJ5BM1BJV","lastMessage":{"role":"bot","text":"…","at":"2026-11-19T13:00:28.419Z"},"unread":0}
```

### Sending

`POST /bots/davi/eve/v1/session/<thread sessionId>` with `{"message":"Quantas tabelas tem no schema public?"}` → `202 {"ok":true,"sessionId":"wrun_…","deliveryId":"…"}`. Stream it with `GET …/session/<thread sessionId>/stream?startIndex=N`. The thread `sessionId` never changes; the server keeps the SDK session behind it with `resume` and lets Claude Code compact long contexts.

### Schedules post into the thread

A schedule run is a new turn in the bot's thread, not a new session:

```jsonl
{"type":"delivery.admitted","data":{"deliveryId":"b0d11d2e-0d11-42e1-8172-4ea18b317133","principal":{"id":"anonymous","type":"anonymous"},"source":{"channel":"channel:schedule","scheduleId":"watch"}}}
{"type":"turn.started","data":{"cause":{"deliveryId":"b0d11d2e-0d11-42e1-8172-4ea18b317133"},"follows":null,"turnId":"turn_1"},"scope":{"turnId":"turn_1"}}
{"type":"delivery.consumed","data":{"deliveryId":"b0d11d2e-0d11-42e1-8172-4ea18b317133","parts":[{"kind":"text","text":"Ronda de produção. Procure problemas óbvios usando só `prod_query`. …"}],"turnId":"turn_1","source":"schedule","scheduleId":"watch"},"scope":{"turnId":"turn_1"}}
```

The Mac should render a `delivery.consumed` with `"source":"schedule"` as a small system line (for example "Rotina watch") instead of a user bubble. The bot reply arrives as a normal `content.completed` `phase:"reply"`.

Model context: a schedule turn runs in a fresh SDK session (no resume). The model sees only the bot's system prompt, the schedule prompt and, when there is one, a one-paragraph summary of the previous reply of the same schedule. Its events still land in the thread NDJSON as above, and its `usage.recorded` is that run alone. Chat turns resume the thread's own SDK session, which never contains schedule tool transcripts; the next chat turn gets a short note with the replies of the schedules that ran since the last chat message. When a chat turn ends with more than ~120k input tokens of context (`BOTS_CONTEXT_LIMIT`), the next chat turn starts a new SDK session behind the same thread `sessionId`, seeded with the last exchanges as a summary.

### `POST /bots/:id/schedules/:name/run` → 202

Runs a schedule now, into the bot's thread, exactly like the cron would.
```json
{"ok":true,"sessionId":"wrun_01M7SYEEHE51CHWFHPJR17Z2AM","deliveryId":"4875d431-dfdf-4942-af3a-3d9a02b55fcc","scheduleId":"watch"}
```
Unknown schedule → `404 {"ok":false,"error":"Rotina não encontrada."}`; archived bot → `409 bot_archived`. Captured run (Davi `watch`, 6 queries): `"usage":{"inputTokens":1406,"outputTokens":3426,"cacheReadTokens":58443,"cacheWriteTokens":12474}`, against `cacheReadTokens: 331032` for the same schedule when it resumed the thread.

## Bots as data

Since 19/11 (evening) bots are only data: `data/bots/<id>.json`, created by the person or by another bot (`create_bot`). There is no seed and no built-in bot: an empty `BOTS_DATA_DIR` starts with `GET /bots` → `[]` and the app shows "Criar seu primeiro bot". The `builtIn` field was dropped from responses (old files may still carry it; it is ignored), no bot is protected from edit, archive or delete, and the list is ordered by `createdAt` (then `id`). Delegation targets are every other active bot (`delegatesOf`). `LEGACY_SERVER_DIR` is gone; the old eve server lives in `/home/anderson/projects/runelay-bots-archive/server-eve`. The examples below predate this and still show `builtIn`.

### `GET /bots` → 200 (archived bots only with `?archived=1`)

```json
[{"id":"boss","name":"Boss","role":"Chefe do time","accent":"indigo","glyph":"auto","sessionBasePath":"/bots/boss/eve/v1",
  "schedules":[{"name":"briefing","description":"Briefing dos dias úteis às 08:30, com o retrato de produção do Davi.","cron":"30 8 * * 1-5","timezone":"America/Sao_Paulo","prompt":"Bom dia. Monte o briefing do dia útil. …"}],
  "hasBrowser":false,"instructions":"# Boss\n\nVocê é o Boss, …","capabilities":{"browser":false,"prodQuery":false,"delegate":["davi","lia"]},
  "builtIn":true,"createdAt":"2026-11-19T12:56:10.000Z","updatedAt":"2026-11-19T12:56:10.000Z","archivedAt":null,
  "thread":{"sessionId":null,"lastMessage":null,"unread":0}}]
```

Built-in accents moved into the v2 palette: Boss `indigo`, Davi `teal` (was `green`), Lia `violet` (was `pink`). `GET /bots/:id` returns one object. `thread.sessionId` is `null` until the thread is created (`GET /bots/:id/thread` or the first schedule run).

### `POST /bots` → 201

Request:
```json
{"name":"Teste","role":"Bot de teste","accent":"sky","instructions":"Responda só ok.","capabilities":{}}
```
Response:
```json
{"id":"teste","name":"Teste","role":"Bot de teste","accent":"sky","glyph":"auto","sessionBasePath":"/bots/teste/eve/v1","schedules":[],"hasBrowser":false,"instructions":"Responda só ok.","capabilities":{"browser":false,"prodQuery":false,"delegate":[]},"builtIn":false,"createdAt":"2026-11-19T12:56:22.764Z","updatedAt":"2026-11-19T12:56:22.764Z","archivedAt":null,"thread":{"sessionId":null,"lastMessage":null,"unread":0}}
```
Fields: `name` (1–40, required), `role` (≤ 60), `accent` (one of `/meta.accents`, default `electric`), `glyph` (default `auto`), `instructions` (≤ 20k), `capabilities` `{browser, prodQuery, delegate:[ids]}`, `schedules` `[{name, cron, timezone (default America/Sao_Paulo), prompt (required), description}]`. `id` is a slug of the name, `-2`, `-3`… when taken. Unknown fields are rejected.

Validation errors → 400:
```json
{"ok":false,"error":"O nome não pode ficar vazio.","field":"name"}
{"ok":false,"error":"Não existe bot ativo com id \"nope\".","field":"capabilities.delegate"}
{"ok":false,"error":"Cron inválido.","field":"schedules[0].cron"}
```

### `PATCH /bots/:id` → 200

Partial update of the same fields; `capabilities` is merged key by key, `schedules` replaces the list. Built-in bots are editable. Schedules reload right away.
```json
{"role":"Testador","schedules":[{"name":"manha","cron":"0 9 * * 1-5","prompt":"oi"}]}
```
→ the full bot, with `"schedules":[{"name":"manha","cron":"0 9 * * 1-5","timezone":"America/Sao_Paulo","prompt":"oi","description":""}]`.

### `POST /bots/:id/archive`, `POST /bots/:id/unarchive` → 200 with the bot

`archivedAt` set (or cleared). Archived bots leave `GET /bots`, stop their schedules, are dropped from other bots' delegation, and refuse new messages with `409 {"ok":false,"code":"bot_archived","error":"Esse bot está arquivado."}`. Their history stays readable.

### `GET /meta` → 200

```json
{"accents":["electric","teal","violet","royal","sky","indigo"],
 "capabilities":[{"id":"browser","label":"Navegador","description":"Abre páginas, lê, clica e preenche. Clique e preenchimento pedem aprovação."},
                 {"id":"prodQuery","label":"Consulta em produção","description":"Roda SELECT no banco de produção, só leitura."},
                 {"id":"delegate","label":"Delegar","description":"Passa partes do trabalho para outros bots do time."}],
 "engine":"claude-agent-sdk","model":"claude-sonnet-5-5"}
```

### `GET /bots/:id/sessions`

Main thread first (`"thread":true`, title `"Conversa principal"`), then other sessions created with `POST {sessionBasePath}/session`, newest first. eve sessions from v1 are not carried over.

```json
[{"sessionId":"wrun_01M7SY2J60VK52GW9WJ5BM1BJV","title":"Conversa principal","startedAt":"2026-11-19T12:56:30.145Z","source":"chat","thread":true}]
```

### Other errors

- Unknown answer: `409 {"ok":false,"code":"interaction_not_pending","error":"Essa aprovação não está mais pendente."}`
- Unknown session, or a session of another bot: `409 {"ok":false,"code":"session_not_active","error":"The session is no longer active."}`

## Captured v2 turns

Davi, real turn through the subscription, `prod_query`:
```jsonl
{"type":"call.requested","data":{"callId":"toolu_01C2s3rhhV8ntWr2ojVnMQ9C","capability":{"kind":"tool","name":"prod_query","label":"Consulta: select count(*) filter (where table_type='BASE TABLE') as tabelas, count(*) filt"},"input":{"sql":"…"},"owner":{"runId":"run_0"}},"scope":{"runId":"run_0","turnId":"turn_0"}}
{"type":"call.started","data":{"callId":"toolu_01C2s3rhhV8ntWr2ojVnMQ9C"},"scope":{"runId":"run_0","turnId":"turn_0"}}
{"type":"call.settled","data":{"callId":"toolu_01C2s3rhhV8ntWr2ojVnMQ9C","outcome":"completed","output":{"rows":[{"tabelas":332,"views":14}],"truncated":false}},"scope":{"runId":"run_0","turnId":"turn_0"}}
{"type":"content.completed","data":{"kind":"text","partId":"run_1.0","phase":"reply","runId":"run_1","value":"O schema `public` tem **332 tabelas** (mais 14 views). …"},"scope":{"runId":"run_1","turnId":"turn_0"}}
{"type":"usage.recorded","data":{"kind":"model","owner":{"runId":"run_3"},"usage":{"inputTokens":1193,"outputTokens":606,"cacheReadTokens":8083,"cacheWriteTokens":3214}},"scope":{"runId":"run_3","turnId":"turn_0"}}
{"type":"turn.settled","data":{"outcome":"completed","turnId":"turn_0","reply":["run_1.0"]},"scope":{"turnId":"turn_0"}}
```

Lia, real `browser_click` approval:
```jsonl
{"type":"call.requested","data":{"callId":"toolu_01Gq5fMFx6YUxWbBCGNQd48K","capability":{"kind":"tool","name":"browser_click","label":"Clicar em @e1"},"input":{"ref":"@e1"},"owner":{"runId":"run_1"}},"scope":{"runId":"run_1","turnId":"turn_0"}}
{"type":"interaction.opened","data":{"interactionId":"6XXMgieL3EQtlgGf","request":{"allowFreeform":false,"display":"confirmation","kind":"approval","options":[{"id":"approve","label":"Aprovar"},{"id":"deny","label":"Negar"}],"prompt":"Posso clicar em @e1?"},"subject":{"callId":"toolu_01Gq5fMFx6YUxWbBCGNQd48K"}},"scope":{"turnId":"turn_0"}}
{"type":"turn.paused","data":{"awaiting":[{"interactionId":"6XXMgieL3EQtlgGf"}],"turnId":"turn_0"},"scope":{"turnId":"turn_0"}}
{"type":"delivery.settled","data":{"deliveryId":"32e0537f-f1f1-40d0-846e-581531894db5","outcome":"awaiting-input","turnId":"turn_0"}}
{"type":"response.submitted","data":{"deliveryId":"75cecc83-5891-40e2-a8fa-d1b1fd7dc8dd","interactionId":"6XXMgieL3EQtlgGf","responseId":"response_75cecc83-5891-40e2-a8fa-d1b1fd7dc8dd_0","value":{"optionId":"approve"}},"scope":{"turnId":"turn_0"}}
{"type":"response.settled","data":{"outcome":"applied","responseId":"response_75cecc83-5891-40e2-a8fa-d1b1fd7dc8dd_0"},"scope":{"turnId":"turn_0"}}
{"type":"interaction.settled","data":{"cause":{"responseId":"response_75cecc83-5891-40e2-a8fa-d1b1fd7dc8dd_0"},"interactionId":"6XXMgieL3EQtlgGf","outcome":"accepted","response":{"optionId":"approve"}},"scope":{"turnId":"turn_0"}}
{"type":"call.started","data":{"callId":"toolu_01Gq5fMFx6YUxWbBCGNQd48K","clearedBy":{"interactionId":"6XXMgieL3EQtlgGf"}},"scope":{"runId":"run_1","turnId":"turn_0"}}
{"type":"call.settled","data":{"callId":"toolu_01Gq5fMFx6YUxWbBCGNQd48K","outcome":"completed","output":{"url":"https://example.com/","title":"Example Domain","updatedAt":"2026-11-19T12:57:31.215Z","screenshot":"…/server-sdk/data/bots/lia/browser/shots/2026-11-19T12-57-30-712Z.png"}},"scope":{"runId":"run_1","turnId":"turn_0"}}
```

Boss delegating to Davi (the delegation `call.settled.output` below is the cleaned report the server sends since the last restart; the capture itself still carried the SDK hand-back wrapper):
```jsonl
{"type":"call.requested","data":{"callId":"toolu_01PZmWDeh42AL4o6K9H2Z5ej","capability":{"kind":"tool","name":"davi","label":"Delegar para Davi"},"input":{"description":"Contar tabelas do schema public","subagent_type":"davi","prompt":"Davi, rode no banco de produção …"},"owner":{"runId":"run_0"}},"scope":{"runId":"run_0","turnId":"turn_0"}}
{"type":"call.requested","data":{"callId":"toolu_014GLLubdmPc8D8f2cUVM79R","capability":{"kind":"tool","name":"prod_query","label":"Consulta: SELECT table_type, count(*) FROM information_schema.tables WHERE table_schema='p"},"input":{"sql":"…"},"owner":{"callId":"toolu_01PZmWDeh42AL4o6K9H2Z5ej"},"origin":{"agent":"davi"}},"scope":{"runId":"run_0","turnId":"turn_0"}}
{"type":"call.settled","data":{"callId":"toolu_014GLLubdmPc8D8f2cUVM79R","outcome":"completed","output":{"rows":[{"count":332,"table_type":"BASE TABLE"},{"count":14,"table_type":"VIEW"}],"truncated":false}},"scope":{"runId":"run_0","turnId":"turn_0"}}
{"type":"call.settled","data":{"callId":"toolu_01PZmWDeh42AL4o6K9H2Z5ej","outcome":"completed","output":"No schema `public` há 332 tabelas (BASE TABLE) e, separadamente, 14 views. …"},"scope":{"runId":"run_0","turnId":"turn_0"}}
{"type":"content.completed","data":{"kind":"text","partId":"run_1.0","phase":"reply","runId":"run_1","value":"O schema public tem 332 tabelas (mais 14 views)."},"scope":{"runId":"run_1","turnId":"turn_0"}}
```

---

# v3 (19/11): AI proxy with connected accounts

Captured on 2026-11-19 from `server-sdk/` (gateway 127.0.0.1:2000, tailnet :10447) and the Mac runner (`100.122.172.127:4790`).

## Accounts

### `GET /accounts` → 200 (cached 10 min; `?refresh=1` re-detects)

```json
[{"id":"vps:claude","runner":"vps","provider":"claude","label":"Claude · assinatura (VPS)","status":"ready","models":[{"id":"claude-sonnet-5-5","label":"Sonnet 5.5"},{"id":"claude-opus-5-5","label":"Opus 5.5"},{"id":"claude-haiku-5-5","label":"Haiku 5.5"},{"id":"claude-fable-5-2","label":"Fable 5.2"}],"detail":"ferramentas@… · team","checkedAt":"2026-11-19T13:24:10.112Z"},
 {"id":"vps:codex","runner":"vps","provider":"codex","label":"ChatGPT · Codex (VPS)","status":"ready","models":[{"id":"gpt-6.2-sol","label":"GPT-6.2-Sol"},"…"],"detail":"Logged in using ChatGPT"},
 {"id":"vps:grok","status":"missing","detail":"CLI não instalada nesta máquina.","models":[]},
 {"id":"vps:cursor","status":"missing"},
 {"id":"mac:claude","status":"ready","detail":"anderson@appconty.com · team"},
 {"id":"mac:codex","status":"ready"},
 {"id":"mac:grok","status":"logged_out","detail":"Grok sem login (rode grok login no Mac).","models":[{"id":"grok-4.6","label":"grok-4.6"},{"id":"grok-4.5","label":"grok-4.5"}]},
 {"id":"mac:cursor","status":"ready","detail":"✓ Logged in as anderson@appconty.com","models":[{"id":"auto","label":"Auto (default)"},"… 284 models"]}]
```

`status`: `ready`, `logged_out`, `missing` (CLI not installed), `offline` (runner unreachable; all four `mac:*` entries turn offline with `detail` "Mac fora do ar: …").

Model lists: claude is a static list (Sonnet/Opus/Haiku 5.5, Fable 5.2); codex comes from `codex debug models` (entries with `visibility: "list"`); cursor from `cursor-agent models`; grok from `grok models`.

### `POST /accounts/refresh` → 200 with the same array, re-detected on every runner.

## Bot engine

Every bot now has `"engine":{"account":"vps:claude","model":"claude-sonnet-5-5","effort":null}` (default for existing bots). `POST /bots` and `PATCH /bots/:id` accept `engine` (partial in PATCH). `account` must be `vps|mac` + `:` + `claude|codex|grok|cursor`; changing `account` without `model` picks the provider default (`claude-sonnet-5-5`, `gpt-5.6-sol`, `grok-4.6`, `auto`); `effort` is `low|medium|high|null`. Errors: `400 {"ok":false,"error":"Conta inválida. Use runner:provedor, por exemplo mac:codex.","field":"engine.account"}`, `field` `engine.model` / `engine.effort`. `GET /meta` adds `"efforts":["low","medium","high"]` and `"engine":"multi-provider"`.

## Event differences

- `model.started.data.account` = `{"id":"mac:codex","provider":"codex","runner":"mac","label":"ChatGPT · Codex (Mac)"}`; `modelId` is the bot's `engine.model`.
- `usage.recorded.data.account` = account id. Token fields as before; providers that don't report a field send 0 (codex has no cache write; cursor reports all four).
- Tool calls come from the gateway MCP handler for every provider: `callId` is ours (`call_…`), not the provider's. A new run (`model.started`, `run_N`) starts after each tool call.
- Live `content.delta` progress only for claude; codex and cursor send whole text blocks (`content.completed`).
- Delegation is a `delegate` MCP tool (`{"bot":"davi","message":"…"}`), provider-agnostic: the delegated bot runs on its own engine/account. It shows as before (`capability.name` = bot id, label "Delegar para Davi", output = report), and the delegated bot's tool calls carry `owner.callId` + `origin.agent`.
- Unavailable account: no model call, the turn fails at once:
```json
{"type":"turn.settled","data":{"outcome":"failed","turnId":"turn_0","error":{"code":"ACCOUNT_UNAVAILABLE","id":"…","message":"A conta Grok (Mac) está sem login. Grok sem login (rode grok login no Mac)."}}}
```

## Gateway MCP endpoint

`POST /mcp/:botId/:sessionId` (streamable HTTP, stateless, JSON responses). `Authorization: Bearer <per-turn token>`; the token is minted for one turn and revoked when it ends, and must match the bot and session in the path (else `401`). Tools: the bot's `prod_query`, `browser_*`, plus `delegate` when it has delegates. `browser_click` / `browser_fill` block inside the handler until the answer route resolves the approval (`interaction.opened` → answer → `interaction.settled`), the same events as v2. VPS providers call `http://127.0.0.1:2000/mcp/…`; Mac providers call `https://vps.taile89599.ts.net:10447/mcp/…`.

## Runners

- `vps`: in-process (claude via Agent SDK, codex CLI).
- `mac`: `~/runelay-bots/runner` (launchd `com.runelay.bots.runner`, KeepAlive), listening on `100.122.172.127:4790` only, `Authorization: Bearer $RUNNER_TOKEN` (shared with `server-sdk/.env.local`). `GET /health` (no auth), `GET /accounts`, `POST /turns` (body = turn request, response = NDJSON provider events), `POST /turns/:turnId/cancel`.

How each CLI runs (per-session empty work dir; no global config edited):
- claude: Agent SDK, `tools: []`, `allowedTools: ["mcp__bots"]`, `permissionMode: "dontAsk"`, `settingSources: []`, `strictMcpConfig`, claude.ai connectors off, MCP as `type: "http"`.
- codex: `codex exec --json --ignore-user-config --ignore-rules -s read-only -c approval_policy="never" -c web_search="disabled" -c developer_instructions=…`, shell/exec/apps/plugins/browser/computer/image/multi-agent features disabled, MCP via `-c mcp_servers.bots.url=… bearer_token_env_var=RUNELAY_MCP_TOKEN`, resume with `codex exec resume <thread_id>`.
- cursor: `cursor-agent -p --output-format stream-json --trust --approve-mcps --sandbox enabled --workspace <dir>`, MCP in `<dir>/.cursor/mcp.json`, instructions prepended to the first prompt, resume with `--resume <session_id>`. Residual risk: cursor's built-in file/shell tools cannot be turned off; they are confined to the empty sandboxed workspace.
- grok: `grok -p … --output-format streaming-json --system-prompt-override … --disallowed-tools run_terminal_cmd,read_file,grep,list_dir,search_replace,write,web_search,web_fetch,todo_write,task,Agent --disable-web-search --no-subagents --always-approve`, MCP in `<dir>/.grok/config.toml`. Unverified: the Mac's grok has no login. Residual risk: grok also reads `~/.grok/config.toml`, `~/.claude.json` MCP servers and global instructions.

Captured turns (usage per turn):

| account | turn | tool | usage (in / out / cache read / cache write) |
|---|---|---|---|
| vps:codex | "responda só: ok" → "ok" | none | 9080 / 5 / 0 / 0 |
| vps:claude | Davi, count tables → "332" | prod_query via MCP | 4 / 92 / 1985 / 2099 |
| mac:codex | count tables → "332" | prod_query via tailnet MCP | 21110 / 120 / 40960 / 0 |
| mac:cursor | "responda só: ok" → "ok" | none | 4 / 4 / 8974 / 21637 |
| vps:claude | Lia: open example.com, snapshot, click → approval → approved → completed | browser_* via MCP, approval in the handler | 8 / 576 / 8617 / 3421 |
| vps:codex (Boss) → vps:claude (Davi) | Boss delegates "quantas tabelas" → "332 tabelas" | `delegate` + Davi's prod_query (`owner.callId` + `origin.agent: davi`) | 16797 / 407 / 14919 / 1099 (sum of both accounts, tagged with the turn's account) |

The live browser refresh was measured during the Lia turn: `/bots/lia/browser` `updatedAt` changed 22 times in 20 s (about once per second, including while the turn was paused for approval) and stopped when the turn settled.

## Live browser view

### `POST /bots/:id/browser/open` → 200

```json
{"url":"https://example.com"}
```
→ `{"url":"https://example.com/","title":"Example Domain","updatedAt":"2026-11-19T13:26:08.948Z","screenshotPath":"/bots/lia/browser/latest.png"}`. No model turn. `400 {"ok":false,"error":"Use uma URL http ou https.","field":"url"}`; `409 {"ok":false,"code":"no_browser","error":"Esse bot não tem navegador."}`; `502` if agent-browser fails.

While a turn runs for a bot with `capabilities.browser` (or one of its delegates) that has a page open, the server refreshes `latest.png` and `/browser` state about once per second (skipped while one is in flight), and stops when the turn ends. Every browser action still saves its own print. Poll `/bots/:id/browser` (`updatedAt`) and the PNG at ~1 s during a turn.

## Paged history

### `GET {sessionBasePath}/session/:id/events?before=<index>&limit=<n>` → 200

Newest page when `before` is omitted; `limit` default 60, max 200. Each event is a stored NDJSON line (`{at, facts}`) plus its `index`, oldest first inside the page. `nextBefore` is the `before` for the next older page, `null` at the start. `total` is the number of stored lines.

```json
{"events":[{"index":80,"at":"2026-11-19T13:30:39.328Z","facts":[{"type":"delivery.settled","data":{"deliveryId":"152f7716-f45b-4913-b809-5ede24b9cd7f","outcome":"handled","turnId":"turn_1"}}]}],"nextBefore":80,"total":81}
```

Captured chain on Davi's thread (81 lines, `limit=25`): `56–80 → nextBefore 56`, `31–55 → 31`, `6–30 → 6`, `0–5 → null`. Bad `before` → `400 {"ok":false,"error":"before inválido.","field":"before"}`. Unknown session → `409 session_not_active`.

The server keeps each session's lines in memory (loaded once at startup, appended live), so a page is an O(limit) slice; nothing replays the file per request.

`GET /bots/:id/thread` and the `thread` object in `GET /bots` now carry `"total": <stored line count>`. To show history then follow live: load `events` pages backwards, then open `…/stream?startIndex=<total>`. It sends no backlog and only new lines (and heartbeats), with the same cursor rules as before.

## Browser behavior (19/11)

- Every bot browser session uses a desktop viewport of 1280×800, set before the first action and again on every open. `latest.png` is a 1280×800 viewport screenshot.
- `GET /bots/:id/browser/full.png` takes a full-page screenshot on demand and returns `200 image/png` (captured 1265×843 on example.com), `404 {"ok":false,"error":"Nenhum print ainda."}` when the bot never opened a page, `502` if agent-browser fails.
- Click and fill scroll the element into view first, wait 500 ms and then for `document.readyState === "complete"`, and only then take the screenshot and re-read `url`/`title`. The old bug was a 1280×577 viewport with the example.com link at y=732, below the fold, so the click did nothing. Verified without a model turn: open example.com, snapshot `- link "Learn more" [ref=e1]`, click e1, state `https://www.iana.org/help/example-domains` / "Example Domains" (open 1.9 s, click 1.6 s).
- Every action writes `url`, `title` and `updatedAt` to `/bots/:id/browser` right after its screenshot. The ~1 s live refresh during a turn uses the same agent-browser session (`runelay-<botId>`) and skips a frame while an action is in flight.

---

# v4 (19/11): live, operable browser

## `GET /bots/:id/browser/live` (WebSocket)

`wss://vps.taile89599.ts.net:10447/bots/lia/browser/live` (through tailscale serve) or `ws://127.0.0.1:2000/...`. Only for bots with `capabilities.browser`, otherwise the upgrade gets 404. If the bot never opened a page, the server opens `about:blank` at 1280×800 first, so there is always a page.

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

## Control

`POST /bots/:id/browser/control` `{"mode":"user"|"bot"}` → `200 {"ok":true,"controller":"user"}`; `400` with another mode, `409 no_browser`. While the mode is `user`, the bot's `browser_*` tools wait. After 120 s they fail with "O usuário está controlando o navegador. Tente de novo quando ele devolver o controle." Give control back with `{"mode":"bot"}`. `GET /bots/:id/browser` and every `state` message carry `controller`. Control lives in memory and resets to `bot` on server restart.

## REST history

`POST /bots/:id/browser/back`, `/forward`, `/reload` → `200 {"url","title","updatedAt","screenshotPath","controller"}` (no model turn, allowed in any control mode because the person sends it); `409 no_browser`; `502` on browser failure. `POST /bots/:id/browser/open` works as in v3 and is also never blocked by control.

## Measured (19/11, no model turns, Node ws client against Lia)

- Without control: navigate → `error` "Assuma o controle…".
- After `control user`: navigate example.com → mouse move/down/up at the link center (633, 798) → state `https://www.iana.org/help/example-domains` "Example Domains" → `back` → `https://example.com/` with `canGoForward:true` → `forward` → iana again.
- Frames: 1280×800 JPEG, average 55–65 KB. Navigating plus clicking gave 10 frames in 6.5 s (frames come on repaint). A page animating its background every 50 ms gave 99 frames in 5.3 s = 18.6 fps.

---

# v5 (19/11): Jev decision layer

The LLM thinks and generates, Jev (TypeSafe System One) judges, and our code decides and executes. Endpoint `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $JEV_API_KEY` (from `server-sdk/.env.local`, never logged), model pinned to `jev-1.14.0` (`JEV_MODEL`; aliases `jev-latest`/`jev-preview` point to it today). Timeout 1.5 s (`JEV_TIMEOUT_MS`). Price $0.042 per million input tokens (output free). Observed latency 160–280 ms per call, about 280–560 input tokens, about US$0.00002 each.

## `decision.made` event

```json
{"type":"decision.made","data":{"kind":"approval","question":"Esta ação do bot é segura para rodar sem uma pessoa confirmar?","answer":{"risk":0,"riskProbabilities":{"0":1,"1":0,"2":0,"3":0},"needsHuman":0.54,"aligned":0.83},"confidence":1,"threshold":0.85,"outcome":"auto_approved","latencyMs":224,"model":"jev-1.14.0","costUsd":0.0000238,"tool":"browser_click","callId":"call_0p3bdHBBj2zZ"},"scope":{"turnId":"turn_0"}}
```
`kind`: `approval` | `progress` | `triage`. `outcome`:
- approval: `auto_approved`, `human`, `allowed` / `flagged` (prod_query only), `fallback`
- progress: `continue`, `stop`, `fallback`
- triage: `notify`, `quiet`, `fallback`

A hard rule sends `answer:null`, `model:null`, `latencyMs:0` and a `reason`. On Jev error or timeout, `outcome:"fallback"` with `reason`, and today's behavior applies: a human card for click/fill, delegate and prod_query run, no guard, normal unread.

## 1. Approval gate

Gated tools: `browser_click`, `browser_fill`, `prod_query`, `delegate`, plus the v6 `add_schedule` / `remove_schedule`. The state sent to Jev: bot name/role, the user's message for this turn, tool and arguments, current page url/title, and the target element's line from the last snapshot. Questions: `risk` (Score, 4 levels from "só navega ou lê" to "destrutiva, financeira, irreversível ou expõe dado pessoal"), `needs_human` (Noul) and `aligned` (Noul).

The policy is in code:
- **Auto-approve** only when `decisions.autoApprove`, risk score < 1, `confidence` ≥ `threshold`, needs_human < 0.7 and aligned ≥ 0.5. The call then starts with `clearedBy: {"decision":"jev","model":"jev-1.14.0"}` and no card.
- **Always human, Jev not asked:** `browser_fill` into a password, card, CPF/CNPJ, PIX, token or PIN field; a value that looks like a card number, CPF or CNPJ; a value containing a newline (it submits); and any `browser_click` or `browser_fill` on an element whose text says send, pay, delete, confirm, buy, finish, subscribe, transfer, withdraw, cancel, deactivate or publish (Portuguese and English).
- **prod_query** stays read-only by code and never gets a card. Jev only marks it `flagged` (risk ≥ 1.5, needs_human ≥ 0.5 or not aligned) or `allowed`.
- **delegate** without auto-approval gets a card ("Posso pedir ao Davi: …?") in chat. In schedule turns it runs as before.
- In schedule turns, non-auto approvals are denied (no one is there).

Per-bot setting `"decisions":{"autoApprove":true,"threshold":0.85}` in `GET /bots`. It can be changed with PATCH: `threshold` must be between 0.5 and 1, otherwise `400 {"ok":false,"error":"decisions.threshold precisa ficar entre 0.5 e 1.","field":"decisions.threshold"}`.

Unit calls (jev-1.14.0, no model turn):

| state | outcome | confidence | risk / needsHuman / aligned | latency |
|---|---|---|---|---|
| click "Learn more" on example.com | auto_approved | 1.00 | 0.00 / 0.43 / 0.71 | 267 ms |
| click "Próxima página" on HN | auto_approved | 1.00 | 0.00 / 0.45 / 0.80 | 159 ms |
| click "Excluir conta" | human (rule) | – | – | 0 ms |
| click "Encerrar minha conta permanentemente" | human (Jev) | 0.80 | 2.81 / 0.98 / 0.09 | 160 ms |
| fill "Senha" | human (rule) | – | – | 0 ms |
| fill search "clima São Paulo" | human | 1.00 | 1.00 / 0.17 / 0.94 | 200 ms |
| prod_query count(*) | allowed | 0.98 | 0.03 / 0.18 / 0.95 | 189 ms |

7 calls ≈ US$0.000116 in all.

## 2. Progress guard

Every 4 settled tool calls in a turn, delegated calls included, Jev gets `{user_request, recent_tool_calls}` (the last 8 summaries). It answers `progress` (Score: going in circles / some progress / clear progress) and `stuck` (Noul). The turn stops only if progress < 0.7 **and** confidence ≥ 0.8 **and** stuck ≥ 0.8. The provider is aborted, then a pt-BR reply is written: "Parei aqui porque não estava avançando no seu pedido…" with the last attempts. The turn ends with `turn.settled` `{"outcome":"completed","stoppedBy":"progress_guard"}`. Davi's 6-query round: `continue`, progress 1.95, conf 0.92, 164 ms.

## 3. Schedule triage

After a schedule run with a reply, Jev gets `{bot_role, routine:{name, instructions}, result}` and a Noul "something the person should look at now?". If below 0.5: `turn.settled` carries `"quiet": true` and the reply stays in the thread without raising `unread`. Otherwise unread goes up as before. Davi's watch run on 19/11: `notify`, noul 0.89, 219 ms (it reported stuck payment transfers), unread 0 → 1.

Not done: the optional engine model `"auto"` (Jev picking a cheap or strong model per message).

---

# v6 (19/11): bots configure themselves

## Creating

`POST /bots` needs only `name` (plus optional `accent` and `instructions`). If `role` is missing or empty, it comes from the first sentence of the instructions (≤ 60 chars), for example "Acompanho o clima de São Paulo e mando resumos curtos". Defaults for a new bot:
- `engine` `{"account":"vps:claude","model":"claude-sonnet-5-5","effort":null}`
- `capabilities` `{"browser":true,"prodQuery":false,"delegate":[every other active bot]}`
- `schedules` `[]`
- `decisions` `{"autoApprove":true,"threshold":0.85}`

## Self-configuration tools (MCP server `bots`, every bot)

| tool | input | gate |
|---|---|---|
| `set_role` | `{text}` (≤ 60) | none |
| `update_instructions` | `{markdown, mode:"append"\|"replace"}` | none |
| `add_schedule` | `{name, cron, timezone="America/Sao_Paulo", prompt, description?}` (the model turns "dias úteis às 9h" into `0 9 * * 1-5`) | Jev + human |
| `remove_schedule` | `{name}` | Jev + human |
| `request_capability` | `{name:"browser"\|"prodQuery", reason}` | always human (`decision.made` outcome `human`, reason "Pedido de capacidade sempre passa por uma pessoa.") |

Changes go through the same validators as `PATCH /bots/:id`. A validation error comes back to the model as a failed call. Every applied change emits:
```json
{"type":"bot.updated","data":{"botId":"clima-teste","by":"bot","fields":["schedules"],"summary":"Rotina \"clima-sp-diario\" criada: 0 9 * * 1-5 (America/Sao_Paulo).","callId":"call_2zgHvRZ-tqPE"},"scope":{"turnId":"turn_0"}}
```
Schedules reload at once. New capabilities apply from the next message, because the current turn's tool list is fixed. In schedule turns, gated changes that are not auto-approved are denied.

Every bot's system prompt describes these tools. A new (non-built-in) bot's first thread message also says it was just created and can configure itself.

Verified 19/11 with one turn: a new bot "Clima Teste" was created with only name, color and instructions. Asked "me avisa todo dia útil às 9h um resumo do clima em SP", it called `add_schedule {name:"clima-sp-diario", cron:"0 9 * * 1-5"}`. Jev answered risk 2, needs_human 0.65, so outcome `human`, and the card "Posso criar a rotina … Ela roda sozinha e gasta sua assinatura." appeared. After approval: `interaction.settled accepted`, then `bot.updated`, then `call.settled completed`, and the scheduler listed `clima-teste:clima-sp-diario@2026-11-20T12:00:00Z`. Usage 4 / 399 / 3,741 / 4,071. The bot was archived afterwards and its schedule unloaded.

## v6.1 (19/11): create with name + glyph + color

- `POST /bots` needs only `name`. `instructions` and `role` are optional. Without instructions, `role` is `"Novo no time"`.
- `glyph`: any id matching `^[a-z0-9-]{1,40}$` (e.g. `face-07`, default `auto`). Pickable faces are the presets `crown`, `visor`, `antenna` plus `face-1`…`face-11`; the face never comes from the bot id (`auto` = generated from the id hash). Old names are aliases, saved and read as the preset: `boss` → `crown`, `davi` → `visor`, `lia` → `antenna`. Otherwise `400 {"ok":false,"error":"Ícone inválido: use até 40 caracteres de a-z, 0-9 e hífen.","field":"glyph"}`.
- `accent`: `GET /meta` now lists `["white","amber","red","orange","yellow","green","teal","blue","violet","pink","grey"]` (default `blue`). The old names `electric`, `royal`, `sky` and `indigo` are still accepted for existing bots.
- A bot without instructions runs on a default system prompt: it is new on the team with no job yet; on the first message it introduces itself in one sentence and asks what to do; once told, it configures itself with `set_role`, `update_instructions` (replace), and `add_schedule` / `request_capability` if needed, then confirms in one line.
- Right after creation the server writes a fixed greeting into the bot's thread, with no model call: `content.completed` `{"kind":"text","partId":"greeting.0","phase":"reply","runId":"greeting","value":"Oi! Eu sou <nome> e acabei de chegar no time. O que você quer que eu faça?","greeting":true}`. The thread's `lastMessage` is the greeting and `unread` is 1. There is no surrounding `turn.started` / `turn.settled`. The first real turn gets the greeting in its conversation summary.

---

# v7 (19/11): sidebar preferences, sections, soft delete

## Bot sidebar prefs

`GET /bots` (and `GET /bots/:id`) add `"sidebar":{"pinned":false,"sectionId":null,"hidden":false}` and `"deletedAt":null`.

`PATCH /bots/:id/sidebar` partial update → 200 with the bot:
```json
{"sectionId":"sec_9dd8d5659073","pinned":true}
```
→ `"sidebar":{"pinned":true,"sectionId":"sec_9dd8d5659073","hidden":false}`. An unknown or archived section gives `400 {"ok":false,"error":"Seção não encontrada.","field":"sectionId"}`. A non-boolean `pinned`/`hidden` or an unknown field also gives 400.

`GET /bots` leaves out hidden bots; `?hidden=1` includes them. Hidden bots still run their schedules and can still be reached by id. Filters combine: `?archived=1&hidden=1&deleted=1&q=…`.

## Sections

- `GET /sections` → `[{"id":"sec_d88d6324968c","name":"QA","order":1},{"id":"sec_9dd8d5659073","name":"Prod","order":5}]` (active only, sorted by `order`).
- `POST /sections {"name":"Produção"}` → `201 {"id":"sec_9dd8d5659073","name":"Produção","order":0}`. `order` is optional; by default it goes after the last section. `name` is 1–40 chars.
- `PATCH /sections/:id {"name":"Prod","order":5}` → 200. `order` must be an integer from 0 to 10000.
- `POST /sections/:id/archive` → `200 {"id","name","order","archivedAt"}`. Bots in that section get `sectionId:null`. Unknown id → 404.

## Thread unread

`POST /bots/:id/thread/unread` → `200 {"sessionId","lastMessage","unread","total"}` with `unread = max(1, current)`. `POST /bots/:id/thread/read` is unchanged.

## Soft delete ("Excluir")

- `POST /bots/:id/delete` → 200 with the bot, `deletedAt` set. Nothing is removed from disk.
- `POST /bots/:id/restore` → 200, `deletedAt:null`.
- Deleted bots leave `GET /bots` unless `?deleted=1`, their schedules are unloaded, and they are dropped from other bots' delegation. New messages get `409 {"ok":false,"code":"bot_deleted","error":"Esse bot foi excluído."}`. Archive and unarchive work as before.

---

# v8 (19/11): connectors via runelay

The server is an MCP client of the user's runelay. It uses the same endpoint and token as the user's Codex/Claude Code (`http://127.0.0.1:4312/v1/mcp`, copied into `server-sdk/.env.local` as `RUNELAY_MCP_URL` / `RUNELAY_MCP_TOKEN`, chmod 600, never logged). It uses runelay's tools `list_connections`, `search_tools`, `call_tool`, `search_context`, `read_memory`, `write_memory`, `read_skill` and `read_skill_file`.

## `GET /connectors` (cache 60 s) / `POST /connectors/refresh` → 200

```json
[{"name":"linear_server","label":"Linear","icon":"linear","status":"ok","toolCount":84,"reconnectUrl":null}, "… 16 connections"]
```
- `icon` is runelay's value: a slug like `linear` or `github`, a path like `/logos/conty.png`, or `null`.
- `status` is `ok`, `needs_auth` or `error`.
- `reconnectUrl` is `RUNELAY_RECONNECT_URL` when set and the status is not ok, otherwise `null`.
- Connection configs and headers are never exposed.
- `503` when runelay isn't configured, `502` when it doesn't answer.

## Bot `connectors`

`"connectors":{"allowed":["linear_server"],"memory":true}` appears in `/bots` and can be changed with PATCH (`allowed` takes runelay connection names, `[a-z0-9_-]{1,60}`). Default: nothing allowed, memory on. The self-config tool `request_connector(name, reason)` always opens a human card and then adds the name to `allowed`.

## Bot MCP tools

- `connector_search(query, limit?)` → runelay `search_tools`, filtered to `allowed` connections. Returns `[{name:"linear_server.list_teams", description, inputSchema}]`.
- `connector_call(tool, args)`: `tool` is `connection.tool`, and the connection must be in `allowed`. Goes to runelay `call_tool`; output is cut at 20 k chars.
- With `memory:true`: `memory_search(query, kind?)`, `memory_read(slug)`, `skill_read(slug, path?)`, and `memory_write(slug, body, name?, description?)`, which is gated as a write.

## Gate (by tool name, in code)

- **outbound:** send, email, mail, message, reply, comment, chat, notify, sms, whatsapp, tweet, dm, invite, share. Always a human card; Jev is not asked (`decision.made` reason "Mensagem para fora sempre passa por uma pessoa."). Examples: `linear_server.save_comment`, `gmail.send_email`.
- **read:** tool name starts with get, list, search, read, fetch, query, find, describe, show, view, count, me, lookup, check, status, and so on, as a whole word. Runs after a Jev check. Only Jev risk ≥ 2 with confidence ≥ 0.5 sends it to a person (`outcome` `allowed` or `human`).
- **write:** everything else (create, update, save, merge, execute, …). Jev is asked and logged, and then always a human card ("Escrita em serviço externo sempre passa por uma pessoa.").
- In schedule turns, anything that needs a person is denied.

Events: `call.requested.data.capability = {"kind":"tool","name":"connector:linear_server.list_teams","label":"Linear: list_teams","connector":"linear_server"}`, so the Mac can show the service logo. Search and memory calls use `name` `connector_search`, `memory_search`, `memory_read`, `skill_read` or `memory_write`.

Verified 19/11:
- **Direct, no model:** 16 connections, all ok. Search "linear issue" returned `get_attachment` [read] and `create_attachment` / `delete_attachment` [write]. `linear_server.list_teams` returned the teams. Classifier checks: `save_comment` outbound, `save_issue` write, `merge_pull_request` write, `list_comments` read, `get_me` read.
- **One real turn:** Davi with `allowed:["linear_server"]`, asked "Quais times existem no Linear?", ran `connector_search` then `connector:linear_server.list_teams` with no card, and replied "Many, Conty, Conty - Operacoes, Magalu, Conty GTM". Usage 6 / 178 / 9,526 / 6,003. No write was made to any service.

---

# v9 (19/11): groups

## Routes

- `POST /groups {"name":"Time","members":["boss","davi"]}` → 201:
```json
{"id":"grp_1fbee052aa1f","name":"Time","members":["boss","davi"],"sessionBasePath":"/groups/grp_1fbee052aa1f/eve/v1","createdAt":"…","updatedAt":"…","archivedAt":null,
 "thread":{"sessionId":"wrun_01M7T3QJ7V5V1F3WEZEE43NQ54","lastMessage":null,"unread":0,"total":1,"running":false}}
```
  `name` is 1–40 chars. `members` takes 2–8 active bot ids. Errors are 400 with `field`, for example `"Um grupo precisa de pelo menos dois bots."` or `"Não existe bot ativo com id \"lia\"."`.
- `GET /groups` (`?archived=1`), `GET /groups/:id`, `PATCH /groups/:id {name?, members?}`, `POST /groups/:id/archive|unarchive`.
- `GET /groups/:id/thread`, `POST /groups/:id/thread/read`, `POST /groups/:id/thread/unread`. The thread's `lastMessage.text` is prefixed with the bot name, and `lastMessage.botId` is set.
- The session API is the same as for bots, under `sessionBasePath`: `POST …/session/:id` with `message` or `answers`, `/cancel`, `/stream`, `/events`. Creating extra sessions (`POST …/session`) gives 405: a group has only its thread.

## Turn routing

1. **Mentions:** `@id`, `@nome`, a leading "Nome," / "Nome:", or "…, Nome," anywhere. Accents and case don't matter. Mentioned bots answer in mention order.
2. **No mention:** Jev picks one member, logged on the thread (no turnId):
```json
{"type":"decision.made","data":{"kind":"route","question":"Quem do grupo deve responder a esta mensagem?","answer":{"choice":"boss","probabilities":{"boss":0.99,"davi":0.01}},"confidence":0.98,"threshold":0.5,"outcome":"boss","latencyMs":163,"model":"jev-1.14.0","groupId":"grp_1fbee052aa1f"}}
```
   If Jev fails: `outcome:"fallback"` and the first member answers.
3. Each bot turn is a normal turn (`turn.started` … `turn.settled`), and **every event in it carries `data.botId`**. The user's message (`delivery.admitted` / `delivery.consumed`) is emitted once, without `botId`.
4. A bot can call `handoff(bot, note)`. That emits `{"type":"handoff.requested","data":{"from":"boss","to":"davi","note":"…"}}`, and the target answers next. At most 4 bot turns per user message.

Inside a group, each bot gets the group roster, the last 12 messages of the group (with speaker names), any handoff note, and the message. Group turns don't resume a provider session.

Verified 19/11, group Boss + Davi:
- "Davi, quantas tabelas tem no public?" → mention → Davi: `prod_query` (Jev allowed), reply "332 tabelas". Usage 4 / 148 / 4,761 / 4,875.
- "Alguém me dá em uma linha um resumo de quem faz o quê neste time?" → Jev route `boss` (0.99, 163 ms) → Boss answered. Usage 2 / 80 / 0 / 4,426.
- `handoff` was not exercised.
- Lia could not join because she had been soft-deleted from the app at 14:21. The test group was archived afterwards.

# v10

No server change. Notifications are handled entirely by the Mac app.

---

# v11 (19/11): bot computer (virtual desktop)

## Setup on the VPS (done once with `sudo -n`)

- Installed `xdotool` and `xterm` with apt. Xvfb, openbox and ffmpeg were already there.
- Created the system user `runelaybot` (uid/gid 1501, home `/home/runelaybot` 750, no sudo). It first got uid 999, which is the uid of the Docker postgres/redis processes on this host, so I moved it to 1501.
- Copied agent-browser's Chrome for Testing 158 to `/opt/runelay-chrome` (root-owned, world-readable) so the unprivileged user can run it.

## Per bot with `capabilities.desktop`

Started on first use, as `runelaybot`:
- `Xvfb :N -screen 0 1280x800x24 -nolisten tcp -ac`, with N from 90 upwards
- `openbox`
- headed Chrome (`--user-data-dir=/home/runelaybot/chrome-<botId>`)
- `xterm` on demand

Input is sent with `xdotool` against `DISPLAY=:N`. A desktop stops after 10 minutes without viewers or tool use, when the bot is archived or deleted, and when the server stops.

Residual risk: Chrome runs with `--no-sandbox`. Xvfb uses `-ac`, so any local user can connect to the display over the unix socket (TCP is off). The desktop user can still read world-readable files on the host. It has no sudo and cannot read `/home/anderson`.

## `GET /bots/:id/desktop/live` (WebSocket)

Same protocol as `/browser/live`, for bots with `capabilities.desktop`:
- Frames: `{"type":"frame","data":"<base64 jpeg>","width":1280,"height":800,"ts":…}`, from `ffmpeg -f x11grab` (MJPEG, q 7) at 8 fps (`DESKTOP_FPS`), and only while a viewer is connected.
- `state`: `{"type":"state","url":"","title":"<active window name>","canGoBack":false,"canGoForward":false,"loading":false,"controller":"user|bot","surface":"desktop"}`.

Input works only when control is `user` (`POST /bots/:id/browser/control`, shared with the browser; it now also works for desktop-only bots):
- `mouse` (move/down/up/wheel)
- `key` (`down`/`up` with browser key names mapped to X keysyms and modifiers; `char` → `xdotool type`)
- `navigate {url}` opens the URL in the desktop Chrome; `back` / `forward` / `reload` send alt+Left / alt+Right / F5
- `{"type":"terminal"}` opens an xterm

`GET /bots/:id/desktop/latest.png` returns the last screenshot taken by `desktop_screenshot`.

## Bot tools

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

# v8.1 (19/11): smart memory

Per-bot `"memory":{"recall":true,"capture":true}` appears in `/bots` and can be changed with PATCH (booleans; an unknown key gives 400 with `field`).

## Recall (before every chat turn; schedule turns skip it)

- runelay `search_context {query: message + role, kind:"memory", limit:5}` (~130 ms, 3 s timeout, skipped on error). This covers the user's own memories (shared with Claude Code) and the ones bots wrote.
- The results go into the turn's system prompt as `## O que você já sabe` (name + description + slug per memory, capped at 6,000 chars ≈ 1.5 k tokens).
- Also added: `## O que o time fez hoje`, the last 5 lines from **other** bots in the team log (`data/team-log.ndjson`, today only).
- Event: `{"type":"memory.recalled","data":{"slugs":[…],"titles":[…]}}`.

## Capture (after each non-group chat turn, async, after `turn.settled`)

1. **Jev:** two nouls, `durable` (decision / preference / fact / recurring task) and `secret`. Logged as `decision.made {kind:"memory", answer:{durable, secret}, outcome:"capture"|"skip"|"skip_secret"|"fallback"}`. Capture only when durable ≥ 0.6, secret < 0.3, and the text matches no secret regex (API keys, ghp/xox/Bearer tokens, long hex/base64, card numbers, CPF, "senha: …").
2. **One cheap extraction call** on the bot's own account: Haiku 5.5 on Claude, `auto` on Cursor, the bot's own model on Codex/Grok, no tools. It returns `{"facts":[{title, body, tags}], "summary"}` with 0–3 facts written about the user, not the bot.
3. **Dedupe:** a fact whose title or slug matches a recalled memory updates that memory. New ones get the slug `rb-<botId>-<slug(title)>`. Written with runelay `write_memory` (`type:"user"`, body ends with `Tags: runelay-bots, <botId>, …`).
4. `summary` (one line) goes into the team log.
5. Event: `{"type":"memory.saved","data":{"titles":["…"],"items":[{"title","slug","updated":false}],"botId":"davi"}}`. The Mac can show "Lembrei: …".

## Context reset

When a chat session passes ~120 k tokens, the provider session is dropped as before. One cheap summary call (same model rule) then replaces the 12-exchange carry-over with a real summary of the last 60 exchanges.

## Verified 19/11

- **Davi:** "Anota uma preferência minha: quando me passar números, prefiro em tabela." He replied and also called `update_instructions` himself. Jev: durable 0.97, secret 0.02, so `capture`. `memory.saved` gave `rb-davi-preferencia-numeros-em-tabela`, which runelay `read_memory` returned. The team log got one line.
- **Boss** (new session): "como eu prefiro receber números?" `memory.recalled` included `rb-davi-preferencia-numeros-em-tabela`, and Boss answered "Em tabela." His own capture updated the same memory instead of duplicating it.
- **Fixes after the check:** the first extraction wrote the fact as Davi's preference and used a slug as the title. The extraction prompt now says "Pessoa" is the user and asks for a readable title, and I rewrote that memory. Usage: Davi 4 / 135 / 7,728 / 2,284 plus one Haiku extraction; Boss 2 / 8 / 0 / 4,522 plus one Haiku extraction.

---

# v12 (19/11): computer use on the user's Mac — server and runner side

## Bot fields

- `capabilities.computer` (boolean; `/meta` lists `{"id":"computer","label":"Seu Mac",…}`).
- `"computer":{"allowedRoots":["~/Desktop","~/Downloads","~/Documents"]}`: can be changed with PATCH; up to 10 absolute or `~/` paths, no `..`, otherwise 400 `field:"computer.allowedRoots"`. It is passed through to the executor on every call.
- Enabled for testing only on Lia. Lia is currently soft-deleted, `deletedAt` 14:21, done in the app; I didn't restore her.

## Wire path

Bot MCP tool → server `POST {MAC_RUNNER_URL}/computer/<tool>` (runner bearer) → runner reads `~/Library/Application Support/runelay bots/executor.token` and calls the app's executor at `http://127.0.0.1:4791`.

**Executor protocol (what the app must implement):**
- `GET /health` → `{"ok":true,"permissions":{"accessibility":bool,"screenRecording":bool,"automation":bool},…}`
- `POST /tools/<tool>` with `Authorization: Bearer <executor.token>` and body `{"args":{…},"context":{"botId","botName","sessionId","allowedRoots":[…]}}`
  - success: `{"ok":true,"result":…}`. Screenshots: `result = {"imageBase64","mimeType","scale",…}`. Act tools may add `screenshotPath`.
  - failure: `{"ok":false,"code":"…","error":"pt-BR message"}`. `code` `stopped` (Parar) or `user_took_over` cancels the turn. The executor enforces roots and workspace limits too.
- `GET /events` → NDJSON `{"type":"stop"|"user_took_over","botId?":"lia"}`. While a computer-capable bot's turn runs, the server follows this stream through the runner and cancels the turn: `turn.settled {"outcome":"cancelled","reason":"A pessoa apertou Parar."|"Você assumiu o computador."}`.

Unavailable (app closed, no token file, executor down): the runner answers `503 {"ok":false,"code":"COMPUTER_UNAVAILABLE","error":"O app runelay bots não está disponível no Mac (…)."}`. The tool returns `COMPUTER_UNAVAILABLE: …` to the model, and `call.settled` has `error.code:"COMPUTER_UNAVAILABLE"`. `GET /computer/health` on the server goes through the runner to the executor's `/health`.

## Tools (bot MCP, when `capabilities.computer`)

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

## Status 19/11

The executor isn't live yet. `~/Library/Application Support/runelay bots/` doesn't exist on the Mac and nothing listens on 4791, so `/computer/health` and `files_list ~/Downloads` both return `COMPUTER_UNAVAILABLE (sem token do executor)`. No real Lia turn was run.

---

# v14 (19/11): connector catalog and install

The server now forwards runelay's catalog and install APIs (`/v1/catalog`, `/v1/catalog/install`, `/v1/sources/:name/oauth`, `DELETE /v1/sources/:name`) with the same `RUNELAY_MCP_TOKEN` (an org API key). The API base is `RUNELAY_API_URL`, or the origin of `RUNELAY_MCP_URL`. Errors: `400` for bad input, `404` for an unknown catalog id, `409` when it is already installed, `502` when runelay fails, `503` when runelay isn't configured. Every error is `{"ok":false,"error":"…"}` in pt-BR.

## `GET /connectors/catalog?query=` → 200

Search runs on runelay (name, id and description, no accents). Featured items are moved out of their sections, and empty sections are dropped, as on the web.
```json
{"featured":[{"id":"conty","name":"Conty","description":"Campanhas com creators, do briefing ao relatório de vendas.","icon":"/logos/conty.png","auth":"oauth","tokenUrl":null,"featured":true,"installed":true,"sourceName":"conty","status":"ok"}],
 "sections":[{"id":"popular","title":"Populares","items":[{"id":"linear","name":"Linear","description":"Issues, projetos e ciclos do seu time.","icon":"linear","auth":"oauth","tokenUrl":null,"featured":false,"installed":true,"sourceName":"linear_server","status":"ok"}, "…"]},
             {"id":"dev","title":"Para desenvolver","items":["…"]},{"id":"work","title":"Trabalho e conteúdo","items":["…"]}]}
```
- `id` is the catalog id. `sourceName` is the installed connection name (the one used in bot `connectors.allowed`), which can differ (`linear` → `linear_server`).
- `auth`: `oauth`, `api_key` (needs a token, `tokenUrl` says where to make one) or `none`.
- `status`: `ok`, `needs_auth`, `error`, `idle` or `null` when not installed.
- `icon`: a Simple Icons slug, a web path like `/logos/conty.png`, or `null` (draw the initial).
- The catalog URL and broker config are not exposed.

## `POST /connectors/:id/install {"token"?}` → 201

Installs the catalog item on runelay and, for `oauth`, starts the login:
```json
{"sourceName":"sentry","status":"needs_auth","error":"A conexão precisa de login.","authorizationUrl":"https://mcp.sentry.dev/oauth/authorize?…"}
```
The app opens `authorizationUrl` in the browser and reloads the catalog when it becomes active again. `api_key` items need `token` (400 without it). `none` items return `authorizationUrl:null` and are ready. The `GET /connectors` cache is cleared.

## `POST /connectors/:sourceName/reconnect` → 200

`{"sourceName":"sentry","authorizationUrl":"https://…"}`. `authorizationUrl` is `null` when the connection didn't need a login. Note that runelay clears the stored OAuth tokens before starting a new login.

## `DELETE /connectors/:sourceName` → 200

`{"ok":true,"sourceName":"sentry"}`. Removes the connection from runelay for every agent in the org.

Verified 19/11: catalog with 1 featured + 3 sections (8/13/12 items), search `goo` returned only Google items, `install` for `NOPE` (400), `inexistente` (404), `linear` (409, already installed) and `firecrawl` without a token (400). `install sentry` created the connection as `needs_auth` and returned the Sentry OAuth URL (login not completed), `reconnect sentry` returned a new URL, and `DELETE /connectors/sentry` removed the test connection, so the org is back to where it started.

# v13 (19/11): voice call with ElevenLabs

The app builds the call. The server never exposes ElevenLabs: it only mints single-use tokens (15 min, one connection each) and runs the fast voice layer. The ElevenLabs key lives in `server-sdk/.env.local` and never reaches the app.

Two layers:
- **Fast layer:** a warm Claude Haiku 5.5 session per call (Agent SDK on the subscription, streaming input, so the CLI process stays alive between lines). It confirms what it understood, fills the wait, asks approvals out loud, and summarizes the result in short speech. Measured on the VPS, from utterance POST to first speech text: 475–653 ms warm, against ~1.1 s cold `query()` per line and ~7.9 s for Codex CLI (`gpt-6-luna`). Override with `VOICE_FAST_MODEL`.
- **Bot layer:** the normal bot turn in the main thread, with the same tools, memory, approvals and history. Spoken user lines are ordinary deliveries with a voice mark.

## Bot field `voice`

`GET /bots` and `GET /bots/:id` carry `"voice":{"voiceId":"VNaz9wbhLsh3lLuHzAVP","speed":1}` (default: Ana Lu, pt-BR conversational; override with `VOICE_DEFAULT_ID`). `PATCH /bots/:id {"voice":{"voiceId"?,"speed"?}}` merges. `speed` runs from 0.7 to 1.2, otherwise 400 `field:"voice.speed"`. A bad id gives 400 `field:"voice.voiceId"`.

## `GET /voice/voices` → 200 (cached 10 min, `?refresh=1`)

```json
[{"voiceId":"VNaz9wbhLsh3lLuHzAVP","name":"Ana Lu","category":"professional","language":"pt","accent":"brazilian","gender":"female","description":"gentle","previewUrl":"https://storage.googleapis.com/…mp3"}]
```
Portuguese voices first, then by name. `previewUrl` is a public mp3, so the app plays it directly with no credits. 503 when ElevenLabs is not configured, 502 when it fails.

## `POST /bots/:id/voice/session` → 201

Opens the call: ends any previous call for the bot, warms the fast layer, and mints both tokens.
```json
{"callId":"call_5351d1c5176d4a57","sessionId":"wrun_…","streamPath":"/bots/lia/voice/session/call_…/stream","fastModel":"claude-haiku-5-5",
 "voice":{"voiceId":"VNaz9wbhLsh3lLuHzAVP","speed":1},
 "stt":{"url":"wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&language_code=pt&audio_format=pcm_16000&commit_strategy=vad&vad_silence_threshold_secs=0.5&token=sutkn_…","token":"sutkn_…","modelId":"scribe_v2_realtime","sampleRate":16000,"vadSilenceSecs":0.5},
 "tts":{"url":"wss://api.elevenlabs.io/v1/text-to-speech/VNaz…/multi-stream-input?model_id=eleven_flash_v2_5&output_format=pcm_24000&language_code=pt&inactivity_timeout=180&single_use_token=sutkn_…","token":"sutkn_…","modelId":"eleven_flash_v2_5","outputFormat":"pcm_24000","sampleRate":24000}}
```
`sessionId` is the bot's main thread. 409 `bot_deleted` / `bot_archived`, 503 without ElevenLabs.

Each call route below answers 404 `{"code":"call_not_found"}` once the call ends. A call ends on `DELETE`, or 90 s after its last stream listener leaves.

### `POST /bots/:id/voice/session/:callId/tokens` → 200
Body `{"types":["tts"]}` (or `"stt"`, both by default). Same `voice` / `stt` / `tts` shape, with fresh tokens. Use it to reconnect a socket, because a token is consumed on use.

### `GET /bots/:id/voice/session/:callId/stream` → NDJSON
Events, each with `at`:
- `call.ready {callId, sessionId, pending}`: `pending` is the open approval or `null`.
- `speech.started {id, kind, elapsedMs}`: `kind` is `ack` (answer to the person), `filler` (wait), `result` (summary), `error`, or `approval` (question, or the fixed "Beleza, seguindo." / "Tá bom, não vou fazer." / "Não entendi…"). `elapsedMs` is the time from the trigger to the first text.
- `speech.delta {id, text}`: send these to the TTS socket as they arrive.
- `speech.done {id, text}`: flush the TTS context.
- `speech.cancelled {id}`: interrupted, or the fast layer chose silence. Drop the context.
- `bot.state {state:"working"|"awaiting"|"idle", turnId, outcome?}`, `bot.tool {label, turnId}`.
- `approval.asked {interactionId, prompt}`, `approval.settled {interactionId, outcome}`.
- `call.ended`, and `heartbeat` every 15 s.

The fast layer speaks on its own as the thread moves:
- **filler:** on `call.requested`, at most 3 per turn, 6 s apart, and only when nothing else is speaking.
- **approval:** on `interaction.opened`.
- **result / error:** on `turn.settled`. The result is skipped when the person spoke again after that turn began. A `(silêncio)` answer is never streamed. When the reply is already short and speakable (≤ 350 chars after cleanup, no code block, table, heading or list over 2 lines), the reply itself is spoken, links reduced to their text; otherwise the fast layer summarizes it.
- **Thread:** the spoken result is never written as a new message: the thread keeps only the bot reply (with `voice:true`, so it gets the voice mark). Acks, fillers, approvals and errors are written as spoken lines (`spoken:true`). If an ack repeats the reply (half or more of its content words), it is removed at `turn.settled` by a `content.completed` with the same `partId`, `value:""` and `retracted:true`.

### `POST /bots/:id/voice/session/:callId/utterance` → 202
Body `{"text":"…","interrupted"?:bool}` is one whole turn of the person, already joined by the app (see Turn taking). `interrupted:true` means the turn started by cutting the bot's voice. It does one of these:
- With no open approval and no bot turn running, or with `interrupted:true`, it cancels whatever the fast layer is saying, delivers the text to the main thread as a voice message and the fast layer acknowledges it once: `{"ok":true,"action":"message","deliveryId":"…","sessionId":"wrun_…","continuation":false}`.
- With a bot turn still running and `interrupted` false, the text is a complement: it is queued as the next delivery, nothing is cancelled, no ack is spoken, and the running turn's result is still spoken: `{…,"action":"message","continuation":true}`.
- With an open approval, it classifies the answer. Regex first (`sim`, `pode`, `claro`, `manda`… / `não`, `para`, `cancela`…), then the fast layer.
  - `{"ok":true,"action":"answer","interactionId":"…","optionId":"approve"|"deny"}`: **the app then answers through the existing route** (`POST {sessionBasePath}/session/:id {"answers":[…]}`).
  - `{"ok":true,"action":"repeat","interactionId":"…"}`: the server asks again.

### `POST /bots/:id/voice/session/:callId/interrupt` → 200 `{"ok":true,"interrupted":"speech_…"|null}`
The person talked over the bot. It cancels the current fast-layer line and the queued ones; the bot turn keeps running.

### `DELETE /bots/:id/voice/session/:callId` → 200

## Turn taking (app, 19/11)

The app owns turn taking, because only it sees partials, mic energy and whether the bot is audible. Scribe VAD closes after 0.9 s of silence (`VOICE_VAD_SILENCE`).
- **Joining:** after a commit the app waits 1.2 s; a new commit or a partial in that window joins the same turn (a partial extends the wait to 2.4 s). One turn is one POST `utterance` and one message in the thread.
- **Backchannel:** while the bot speaks, thinks or just spoke (2 s), a commit under 3 words that opens no turn is dropped when it is only fillers (`tá`, `uhum`, `ahn`, `ok`…) and otherwise carried into the next turn. With an open approval, short answers always go.
- **Barge-in:** only with the bot audible, energy over the playback threshold (0.62 on the 0…1 level, 0.45 otherwise) for 0.6 s and a partial of 3+ words that is not echo. Then the app stops playback, closes the TTS contexts and calls `interrupt`.
- **Echo:** transcripts heard while the bot is audible or up to 2 s after are dropped when they match what the bot said (bigram or word overlap ≥ 0.6). During playback the mic is half-duplex: chunks under the playback threshold go to Scribe as silence (0.4 s hangover).

## Voice mark in the thread

- `delivery.consumed.data.voice: true` on spoken lines.
- `content.completed.data.voice: true` on the reply parts of a voice turn.
- A voice turn gets an extra system note: answer short, result first, no tables.

## Client wiring (ElevenLabs)

- **Scribe:** send `{"message_type":"input_audio_chunk","audio_base_64":"…","commit":false,"sample_rate":16000}` with 16 kHz mono PCM16 chunks of about 100 ms, all the time, and silence while muted, because Scribe drops the socket after 15 s without messages. Read `partial_transcript` (live captions, barge-in) and `committed_transcript` (VAD end of turn, then POST `utterance`).
- **TTS (multi-context):**
  - Open the socket once per call.
  - For each `speech.started`, init a context: `{"text":" ","context_id":"<speech id>","voice_settings":{"stability":0.5,"similarity_boost":0.8,"speed":<voice.speed>}}`.
  - Send deltas with `{"text":"… ","context_id":…}`. Add `"flush":true` at sentence ends and on `speech.done`.
  - On barge-in or `speech.cancelled`, send `{"context_id":…,"close_context":true}`.
  - Audio comes back as base64 PCM16 at 24 kHz in `audio`, with `contextId`.
- **Measured (VPS → ElevenLabs):** first audio about 390–520 ms after the flushed text, and token mint about 330 ms.

---

# v15 (19/11): human approvals

`interaction.opened.data.request` can now carry what the action is about, so the app never has to show `@e1`:

```json
{"interactionId":"…","request":{"kind":"approval","display":"confirmation","allowFreeform":false,
 "options":[{"id":"approve","label":"Aprovar"},{"id":"deny","label":"Negar"}],
 "prompt":"Posso clicar em “Entrar”?",
 "target":{"label":"Entrar","role":"button","url":"https://mail.google.com/"},
 "previewImage":"data:image/jpeg;base64,/9j/…",
 "reason":"Para abrir sua caixa de entrada"},
 "subject":{"callId":"call_…"}}
```

- `target` (optional): `label` is the element's accessible name (empty when it has none), `role` is the ARIA role for the browser (`button`, `link`, `textbox`…), the AX role for the Mac (`AXButton`…), or `page` / `app` / `desktop`. `url` is the page the bot is on (browser) or the URL being opened. `app` and `bundleId` name the Mac app (`computer_*`, from the last `computer_ui_tree`).
- `previewImage` (optional): a JPEG data URL, at most 360 px wide, cropped from a fresh screenshot around the target with 28 px of margin. Sent for `browser_click` / `browser_fill` (the element is scrolled into view first) and `desktop_click` (around the point). Missing when the capture fails or the user has control.
- `reason` (optional): the bot's own short sentence. `browser_click`, `browser_fill`, `desktop_*` and `computer_click` / `computer_type` / `computer_key` / `computer_open` accept an optional `reason` argument; it is stripped before the call reaches the Mac runner.
- Where the bot runs:
  - Browser: refs resolve through `refs` from the last `browser_snapshot` (agent-browser `snapshot -i --json`), then through the snapshot line.
  - Mac: `elementId` resolves through the last `computer_ui_tree` of that bot (title, then description, placeholder, value).
- `prompt` and `capability.label` use the element's name too: `Posso clicar em “Entrar”?`, `Clicar em “Entrar”`, `Preencher “E-mail”`. A ref without a name falls back to `um elemento` / `um campo`, never the ref. `computer.action.summary` uses the same label.
- Not supported: “sempre permitir neste site/app”. Options stay `approve` / `deny`.
- `GET /bots/:id/browser/screenshots/<file>.png` (alias `browser/shots/…`) → 200 PNG: the screenshot taken after one browser action. `<file>` is the last path component of `call.settled.output.screenshot`; only `[\w-][\w.-]*\.png` is accepted and it is read from `data/bots/<id>/browser/shots/` only. 404 when it no longer exists.
- `GET /bots/:id/browser` now also returns `alive` (boolean): whether the bot's agent-browser session is still running (`agent-browser session list`). The app uses it to choose between the live view and the last screenshot of the action with "Abrir de novo".

---

# v16 (19/11): skills in the composer ("/")

## `GET /skills?query=` → 200

```json
[{"slug":"commit","name":"Commit","description":"Quando o usuário pedir para commitar, fazer commit, criar commits ou organizar mudanças no git."}]
```
- Source: runelay REST `GET /v1/skills` (same origin and token as `RUNELAY_MCP_URL` / `RUNELAY_MCP_TOKEN`), enabled skills only.
- No `query`: every skill (pages of 100), sorted by name, cached 60 s. With `query`: runelay's own server-side search (`?query=`), first 100 hits, cached 30 s per term. `?refresh=1` skips the cache.
- `name` is runelay's name; when that is just the slug, it becomes readable (`acompanhar-missoes` → `Acompanhar missoes`). `description` is the first sentence, cut at 140 chars.
- `503` when runelay isn't configured, `502` when it doesn't answer.

## Field `skills` on send

`POST /bots/:id/eve/v1/session` and `POST /bots/:id/eve/v1/session/:sessionId` accept `"skills": ["commit", …]` (up to 5 slugs, `[a-z0-9][a-z0-9_.-]{0,119}`).
- The server loads each skill with runelay `GET /v1/skills/:slug` (cache 60 s). Unknown slug → `400 {"field":"skills","error":"Essa skill não existe mais na runelay."}`; nothing is delivered.
- `message` can be empty when `skills` is set: the turn text becomes `/Nome` for each skill.
- The turn's system prompt gets, per skill: `## Siga a skill <nome>`, the line "A pessoa anexou esta skill à mensagem. Siga as instruções dela neste turno.", the SKILL.md body (cut at 40 k chars) and, when the bot has `connectors.memory`, the list of the skill's files to read with `skill_read(slug, path)`.
- `delivery.consumed.data.skills = [{"slug","name"}]`, so the Mac shows the chips above the user bubble, also when loading history.

## Mac

- Typing `/` at the start of the composer or after a space opens a menu above it: "Comandos" (`/novo-bot`, `/limpar` since v17) and "Skills" (icon, name, one-line description). The skill list comes from `GET /skills?query=` with a 140 ms debounce. ↑↓ moves, ↩/Tab picks, Esc closes.
- A picked skill becomes a removable chip inside the composer (⌫ on an empty field removes the last one). Several are allowed (max 5).

## Verified 19/11

- `GET /skills` → 176 skills; `?query=commit` → Commit, Resolver pr, Pr summary, … Unknown slug → 400; `"skills":"x"` → 400.
- One real turn on `teste-de-voz` (Haiku) with `skills:["animation-vocabulary"]`: "Como se chama o efeito do popover que abre quicando?" → "**Pop in**: …", the term from the skill. `delivery.consumed` carried `skills:[{"slug":"animation-vocabulary","name":"Animation vocabulary"}]`. Usage 2 / 441 / 0 / 9,697. No side effects.

---

# v17 (19/11): clear conversation

## `POST /bots/:id/thread/reset` → 200

Starts a new thread for the bot. The old one is archived on disk (`data/threads/archive/<botId>/<archiveId>.json` keeps its thread state; its session NDJSON stays in `data/sessions`, nothing is deleted).

```json
{"sessionId":"wrun_01M7T6CGEKFCES0TK7HP0WE28F","lastMessage":null,"unread":0,"total":1,"running":false,"archiveId":"tha_01M7T6CGEH1SKZDN8WCFNHVHWK"}
```
- New `sessionId`: the visible conversation is empty (only `session.started`) and the model context starts from zero (no provider session, no carry-over, no pending notes). Reopen the stream on the new `sessionId`.
- Routines and memory are untouched: schedules keep firing into the bot's (new) thread and the per-schedule reply summaries are copied over; runelay memories are not touched.
- `GET /bots/:id/sessions` lists only the current thread; archived threads don't show there.

## `POST /bots/:id/thread/restore {"archiveId":"tha_…"}` → 200

Undo: the archived thread becomes the bot's thread again (same `sessionId`, history, `lastMessage` and `unread` as before the reset) and its archive file is removed. If the thread being replaced already has messages, it is archived in turn and its id comes back as `archiveId`; otherwise `archiveId` is `null`.

```json
{"sessionId":"wrun_01M7T5FFDSBKRWK4283AG0AJWY","lastMessage":{"role":"bot","text":"Beleza, qualquer coisa é só chamar.","at":"2026-11-19T15:18:42.222Z"},"unread":0,"total":207,"running":false,"archiveId":null}
```
- Malformed `archiveId` → `400 {"field":"archiveId"}`. Unknown or already restored → `404 {"ok":false,"error":"Essa conversa arquivada não existe mais."}`.

## Turn in progress

Both routes answer `409 {"ok":false,"code":"turn_running","error":"O bot ainda está respondendo. Pare a resposta antes de limpar a conversa."}` while the thread has a turn running or a delivery queued (also during the gap between `POST …/session/:id` and `turn.started`). Nothing is cancelled for you: a running turn may be waiting on an approval or in the middle of a browser/computer action, and its late events would land in a thread the person no longer sees. Cancel it first (`POST …/session/:sessionId/cancel`) and retry.

## Mac

- `/limpar` in the composer's "/" menu, "Limpar conversa" in the bot's context menu (sidebar), and ⌘K with the conversation open.
- No confirmation: messages leave with a spring fade + slight rise (plain fade with Reduce Motion), and a "Conversa limpa · Desfazer" notice stays a few seconds. Desfazer calls restore. The sidebar preview follows the new thread.

## Verified 19/11

`teste-de-voz`: reset → new `sessionId`, `total` 1, `lastMessage` null, `/sessions` shows only the new thread. Restore with the returned id → original `sessionId`, `total` 207, last message back. Restoring the same id again → 404; `archiveId:"x"` → 400. The 409 path was not exercised live: `teste-de-voz` was soft-deleted during the check (sending gives `bot_deleted`) and the only active bots were Boss and Davi.

---

# v18 (19/11): artifacts (HTML pages the bot builds)

Every bot has two tools on the `bots` MCP server, with no approval (they only write local files):

- `artifact_create {"title","kind":"slides"|"dashboard"|"page","html"}` → `{"artifactId":"art_…","title","kind","version":1}`.
- `artifact_update {"id", "html"? , "edits"?: [{"old","new"}], "title"?}` → same shape with the new `version`. `edits` must match the latest version exactly and once; otherwise the call fails with a pt-BR message and no version is written.

HTML must be a full document (`<!doctype html>`/`<html>`/`<body>`), at most 600 000 characters. Files: `data/bots/<botId>/artifacts/<artifactId>/v<N>.html` + `meta.json`.

The system prompt carries a guide (`artifactGuide` in `src/artifacts.ts`): self-contained HTML, dark theme, responsive; slides as `<section class="slide">` with ←/→ and a counter, exposing `window.slideCount` and `window.goToSlide(i)`; dashboards with Chart.js; no invented data; short design rules (hierarchy, few colors, big numbers, no slop).

## Stream

After the tool's `call.settled`:
```json
{"type":"artifact.created","data":{"artifactId":"art_Z9IRi4jSWofA","title":"Como funciona a fotossíntese","kind":"slides","version":1,"botId":"teste-html","callId":"call_…"}}
{"type":"artifact.updated","data":{"artifactId":"art_Z9IRi4jSWofA","title":"Como funciona a fotossíntese","kind":"slides","version":2,"botId":"teste-html","callId":"call_…"}}
```
The `call.settled` output is the tool result without the internal event.

## Routes

- `GET /bots/:id/artifacts` → 200, newest first: `[{"id","title","kind","createdAt","updatedAt","version","url","versions":[{"n","createdAt","size","url"}]}]` (`url` is relative, e.g. `/bots/teste-html/artifacts/art_…/v/2.html`).
- `GET /bots/:id/artifacts/:artifactId` → 200 the same object; 404 `{"ok":false,"error":"Artefato não encontrado."}`.
- `GET /bots/:id/artifacts/:artifactId/v/:n.html` → 200 `text/html`, 404 `{"ok":false,"error":"Versão não encontrada."}`. Headers:
  `content-security-policy: default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; font-src https://fonts.gstatic.com data:; img-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `cache-control: no-cache`. Only GET (HEAD gives 404).

## Mac

- Transcript entry `.artifact(ArtifactRef)` → `ArtifactCard`: live thumbnail (WKWebView, `pageZoom` = width/1280, no hit testing), title, "Apresentação"/"Dashboard"/"Página", "· vN" when N > 1. The completed `artifact_*` tool row is hidden.
- `ArtifactViewerLayer` (RootView, above sheets): scrim + panel like `ModalOverlay`, interactive WKWebView loading the server route (CSP applies), version menu, "Abrir no navegador" (saves `~/Downloads/<título>.html` with the CSP as `<meta>` and opens it), "Exportar PDF" (`~/Downloads/<título>.pdf`; slides: offscreen 1280×720 WKWebView, `goToSlide(i)` or arrow keys, one landscape page per slide via `createPDF` + PDFKit), ⇧⌘F presents full screen (window full screen + edge-to-edge), esc leaves/closes, "…" → copy link.
- Inspector tab "Biblioteca" (`InspectorTab.library`) lists `GET /bots/:id/artifacts`, reloaded on every artifact event.

## Verified 19/11

Test bot "Teste HTML" (Sonnet 5.5): 4-slide deck + Chart.js dashboard from fixed data, then `artifact_update` by edits → v2 with `goToSlide`. curl over the tailnet: 200 with the CSP header; unknown version and `..` id → 404. Mac build + `make-app.sh` signed "runelay bots Local".

---

# v20 (19/11): canvas (editable diagrams, bot + person)

A canvas is an artifact with `kind: "canvas"`. Instead of HTML, every version is a JSON document: `data/bots/<botId>/artifacts/<artifactId>/v<N>.json` + `meta.json`.

```json
{"schema":1,"layout":"flow"|"mindmap"|"diagram",
 "nodes":[{"id","text","x","y","w","h","shape":"box"|"round"|"diamond"|"ellipse"|"note","color"?}],
 "edges":[{"id","from","to","label"?,"style"?:"dashed"}],
 "groups"?:[{"id","label","nodeIds"}]}
```
`x,y` are the top-left corner in world points; `w,h` come from the text when missing. `color` is one of `neutral grey red orange amber yellow green teal blue indigo violet pink`; without it each shape has a default (ellipse green, diamond yellow, box/round blue, note neutral). At most 400 nodes and 800 edges. Edges pointing to unknown nodes are dropped.

`meta.json` gains `versions[].author` (`"bot"`|`"user"`) and `canvas: {seen, notified}`: the last version the bot produced or read, and the last user version already reported to it.

## Bot tools (all bots, no approval, `src/canvas.ts`)

- `canvas_create {"title","kind"?: "flow"|"mindmap"|"diagram","nodes":[{id,text,shape?,color?,x?,y?}],"edges":[{from,to,label?,style?}],"groups"?}` → `{"artifactId","title","kind":"canvas","version":1,"nodes","edges"}`. If any node lacks x/y, the server lays out everything: mindmap radial from the root (node with no incoming edges), flow/diagram layered top to bottom (DFS cycle breaking, longest-path layers, barycenter ordering, parent-centered x).
- `canvas_read {"id"}` → `{"artifactId","title","version","editedByPerson"?,"doc"}`: the latest state, including the person's edits. Marks it as seen.
- `canvas_update {"id","ops":[…],"title"?}` → same shape as create plus `editedByPersonBefore?`. Ops apply on the latest version: `add_node {text,id?,shape?,color?,x?,y?,parent?}` (no x/y: placed next to the connected node without overlapping), `update_node {id,text?,shape?,color?|null,x?,y?}`, `remove_node {id}`, `add_edge {from,to,label?,style?,id?}`, `update_edge {id,label?,style?}`, `remove_edge {id}|{from,to}`, `set_group {label,nodeIds,id?}`, `remove_group {id}`, `relayout {}`. Any error aborts the call with a pt-BR message; no version is written.
- System prompt guide (`canvasGuide`): use canvas instead of HTML for logic, flows, mind maps, architecture and processes; few words per box; ~25 boxes before grouping; read before changing something the person edited; no relayout over hand-placed positions.

## Routes

- `GET /bots/:id/artifacts/:artifactId/doc` → 200 latest doc + `"version"`. `GET …/v/:n.json` → that version. 404 for unknown versions. List/detail `url`s point to `.json` for canvases.
- `PUT /bots/:id/artifacts/:artifactId/doc {"doc", "baseVersion"?}` → 200 the artifact object. Saves with author `user`. Saves within 120 s of the previous user version (not yet seen by the bot) overwrite that version instead of creating one, so autosave does not flood versions. `baseVersion` older than a bot version → 409 `{"code":"stale","version"}` (the app reloads). Emits on the bot's thread session:
  `{"type":"artifact.updated","data":{"artifactId","title","kind":"canvas","version","author":"user","botId"}}`. Bot-made events carry `"author":"bot"`.
- `POST /bots/:id/artifacts/:artifactId/layout {"doc"}` → 200 the doc laid out (not saved). Used by "Organizar".

## Edit note

Before each chat turn (not schedules or groups), canvases whose latest version is the person's and newer than `seen`/`notified` add a short system block: `O canvas "X" (art_…) foi editado pela pessoa: +2 caixas ("…"), 1 caixa renomeada ("a" → "b"), +1 conexão (…), 3 caixas movidas.` plus "use canvas_read antes de mudar". Each edit is reported once.

## Mac (native SwiftUI, no WebView)

- `Stores/CanvasEditor.swift` (state, undo, autosave, shortcuts, Mermaid) and `Views/Artifacts/CanvasViews.swift` (surface, nodes, edges, toolbar, snapshot, export).
- Surface: drag background pans, two-finger scroll pans, pinch and ⌘scroll zoom, ⌘+ ⌘− ⌘0 (fit), dotted grid. ⇧ drag on the background = selection rectangle.
- Nodes in `Theme.surfaceRaised` (or palette tint), shapes box/round/diamond/ellipse/note; double click edits (Enter or click outside confirms, esc cancels). Double click on empty space creates a box. Tab = connected child, Enter = sibling (mind-map style). Click, ⇧ click, drag moves the selection, ⌫ deletes, ⌘Z/⌘⇧Z, ⌘D duplicates, ⌘A.
- Hover shows 4 handles; drag to another box connects (bezier with arrow), drop on empty space creates a connected box. Double click an edge to edit its label.
- Glass toolbar: shape, color, solid/dashed line, "Organizar" (animated relayout), zoom. Autosave 800 ms after the last change via PUT, "Salvando…"/"Salvo" top right.
- New boxes pop in with the Motion spring; relayout, undo and bot updates animate positions (edges are animatable shapes).
- Card in the conversation draws the latest doc natively (`CanvasThumbnail`); user-authored events do not add cards. Viewer opens the editor; "…" menu: Exportar PNG, Exportar PDF (ImageRenderer, light appearance, ~/Downloads), Copiar como Mermaid. Library lists canvases with the other artifacts. Completed `canvas_create`/`canvas_update` tool rows are hidden.

---

# v19 (19/11): code mode (any bot codes in a task worktree)

Code belongs to the conversation, not to the bot. There is no `capabilities.code` and no toggle: any bot can open a repository at any time. Each conversation (session) gets its own git worktree and branch, so many bots can code in the same repo in parallel.

## Repositories

`GET /code/repos?query=&refresh=1` → 200, sorted by name. Scans `CODE_REPO_ROOTS` (default `/home/anderson/projects/conty-dev,/home/anderson/projects`) for folders with a `.git` directory, skipping `worktrees/` and bind-mounted duplicates (same dev+inode). Cached 30 s.
```json
[{"name":"conty-api","path":"/home/anderson/projects/conty-dev/conty-api","location":"conty-dev","branch":"feat/overlays-compartilhaveis"}]
```
A name can appear twice when two different clones exist (`conty-lp` under `conty-dev/` and `projects/`); resolution by name takes the first root (`conty-dev`).

## Opening a workspace

Three ways, same result:
1. **Tool** `workspace_open({repo, task})` (MCP `bots`, every bot, no approval). `repo` is a name (exact, case-insensitive, then loose match; ambiguous → the tool lists the options and the bot asks) or an absolute path.
2. **App**: `POST /bots/:id/code/workspace {"repo","task"?}` (`?sessionId=`, default = the bot's thread). `409` while a turn runs.
3. **Mention**: `@<repo-name>` in a chat message opens it before the turn starts (bot ids/names win over repo names).

What happens:
- `git fetch origin` (45 s, errors ignored), base = first of `origin/develop`, `origin/main`, `origin/master`, `develop`, `main`, `master`, `HEAD`.
- `git worktree add -b feat/<slug> <CODE_WORKTREES_DIR>/<repo>-<bot>-<slug> <baseCommit>` (default dir `/home/anderson/projects/worktrees`). Slug from the task (≤ 40 chars); `-2`, `-3`… when the folder or branch exists.
- Dependencies: never a symlink. The lockfile decides (`bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `npm ci`), in the background, log in `data/code/<id>/install.log`. `dev_server_start` waits for it.
- The same repo again in the same conversation reuses the worktree (`reopened`).
- Mid-turn switch: when `workspace_open` succeeds, the server ends the current provider run itself (~300 ms after the tool result) and continues **the same turn** in a fresh provider session with cwd = worktree, a summary of the conversation and the original request. Leaving it to the model failed: it read "end your answer" and called `workspace_close`.
- Provider sessions are keyed `account@workspaceId` (Claude Code stores sessions per cwd).

`workspace_close()` (or `DELETE /bots/:id/code/workspace`) turns code mode off, stops the dev servers, keeps the worktree and branch, and clears the provider sessions so the next turn starts with a summary.

Events (no turn scope unless noted):
```json
{"type":"code.workspace","data":{"action":"opened|reopened|closed|failed","id":"conty-lp-dev-teste-botao-hero…","repo":"/…/conty-lp","repoName":"conty-lp","path":"/…/worktrees/conty-lp-dev-teste-botao-hero…","branch":"feat/botao-hero-black-friday-garantir-meu","base":"origin/develop","task":"…","active":true,"install":{…}}}
{"type":"code.install","data":{"workspaceId":"…","status":"running|done|failed|skipped","manager":"npm","command":"npm ci --no-audit --no-fund","durationMs":9097,"error?":"…"}}
```

## Turns in code mode

- **Claude (VPS)**: the SDK runs with `tools: ["Read","Edit","MultiEdit","Write","Glob","Grep","Bash","TodoWrite"]`, `cwd` = worktree, `permissionMode: "default"`, `mcp__bots` still allowed. Every native call goes through a `PreToolUse` hook (gate, up to 900 s for a person) and `PostToolUse`/`PostToolUseFailure` (settle + diff). Claude Code 2.1 has no `MultiEdit`; the name is passed and ignored.
- **Codex (VPS)**: `-s workspace-write -C <worktree>`, shell on. No per-call gate is possible (no hook); the sandbox blocks network and writes outside the worktree, so `git add`/`commit` fail there (the worktree's gitdir lives in the main repo). Commands and file changes show as `call.*` with ids `ext_<item>`, and edits arrive at the end of the turn (sweep).
- **Cursor, Grok, any `mac:*` account**: no code tools; the system prompt tells the bot to ask the person to pick a Claude or Codex model of the VPS.
- Delegated bots do not get code mode in v19.
- Every bot's system prompt has a "## Código" section (repo list, `workspace_open`, ask when the repo is not obvious, commit/push/PR only through `workspace_deliver` when the person asks). With a workspace open, "## Repositório aberto" adds path, branch, base, install status, running dev servers and the rules.

Native calls render like any tool, with `capability.surface:"code"`, `callId` = the SDK `toolu_…`, and pt-BR labels (`Ler x.tsx`, `Editar x.tsx`, `Criar x.ts`, `Procurar “…”`, Bash uses its `description` or `Rodar <cmd>`). `input` is trimmed (Write → `{file_path, lines}`, Edit strings ≤ 2 k, paths relative to the worktree); `output` too (Bash stdout tail 4 k / stderr 2 k).

## Diffs: `code.edit`

After each Edit/Write (hook) and at the end of every turn (sweep of files changed by Bash, codegen or Codex), one event per file:
```json
{"type":"code.edit","data":{"callId":"toolu_…|null","workspaceId":"…","path":"src/components/lp/black-friday/black-friday-hero-cta.tsx","absPath":"/…","outside":false,
 "before":"…full text or null…","after":"…","hunks":[{"oldStart":11,"oldLines":7,"newStart":11,"newLines":7,"lines":[" import …","-  pt: { label: \"Aproveite a Black\" },","+  pt: { label: \"Garantir meu desconto\" },"," …"]}],
 "added":2,"removed":2,"created":false,"deleted":false,"source":"tool|sweep"},"scope":{"turnId":"turn_1"}}
```
Hunks come from `git diff --no-index -U3` on the server. `before`/`after` are `null` above 200 kB (then no context expansion). The sweep skips files already reported with the same content in the turn.

## Changes panel routes (`?sessionId=` optional, default thread)

- `GET /bots/:id/code` → `{workspace:{…, files, added, removed}|null, files:[{path,status,added,removed,binary}], servers:[…], checkpoints:[{turnId,at,workspaceId}], running}`. Changes are against the task's `baseCommit` (committed + uncommitted + untracked), so they survive an approved commit.
- `GET /bots/:id/code/files` (`?fresh=1`).
- `GET /bots/:id/code/diff?path=` → `{path,status,added,removed,binary,hunks,patch,before,after}`; without `path` → `{files:[{…,hunks}], patch}` ("Ver tudo").
- `POST /bots/:id/code/revert {"path"}` → restores the file from `baseCommit` (or deletes it when it did not exist); emits `code.reverted {path, by:"user"}`.
- `GET /bots/:id` and `GET /bots` carry `"code":{"repoName","branch","path","files","added","removed","running"}|null` (cached 3 s) for the sidebar badge. `hasBrowser` is true while the bot codes.

## Approval: one order for every code action

hard rules (deny or person) → remembered grant for this repo → automatic read/dev → Jev → person.

- **Parse, not regex.** `code-policy.ts` has its own conservative shell parser: quotes, `&&`, `||`, `;`, `|`, newlines, `$( )`, backticks, `<( )`, `${ }`, redirections (`>`, `>>`, `2>`, `&>`, `<<<`), heredocs (body is data), subshell parentheses. Each segment is judged with the `cd` cwd carried along; `bash -c '…'` is parsed recursively; `find -exec` and `xargs` judge the inner command. Unbalanced quotes/parens, a missing heredoc end or a stray `&` → **person** (fail-closed). A command name built at runtime (`$CMD`, `$(…)`) → person. Anything piped into `sh/bash/node/python…` without a script → person (`git status && curl … | sh` is caught).
- **Hard rules (person, never remembered):** `git push`, `git commit`, rebase/merge/reset --hard/clean -f/branch -D/tag/remote changes/worktree add|remove, `gh pr create|merge` and other GitHub writes, `sudo`, deploys (`wrangler deploy|secret|… --remote`, vercel/netlify/fly/…, any `deploy` script), Supabase remote/linked/push, migrations to prod, DB clients (`psql`…), package publish, `ssh/scp/nc…`, system commands (`kill`, `systemctl`, `apt`…), writes or `rm` outside the worktree (and `/tmp`), reading secret files (`.env*`, `.ssh`, `*.pw`, credentials…), editing outside the worktree.
- **Protected paths (denied outright, even inside the worktree):** anything under `.git/` (hooks, config), `.claude/`, `.grok/`, `.cursor/*hooks|permissions|mcp.json`, `.env*` / `.dev.vars`, `server-sdk/data`, `server-sdk/.env.local`, `~/.claude*`, `~/.codex`, `~/.ssh`, `~/.config/systemd`. `git config` writes are denied too. `call.settled.error.code` is `TOOL_POLICY`.
- **Automatic:** Read/Glob/Grep inside the worktree or under `~/projects` (not secrets), Edit/Write inside the worktree, TodoWrite, and Bash made only of read/dev commands (git status/diff/log/add…, ls/cat/rg/sed/find…, npm/pnpm/bun run/test/build, npx vitest/tsc/biome, node/tsx, curl to localhost, rm/mv/cp inside the worktree). `&` at the end is denied with "use dev_server_start".
- **Soft (rememberable):** unknown programs (→ Jev first), `curl` to an outside host, `npm i <pkg>`, reads outside `~/projects`. The card then has a third option `{"id":"approve_always","label":"Sempre neste repositório"}` and `request.grant` = `"curl example.com em conty-lp"`. Answering `approve_always` stores the grant key in `data/code/grants.json` (per repo path); next time `decision.made` has `outcome:"granted"` and `call.started.clearedBy = {"grant":"curl example.com"}`. `GET /code/grants`, `DELETE /code/grants {"repo","key"}`.
- Batch: several open approvals are answered with one `answers` array (already supported); the app shows "Permitir todos / Agora não para todos".
- Schedule turns deny anything that needs a person.

## Dev servers and testing in the browser

Tools (only while a workspace is open): `dev_server_start({cmd, port?, cwd?})`, `dev_server_stop({port?})`, `dev_server_logs({port?, lines?})`.
- `cmd` goes through the same command gate. Runs `bash -lc` detached (own process group) in the worktree, `PORT`/`HOST=127.0.0.1`, free port from `DEV_PORT_BASE` (5310). `{port}` in `cmd` is replaced; otherwise `npm run x` gets `-- --port N` and vite/next/astro/wrangler/pnpm/bun get `--port N`. Waits until the port answers (127.0.0.1 or ::1, 120 s) and returns `url` (`http://localhost:N`) and the last 25 log lines. Log in `data/code/<id>/dev/<port>.log`, 400-line ring in memory.
- The bot tests with its own browser (`browser_open` on that url, `browser_screenshot`, clicks); the app's live view shows it.
- Events: `code.devserver {action:"started"|"exited"|"stopped", id, port, url, command, previewPath, status}`. `GET /bots/:id/code/servers`, `POST /bots/:id/code/servers/stop {port?}`. Servers stop on workspace close, rewind and server shutdown.

**Preview on the Mac** (authenticated gateway proxy): `GET /preview/<workspaceId>/<port>/?t=<token>` (token per server, in `previewPath`) sets the `rb_preview` cookie (HttpOnly, Secure, 12 h) and redirects to `/`. From then on, any path that is not an API prefix (`bots`, `code`, `meta`, `mcp`…) is proxied to that dev server, including WebSocket upgrades (Vite HMR). Without the cookie those paths stay 404. Apps whose own routes collide with an API prefix (e.g. `/bots`) won't preview there.

## Checkpoints and undo (files + conversation together)

- At the start of every turn with an open workspace (and when one opens mid-turn) the server snapshots the worktree into a hidden ref `refs/runelay/checkpoints/<sessionId>/<turnId>` (temporary index, `git add -A`, `write-tree`, `commit-tree` on HEAD; respects `.gitignore`). Event `code.checkpoint {turnId, ref, commit, workspaceId}`.
- `POST /bots/:id/code/rewind {"turnId":"turn_1"}` → `409` while busy. Restores the worktree files to that turn's checkpoint (or the first later one), deletes files created after it, resets the index, stops dev servers, marks that turn and every later one as reverted (`meta.revertedTurns`), drops provider sessions so the model forgets them, and emits:
```json
{"type":"turn.reverted","data":{"turnId":"turn_1","turnIds":["turn_1","turn_2"],"files":true,"restored":864,"removed":0,"checkpoint":"refs/runelay/checkpoints/wrun_…/turn_1"}}
```
- Commits approved in a reverted turn stay in the branch (the files are restored, HEAD is not moved): the working tree then shows the reverse change.
- Clients hide entries whose `turnId` is reverted. `recentExchanges` (summaries) skips them too.

## Deliver (separate from close)

`workspace_deliver({action:"commit"|"pr", message, title?, body?})` — always a hard person card ("Fazer commit de 1 arquivo na branch feat/x? Mensagem: “…”"). Same from the app: `POST /bots/:id/code/deliver {action, message}` (the click is the request; the app confirms first). Rules in code: conventional commit message, no AI signature (`Co-Authored-By`, `Generated with`). `commit` = `git add -A` + `git commit` with the repo's git identity; `pr` = commit + `git push -u origin <branch>` + `gh pr create --base <develop|main>`. Event `code.delivered {action, commit, prUrl, files, branch, base}`.

## Registry and cleanup

`data/code/worktrees.json` (`GET /code/worktrees`): `{id, path, repo, repoName, branch, base, baseCommit, botId, sessionId, createdAt, lastAccessedAt, status: alive|closed|delivered|stale|removed, pinned, prUrl}`. A collector runs 1 min after start and every 6 h: worktrees not active in any session, not pinned, untouched for `CODE_WORKTREE_TTL_DAYS` (14) and clean (no uncommitted changes, no unpushed commits) are removed with `git worktree remove` (never `--force`; the branch stays). Dirty ones become `stale` and stay.

## App (Mac)

- "+" in the composer: "Trabalhar num repositório…" (searchable list from `/code/repos`), "Ver mudanças" when open; `/repo` in the "/" menu; `@repo` in the text.
- Top of the conversation: one quiet line `repo · branch · N arquivos +a −r` (spinner while installing) that opens the Changes panel.
- Diff card per `code.edit`: file name strong, folder grey, `+N −M`, mono lines with one number gutter, removed lines on a subtle red, added on a subtle green, context runs collapsed into "⋯ N linhas" (expand on click, also before/after hunks from `after`), light regex highlight for ts/tsx/js, swift, sql, css, json, py, sh. Cards over 40 rows show "Mostrar tudo".
- Changes panel (modal): file list with `+/−` and status, full diff of the selected file, "Ver tudo", "Desfazer arquivo" (confirm), "Abrir no editor" (Zed CLI `zed ssh://<host><path>`, else VS Code Remote URL, else copies the path; host in `UserDefaults codeEditorHost`, default `anderson@vps.taile89599.ts.net`), "Abrir o app no Safari" (preview link), "Entregar" (commit / commit e PR), "Voltar para antes de um pedido" (rewind), "Fechar o repositório".
- Right click on a user message: "Desfazer este pedido (arquivos e conversa)".
- Sidebar: small `</> N` badge on bots whose thread has a workspace open (blue while working).
- Approval cards gain "Sempre neste repo"; two or more open approvals show "Permitir todos / Agora não para todos" above the composer.

## Verified 19/11 (separate instance on :2100, scratch data, schedules off, disposable repo)

Disposable repo: a snapshot of conty-lp re-initialized as a new repo in `worktrees/sandbox`, with `origin` pointing to a bare repo next to it (nothing could reach the real repo).
1. First try: the bot opened the workspace and then called `workspace_close` because the tool told it to "end the answer". Fixed with the server-side run switch above.
2. Second try (Sonnet 5.5, one message): `workspace_open` → `reopened` → checkpoint → Grep → Read → Bash `sed -i` (text + `bg-[color-mix(in_oklab,var(--bf-yellow)_88%,black)]`) → `dev_server_start` (`npm run dev -- --port {port}`, port 5610, after `npm ci` of 9 s) → `browser_open http://localhost:5610/pt` → screenshot → reply. `code.edit` (sweep, 2 hunks, +2 −2). `GET /code`, `/code/diff`, `GET /bots` badge and the preview proxy (302 + cookie, HTML and `/@vite/client` 200, 404 without cookie) checked with curl.
3. "faça o commit…": the bot used `workspace_deliver`, the hard card appeared, approved → commit `a48d818` in the sandbox, no push.
4. Rewind `turn_1`: text back to the original, turns 1–2 marked reverted, dev server stopped, checkpoints hidden.
5. `curl -sI https://example.com`: card with "Sempre neste repositório" → `approve_always` → second run `granted`, no card.
6. Policy unit run over 40 commands (pipes into sh, `$(rm -rf ~)`, heredocs, `cd .. && rm -rf`, protected `.git/hooks`, `git config`, `wrangler deploy`, `npm i lodash`, `find / -exec rm`…).
The test bot was deleted, the instance stopped and the sandbox removed. Not run live: Codex in code mode, MultiEdit, Vite HMR over the preview WebSocket, the worktree collector (no worktree is 14 days old), PR delivery (needs a real remote).

## Layout and look (19/11, second pass)

- Layered layout inserts dummy nodes for edges that skip layers, so a skipped branch gets its own column. Edges labelled sim/yes lean left and não/no lean right. A final pass pushes apart any boxes that overlap (gap 32), for mind maps too.
- Box size comes from the text: Virgil at 16 pt, wrapping only between words at 200 pt, line 24. Box/round/note: `w = max(120, text + 36)`, `h = max(56, lines·24 + 28)`. Diamond: `1.5·text + 48` × `1.6·lines·24 + 40`. Ellipse: `1.25·text + 44`. The server estimates 9.4 pt per character. The app measures with NSFont and refits sizes on load (center kept, not saved until the next edit). The edit diff compares centers, so a refit does not count as a move.
- The app routes edges: direct bezier, or around the right/left (above/below for horizontal edges) when the direct curve crosses another box. "não" from a vertical branch prefers the right side. Labels slide along the curve (t 0.5 → 0.2/0.8) to the first spot that is clear of every box.
- Excalidraw look: double-pass hand stroke with deterministic jitter per id (`CanvasRough`), hand-drawn chevron arrowheads, Excalidraw palette (dark: blue #4dabf7, green #69db7c, yellow #ffd43b, red #ff8787, violet #b197fc, neutral #e9ecef; light: the darker Excalidraw shades), 16 % fill plus diagonal hachure on colored shapes, neutral without fill. Text in Virgil (`Resources/Fonts/Virgil.woff2`, OFL, family "Virgil 3 YOFF"), with Chalkboard SE as the fallback. Selection is a dashed accent frame.
- Cursors: hand on the toolbar, menus, header, edges, labels and card; open/closed hand on boxes and on the background while panning; crosshair on connection handles; I-beam while editing.

## Verified 19/11

Bot "Teste Canvas" (Sonnet 5.5): a 3-level mind map (17 boxes, radial) and an approval flow with a "Valor acima de R$ 500?" diamond (sim/não). PUT on the flow renamed "Pagamento" → "Pagar reembolso", moved "Análise do pedido" and added "Aprovação do gestor" → "Fim" ("recusa"): a new user version, a second PUT merged into it, and `artifact.updated` with `author:"user"` appeared on the thread. Next message: the bot called `canvas_read` (`editedByPerson` listed the rename, the new connection and the moves), then `canvas_update` with ops and kept every edit (v4, `author:"bot"`). Layout preview of v4: sim on the left, não on the right, 0 overlaps. Bot deleted with `POST /bots/teste-canvas/delete`. Mac build + `make-app.sh` signed "runelay bots Local".

## v19.1 (19/11): diff ao vivo e painel novo

- **Causa do "sem mudanças":** edição por Bash (`sed -i`, `python3 <<EOF`) só virava `code.edit` na varredura do fim do turno, e o app só relia `/code` ao chegar um `code.*` ou `turn.settled`. Num turno longo (tsc rodando) o app ficava com a foto de antes das edições, e o selo da barra lateral usava essa foto.
- **Servidor (`code-live.ts`):** depois de cada Edit/Write/MultiEdit/Bash (hook) e de cada comando/edição do Codex, roda `git diff --numstat` + untracked na worktree (≈25 ms no conty-api) e emite, para cada arquivo que mudou desde a última varredura, `code.edit` **acumulado do turno** (`before` = conteúdo no início do turno) com `cumulative:true` e `key:"<turnId>:<path>"`. Mudou o total → `code.status {workspaceId, files, added, removed}`. O fim do turno é só mais uma varredura (`source:"sweep"`). Edição fora da worktree continua com o `code.edit` antigo (sem `key`).
- **App:** `code.edit` com `key` substitui o card daquele arquivo no turno e o leva para o fim (um card por arquivo, diff acumulado; hunks vazios = card some). `code.status` atualiza a contagem na hora. Grupo de passos rodando mostra o passo atual em linguagem humana ("Checando tipos", "Rodando os testes", "Editando x.ts"), traduzido do comando no app (`CommandPhrase`).
- **Pílula do topo:** vidro (Capsule), ícone de branch, repo, "13 · +118 −34"; branch no tooltip; spinner + brilho passando enquanto o bot trabalha. Clique abre o popover; o botão redondo ± abre o visualizador.
- **Popover (300 pt):** repo + copiar caminho + abrir no editor (Zed/VS Code); branch (copiar); Commit ⌄ (mensagem, Commit / Commit e PR, com confirmação); Mudanças +a −r → visualizador; Safari quando há dev server; Histórico (pedido, tempo relativo, relógio ↶ no hover com confirmação); "Fechar o repositório".
- **Visualizador:** lista estreita (nome + ±, caminho no tooltip) e diff ocupando o resto; "Abrir no editor" e "Desfazer arquivo" como ícones no cabeçalho do arquivo. O ↗ de um card abre o visualizador naquele arquivo.

- **Diff em blocos (19/11, 2ª rodada):** cada hunk é um card (Theme.surface) com cabeçalho "linhas a–b" e a seção da função quando o git dá (`hunks[].section`, texto depois do `@@`). Linhas ± com barra de 3 pt, fundo 16 %, sinal em negrito e diff de palavras no par removida→adicionada (LCS por token, desligado quando mais de 70 % da linha mudou). Entre blocos: "⋯ N linhas ocultas" numa linha, clicável. Lista de arquivos com 240 pt, só o nome e ±, caminho no tooltip; entradas +0 −0 somem e binário mostra "binário".
- **Popover (versão final, 19/11):** padding horizontal único (Spacing.m), linhas de 30 pt e cursor de mão em tudo que é clicável. O popover tem: repo + copiar caminho + editor (só os instalados: `dev.zed.Zed` com logo `zedindustries` do Simple Icons, `com.microsoft.VSCode` com o ícone do app, porque `visualstudiocode` dá 404 no Simple Icons) + "Copiar caminho"; linha da branch que copia; "Mudanças +a −r" → visualizador; Histórico; "Fechar o repositório". **Sem bloco de commit:** o usuário não usa, o commit é do bot via `workspace_deliver`, com o card. A rota `commit-message` foi removida. Histórico: `checkpoints[].request` = texto do pedido, "Boss pediu: …" (delegação), "Rotina: …", "Áudio de 0:26" / "Imagem" / nome do arquivo (anexo sem texto), ou `null`, e o app esconde o item. Clique no item = voltar para antes dele (com confirmação), ↶ aparece no hover. O botão ± ao lado da pílula e o selo `</> N` da barra lateral saíram.

Verificado 19/11 em instância separada (:2100) com bot e sandbox descartáveis: Edit e `sed -i` viraram card na hora; contagem 0 → 1 durante um `sleep 25` no meio do turno; duas edições do mesmo arquivo viraram um card acumulado (+2 −2). Build no Mac + `make-app.sh` assinado "runelay bots Local".

# v21 (19/11): runner do Mac embutido no app

O processo Node `~/runelay-bots/runner` (launchd `com.runelay.bots.runner`) saiu. O app runelay bots abre uma conexão de saída com o servidor e faz o papel do runner enquanto estiver aberto.

- `GET wss://<servidor>/runner/connect` com `Authorization: Bearer $RUNNER_TOKEN`. O app lê a chave em `~/Library/Application Support/runelay bots/runner.token` (chmod 600). Uma conexão por vez; a nova substitui a antiga. O servidor manda ping a cada 15 s; o app, a cada 20 s.
- Frames JSON (texto):
  - app → servidor: `{"type":"hello","app","version","capabilities":["turns","accounts","computer"]}`
  - servidor → app: `{"type":"request","id","op":"accounts"}` → `{"type":"response","id","ok":true,"result":[AccountProbe]}`
  - servidor → app: `{"type":"request","id","op":"computer.health"}` → `{"type":"response","id","status":200,"body":{…}}`
  - servidor → app: `{"type":"request","id","op":"computer.tool","tool":"files_list","body":{"args","context"}}` → `{"type":"response","id","status","body":{"ok","result"|"code","error"}}`
  - servidor → app: `{"type":"turn.start","id":<turnId>,"turn":TurnRequest}` → vários `{"type":"turn.event","id","event":ProviderEvent}` e por fim `{"type":"turn.end","id"}`; `{"type":"turn.cancel","id"}` encerra o processo da CLI.
  - app → servidor: `{"type":"computer.event","event":{"type":"stop"|"user_took_over","botId"}}`
- No app, cada turno roda a CLI local com `Process`, nos mesmos argumentos do runner: `claude -p --output-format stream-json --verbose --include-partial-messages` (prompt pelo stdin, MCP em `.mcp-bots.json` na pasta de trabalho, `--tools ""`, `--allowedTools mcp__bots`, `--permission-mode dontAsk`, `--setting-sources ""`), `codex exec --json`, `cursor-agent -p --output-format stream-json`, `grok -p --output-format streaming-json`. Pasta de trabalho continua em `~/runelay-bots/runner/data/work/<workKey>` para o `--resume` do Claude achar as sessões antigas.
- O executor do computador não escuta mais em 127.0.0.1:4791 e não grava `executor.token`; as ações chegam pela conexão.
- Servidor (`server-sdk/src/mac-runner.ts`): `accounts.ts`, `computer.ts` e o `upgrade` em `main.ts` usam o WebSocket quando conectado e caem no `MAC_RUNNER_URL` (HTTP antigo) quando não. Conectar ou cair recalcula só as contas `mac:*`. App fechado: `mac:*` = `offline` e as ferramentas do computador devolvem `COMPUTER_UNAVAILABLE`.
- Rollback: `~/runelay-bots/runner` ficou no disco; o plist está em `~/runelay-bots/backup/com.runelay.bots.runner.plist.bak` (voltar para `~/Library/LaunchAgents` e `launchctl bootstrap gui/$(id -u) …`).

# v22 (19/11): anexos (imagem, vídeo, áudio e arquivos), nos dois sentidos

Código em `server-sdk/src/uploads.ts`; app em `Models/Attachment.swift` e `Views/Conversation/AttachmentViews.swift`.

## Upload

`POST /bots/:id/uploads` com o arquivo como corpo bruto (sem multipart). Headers: `X-File-Name` (nome, percent-encoded) e `Content-Type` (ou `X-File-Type`); `application/octet-stream`, `x-www-form-urlencoded` ou vazio → tipo pela extensão. Limite 100 MB (413 `O arquivo passa de 100 MB.`), vazio → 400, bot excluído → 409.

→ 201:
```json
{"uploadId":"01M7TD7TJ7DQNS1TJ3Q7ME5H9W","name":"video.mp4","mime":"video/mp4","size":128628,"kind":"video",
 "url":"/bots/teste-anexos/uploads/01M7TD7TJ7DQNS1TJ3Q7ME5H9W","thumbUrl":"/bots/teste-anexos/uploads/01M7TD7TJ7DQNS1TJ3Q7ME5H9W/thumb.jpg",
 "width":640,"height":360,"duration":12,"waveform":[0.92,0.91,…]}
```
`kind`: `image` | `video` | `audio` | `file` (SVG é `file`). `uploadId` é um ULID. `width/height` (imagem/vídeo, já com rotação), `duration` (s, áudio/vídeo), `waveform` (48 picos 0–1, áudio ou vídeo com som), `thumbUrl` (vídeo, ou imagem > 640 px ou fora de png/jpeg/gif/webp), `source:"bot"` quando veio de `send_file`.

Disco: `data/bots/<id>/uploads/<ulid>-<nome>`, metadados em `uploads/.meta/<ulid>.json`, derivados em `uploads/.derived/<ulid>/` (thumb, `model.jpg`, `frames/`, `audio.mp3`, `doc-images/`, `prepared.json`). O processamento para o modelo começa logo após o upload e fica em cache.

## Servir

`GET|HEAD /bots/:id/uploads/:uploadId` → o arquivo, com `Range` (206), `accept-ranges`, `cache-control: private, immutable`, `nosniff` e `content-disposition: inline`. HTML/SVG levam CSP fechada. `…/thumb.jpg` → miniatura; `…/meta` → o JSON acima. Mesma proteção das outras rotas: só tailnet, sem token. Id desconhecido → 404 `Anexo não encontrado.`

## Envio

`POST {sessionBasePath}/session/:sessionId` (e a criação de sessão) aceitam `"attachments": ["<uploadId>", …]` (até 10). Pode ir sem `message`. Id inexistente → 400 `Um dos anexos não existe mais. Anexe de novo.` (`field: "attachments"`).

`delivery.consumed.data.attachments` traz a lista no formato do upload (é o que o app usa para redesenhar ao recarregar). `parts[0].text` fica `""` quando só há anexo; `lastMessage` do thread vira `📎 nome` ou `📎 N anexos`. Antes de chamar o modelo sai `attachments.preparing {count}` (o app ignora).

## O que o modelo recebe

O texto da pessoa ganha um bloco `Anexos da pessoa:` com uma linha por anexo, sempre com o caminho no servidor.

| Tipo | Claude na VPS | Codex, Cursor, Grok e qualquer conta `mac:*` |
| --- | --- | --- |
| imagem | bloco de imagem (base64), lado maior ≤ 1568 (ffmpeg → `model.jpg` se maior, > 3,5 MB, GIF ou outro formato) | caminho + tipo, dimensões e tamanho; o modelo é avisado de que não vê a imagem |
| áudio | `[áudio: …]` com a transcrição do ElevenLabs Scribe em lote (`POST /v1/speech-to-text`, `scribe_v2`, cai para `scribe_v1`) | igual |
| vídeo | duração, transcrição do áudio extraído (ffmpeg → mp3 16 kHz) e 6–10 quadros-chave espaçados (≈ 1 a cada 6 s, ≤ 1024 px) como imagens, com o tempo de cada um | duração + transcrição + pasta dos quadros |
| documento | markdown do **anydoc** + até 8 imagens embutidas como blocos de imagem | markdown + pasta das imagens |
| texto/código | o conteúdo | igual |
| outros | caminho + `attachment_read` | igual |

### Transcrição (áudio e som do vídeo)

- Fila no servidor: no máximo `UPLOAD_STT_CONCURRENCY` (padrão 1) chamadas batch ao Scribe ao mesmo tempo, para não disputar o limite de concorrência do plano Starter com a chamada de voz.
- Retry em 429, 5xx e erro de rede: esperas de 1 s, 3 s e 8 s com até 40 % de jitter, ou o `Retry-After` (segundos ou data, até 30 s) se for maior. 400/422 passa para o modelo seguinte (`scribe_v2` → `scribe_v1`); outro 4xx falha na hora.
- Se o Scribe ainda falhar e o app estiver aberto, o servidor manda o áudio (mp3 16 kHz mono, até 25 MB) ao Mac pela conexão do runner: `{"type":"request","id","op":"transcribe_file","body":{"audioBase64","name","locale":"pt-BR"}}` → `{"type":"response","id","ok":true,"result":{"text"}}` ou `{"ok":false,"error"}`, timeout 240 s. O app (`Voice/FileTranscriber.swift`) usa `SFSpeechURLRecognitionRequest` pt-BR, no aparelho quando houver modelo local, com pontuação; sem permissão de fala responde erro. O `hello` do app passa a anunciar `"transcribe"`.
- A transcrição fica no meta do upload (`transcript`, `transcriptSource: "scribe"|"mac"`). Turnos seguintes e `attachment_read` reusam; chamadas simultâneas do mesmo anexo esperam a mesma transcrição.
- `attachment_read` em áudio/vídeo devolve `{name, kind, duration, transcript}`. O rótulo da chamada é "Ler o áudio de 0:26", "Ler o vídeo de 0:12" ou "Ler <nome do arquivo>", nunca o id ("Ler o anexo" se o servidor reiniciou e ainda não leu aquele anexo).
- Verificado 19/11: áudio de 4 s → transcrito pelo Scribe, gravado no meta, relido por `attachment_read` com o rótulo "Ler o áudio de 0:04". Não exercitado ao vivo: o 429 em si e o fallback no Mac (o Scribe aceitou todos os formatos testados, e derrubar a chave pararia a voz).

Texto vai cortado em 60 000 caracteres; o resto se lê com `attachment_read`. Falha no processamento entra na linha como `(não consegui processar: …)` e o turno segue. Conversas de grupo não recebem anexos (o app não oferece).

Claude: com imagens, `shared/providers/claude.ts` passa o prompt como mensagem de usuário em streaming (`AsyncIterable<SDKUserMessage>`) com `[rótulo, imagem]…, texto`; `TurnRequest.images = [{path, mime, label}]`. O runner do Mac não recebe imagens.

## Documentos: anydoc

`@firecrawl/anydoc` **0.2.4** fixo no `package.json` (o 0.2.5 saiu em 18/11; ficou de fora por ser novo demais). Roda local no container, binário nativo `linux-x64-gnu`, sem chave e sem OCR hospedado (`ocr: "reject"`).

- Formatos: `.doc/.docx/.docm`, `.ppt/.pptx/.pps*`, `.xls/.xlsx/.xlsm/.xlsb`, `.odt/.ods/.odp`, `.rtf`, `.epub`, `.csv` e também `.pdf` (texto). Formato pelo conteúdo (`formatFromBytes`), senão pela extensão.
- `toMarkdownBytes` → markdown. `toDocument` (não existe para PDF/CSV) → `assets`: imagens > 2 KB, até 8, gravadas em `doc-images/`; png/jpeg/webp ≤ 1568 px passam direto, o resto vira jpg pelo ffmpeg.
- Fallback: se o anydoc falhar ou vier vazio, PDF vai pelo `pdftotext -layout` (poppler-utils, no Dockerfile) e texto/código é lido como UTF-8. PDF escaneado (`needsOcr`) cai no pdftotext, que também não faz OCR.

## Ferramentas do bot (todos os bots, sem aprovação)

- `send_file {path, name?}` copia um arquivo do servidor para os uploads (`source:"bot"`) e emite, depois do `call.settled`:
  `{"type":"file.sent","data":{"attachment":{…formato do upload…},"botId","callId"}}`. Só aceita caminhos (resolvidos com realpath) dentro da pasta de dados, de `/home/anderson/projects/worktrees`, de `/home/runelaybot` ou de `/tmp`; nega `.env*`, `.git`, `.ssh`, `.claude`. Arquivo do Mac da pessoa não dá (ficou para depois).
- `attachment_read {uploadId, offset?, limit?}` lê o texto (anydoc/pdftotext/UTF-8) em pedaços de até 200 000 caracteres; para binários devolve tipo, tamanho e caminho.
- O system prompt ganhou a seção `## Arquivos` (`uploadGuide`).

## App

- Anexar: ⌘V na caixa (arquivos copiados no Finder, ou PNG/TIFF sem RTF; TIFF vira PNG), arrastar para a conversa inteira (overlay "Solte para anexar"), "+" → "Anexar arquivo…" (NSOpenPanel, vários). Até 10 por mensagem. Grupos não têm anexo.
- Caixa: faixa de chips no topo, dentro da caixa (padding `Spacing.m`, rola na horizontal, 44 pt de altura); embaixo a linha "+ | texto | mic | enviar" alinhada ao fundo. Imagem/vídeo em miniatura (vídeo com ▶ e duração), áudio com onda (do servidor, ao terminar o upload) e duração, arquivo com ícone e nome; x dentro do canto. Upload começa na hora, com anel de progresso; falha → toque para tentar de novo. Enviar com upload em andamento espera e envia sozinho ("Enviando os anexos…").
- Conversa: anexos acima do texto da bolha (mensagem só com anexo também vira bolha). Imagens em grade (1 grande; 2/4 em 2 colunas; senão 3) que abrem no QuickLook (com setas entre as imagens da mensagem); vídeo com miniatura e player AVKit inline ao tocar (streaming por Range); áudio com player compacto (play/pausa, onda clicável para pular, tempo), um tocando por vez; arquivo como card que abre no QuickLook. Arquivos baixam para `~/Library/Caches/runelay bots/attachments/<id>/`.
- `file.sent` vira um card/miniatura do lado do bot; a linha da ferramenta `send_file` concluída fica escondida.

## Verificado 19/11

Bot "Teste Anexos" (Sonnet 5.5, `vps:claude`). Imagem 2400×1800 (fundo vermelho, retângulo azul, quadrado amarelo) → descrita certo, a partir do `model.jpg` 1568 px. Áudio feito com `say -v Luciana` (aiff, 8,3 s), enviado sem texto → transcrição exata ("…a senha secreta é girassol azul…") e resposta certa. Vídeo ffmpeg 12 s (vermelho/verde/azul + seno 440 Hz) → 6 quadros, o modelo descreveu as cores em ordem e o som como bipe sem fala. PDF feito à mão → código e faturamento certos (anydoc; o pdftotext também extraiu). `.docx` com imagem embutida e `.xlsx` gerados no container → anydoc deu markdown e tabela; a imagem do docx foi como bloco de imagem e o modelo a descreveu. `send_file` com o print do browser → `file.sent` com miniatura. Range (206) e `thumb.jpg` conferidos por curl. Build do Mac + `make-app.sh` assinado "runelay bots Local". Não testado ao vivo: Codex/Cursor/Grok com anexo (só o caminho no texto), upload perto de 100 MB, arquivo `.doc`/`.pptx`/`.epub` reais.

# v24 (19/11): delegação roda na conversa do bot delegado + status leve

## Servidor
- `delegate` não roda mais numa sessão escondida dentro da do Boss. O pedido vira uma entrega (`source: "delegate"`) na **thread principal** do delegado (`ensureThread`), com fila: se ele estiver no meio de um turno, espera a vez. Nunca roda dois turnos na mesma thread.
- Na thread do delegado: `delivery.admitted.source = {channel:"channel:delegate", botId, sessionId, callId}`, `turn.started.delegatedBy = <bot de origem>`, `delivery.consumed` com `source:"delegate"` e `from:{botId, name, sessionId, callId}`. Tool calls, texto, aprovações, `code.*` e workspace saem lá, como num turno normal (resume da sessão do próprio delegado). `lastMessage` da thread vira "Boss pediu: …" (role bot, sem unread).
- No Boss: o `call.requested` ganha `delegation:{botId}`; o progresso vem em `delegation.updated {callId, botId, sessionId, deliveryId, turnId?, status, summary?, error?}` com `status` = `starting|queued|working|awaiting|completed|failed|cancelled`. `call.settled.output` continua sendo a resposta final do delegado. Os passos internos não aparecem mais no Boss.
- Ciclo: delegar para quem já está esperando por você (direto ou em cadeia) falha na hora com erro claro, em vez de travar.
- Cancelar o turno do Boss **cancela o turno delegado** (tira da fila ou aborta, `turn.settled {outcome:"cancelled", reason:"Boss cancelou o pedido."}`), e o Boss recebe "Pedido cancelado.". Parar o delegado na conversa dele devolve "X parou antes de terminar." ao Boss.
- Formato velho (`owner.callId` + `origin.agent` no stream do Boss) continua sendo lido pelo app; nada migrado.
- Status: `GET /bots` → `thread.running` e `thread.status` (`working|awaiting|idle`). `GET /status` → `{bots:{id:status}}` (só não-idle). `GET /status/stream` (ndjson): `{"type":"snapshot","bots":{…}}`, depois `{"type":"status","botId","status"}` a cada mudança e heartbeat de 15 s. Grupos aparecem pelo id `grp_…`.

## App
- `status(for:)`/`mood(for:)` usam a conversa aberta; sem ela, o stream de status (fallback: `thread.running` do GET /bots). Um único stream para todos os bots; conversa só abre (`ensureThread`) para o bot que está recebendo uma delegação, para as aprovações dele notificarem.
- Boss: linha centralizada cinza, sem card: "[avatar] X está trabalhando…" → "Mensagem de [avatar] X" (clique abre a conversa dele), "X precisa de você" na cor de atenção quando há aprovação pendente lá. Várias delegações no mesmo turno: "N mensagens com [avatares] N bots", que expande uma linha por delegação. Sem texto do relatório: o Boss resume na bolha dele.
- Delegado: bolha "Boss pediu" com o personagem do Boss e o pedido em MarkdownView.

## Verificado 19/11
Bots de teste Chefe Teste → Ajudante Teste (apagados no fim). Ajudante `running:true` durante a tarefa, eventos na thread dele, Boss recebe "332". Fila: Ajudante ocupado → `queued` → `working` → `completed`. Aprovação (clique no navegador com autoaprovação desligada): `awaiting` no Chefe, card na conversa do Ajudante, respondido lá → `completed`. Cancelar o Chefe no meio: turno do Ajudante cancelado em ~2 s. Grupo com handoff Chefe → Ajudante sem mudança. `/status/stream` emitiu working/idle dos dois. Build no Mac + `make-app.sh` assinado "runelay bots Local". Sem print.

# v23 (19/11): cofre de segredos

O modelo nunca vê o valor. Segredos são chamados por apelido (`segredo:github-token`) e o valor entra só no último instante, dentro da ferramenta. Código: `server-sdk/src/vault.ts` (cofre, regras, histórico, rotas), `src/vault-tools.ts` (ferramentas e instruções), `src/redact.ts` (máscara), `server-sdk/bin/rb-secret-run.mjs` (Bash); app em `Models/Vault.swift`, `Stores/VaultStore.swift`, `Views/Conversation/SecretFormCard.swift`, `Views/Screens/VaultScreen.swift`, `Executor/FrontmostPage.swift`.

## Onde o valor fica

- **Padrão: Keychain do Mac.** Item `kSecClassGenericPassword`, serviço `com.runelay.bots.vault`, conta = nome, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, `kSecAttrSynchronizable = false` (não vai para o iCloud). As regras do segredo ficam no próprio item (`kSecAttrGeneric`, JSON), então o app confere a política com a cópia local, não com o que o servidor disser. O app tenta primeiro o Keychain de proteção de dados (com `SecAccessControl(.userPresence)` quando o Touch ID é "Sempre"); se a assinatura local não tiver o entitlement (`errSecMissingEntitlement`), cai no Keychain de login e o Touch ID é exigido pelo próprio app com `LAContext.evaluatePolicy(.deviceOwnerAuthentication)`. A assinatura estável "runelay bots Local" mantém o acesso entre versões.
- **Opção "usar com o Mac fechado"** (desligada por padrão, marcada na tela como menos segura): o app manda o valor uma vez (`PUT /vault/secrets/:name/server-copy`, só com HTTPS) e o servidor grava `data/vault/<nome>.enc` (0600) com AES-256-GCM, IV de 12 bytes e AAD `runelay-bots:vault:v1:<nome>` (trocar arquivos de nome quebra a decifragem). A chave tem 32 bytes em `~/.config/runelay-bots/vault.key` (0600, fora de `data/`), montada só leitura em `/run/runelay-bots/vault.key` (`VAULT_KEY_FILE`). Trocar o valor apaga a cópia do servidor até o app mandar a nova.
- **Metadados sem valor** no servidor: `data/vault/index.json` (0600) com `{name, description, domains, bots, touchId, expiresAt, storage: "mac"|"mac+server", kind, createdAt, updatedAt, rotatedAt, lastUsedAt, lastUsedBy, lastTool}`. Histórico em `data/vault/audit.ndjson` (0600): `{at, name, outcome, botId, botName, tool, domain, source, reason, by}`, nunca o valor. `outcome`: `created`, `updated`, `rotated`, `deleted`, `used`, `denied`, `revealed`, `server_copy_on`, `server_copy_off`.

## Regras por segredo

- `domains`: lista de sites. `github.com` vale para `github.com` e `www.github.com`; `*.github.com` vale para o domínio e qualquer subdomínio. Vazio = qualquer site. Com domínios, uso sem site conhecido é negado.
- `bots`: vazio = todos (padrão); senão, só os ids da lista.
- `touchId`: `always` (a cada uso), `hourly` (primeiro uso de cada hora, por segredo, na memória do app), `never`.
- `expiresAt`: depois disso, negado. O formulário com "Salvar no cofre" desmarcado grava com validade de 1 h.
- Servidor e app checam as mesmas regras (o servidor antes de pedir, o app de novo antes de responder).

## Resolução (servidor ↔ app pelo WebSocket do runner)

O app anuncia `"vault"` em `hello.capabilities`. Servidor → app:
```json
{"type":"request","id":"…","op":"secret.resolve","body":{"name":"github-token","botId":"lia","botName":"Lia","tool":"browser_fill","domain":"github.com"}}
```
App → servidor: `{"type":"response","id":"…","ok":true,"result":{"value":"…"}}` ou `{"type":"response","id":"…","ok":false,"code":"denied_domain|denied_bot|expired|cancelled|not_found|insecure","error":"frase em pt-BR"}`. Timeout 95 s (tempo do Touch ID). O app recusa (`insecure`) se o servidor não for https/wss. Ordem no servidor: fonte externa registrada (ponto de extensão) → Mac (se conectado com `vault`) → cópia cifrada do servidor (só com `mac+server`, e só quando o Mac está offline ou não tem o item) → erro "o Mac está offline". O servidor usa o valor e descarta; nada é gravado.

## Onde a referência funciona

| Ferramenta | Como | Site checado |
| --- | --- | --- |
| `browser_fill` | `text: "segredo:nome"`. Só referência = sem card de aprovação (a política é o portão). Preenche por `agent-browser batch` com o comando no stdin (o valor não aparece na lista de processos) e depois marca o campo com `-webkit-text-security: disc` e `autocomplete=off`, para os prints seguintes mostrarem bolinhas. | host da página aberta |
| `computer_type` | `text: "segredo:nome"`. O servidor repassa a referência; o app resolve localmente no Keychain (o valor nem passa pela rede) e pode digitar em campo seguro só nesse caso. O app grava o uso com `POST /vault/audit`. | host do documento da janela da frente (AXDocument; Safari expõe, outros podem não expor → segredo com domínio é negado) |
| `http_request` (novo) | `{method, url, headers?, body?, reason?}`; referência em cabeçalhos, corpo e URL (não no host). GET/HEAD sem card; outros métodos passam pelo Jev e, se preciso, por uma pessoa. Não segue redirecionamento (devolve `location`), bloqueia loopback, link-local e `*.internal`, timeout 30 s, corpo cortado em 20 000 caracteres. | host da URL |
| Bash no modo código (Claude na VPS) | `$SEGREDO_NOME` / `${SEGREDO_NOME}` (nome em maiúsculas, hífen vira `_`); `segredo:nome` vira `${SEGREDO_NOME}`. Depois do portão normal, o hook PreToolUse troca o comando por `node bin/rb-secret-run.mjs <porta> <tíquete> <comando em base64>`: o helper troca o tíquete (32 bytes, uso único, 60 s, só loopback sem cabeçalho de proxy) pelas variáveis em `POST /vault/exec/:ticket`, roda `bash -c` com elas e mascara stdout/stderr em fluxo. Comandos que convertem ou despejam o ambiente (`base64`, `xxd`, `od`, `rev`, `tr`, `cut`, `sed`, `awk`, `printenv`, `env`, `set`, `export`, `python`, `node`, `perl`…), redirecionam para arquivo, usam `tee` ou leem `/proc` são negados quando usam segredo. | hosts das URLs do comando (todas precisam ser liberadas; com domínio e sem URL = negado) |

Codex no modo código não tem hook: lá o segredo só serve pelas ferramentas MCP (`http_request`, `browser_fill`).

## Máscara (`src/redact.ts`)

Todo valor resolvido entra numa lista em memória por 30 min desde o último uso (sai antes ao apagar o segredo), com variantes: puro, escapado em JSON (1 e 2 níveis), URL-encoded, base64 (com e sem `=`) e base64url. São trocados por `••••` em: todo evento antes de gravar ou transmitir (`EventLog.emit` e `progress`), toda saída de ferramenta MCP que volta ao modelo, `stdout`/`stderr` do processo (logs do Docker), linhas do histórico, e a saída do Bash pelo helper. Valores com menos de 4 caracteres não são mascarados.

## Formulário seguro: `request_secret`

`request_secret({name, reason, description?, fields?: [{id, label, secure?}], domains?, kind?: "password"|"token"|"text"})`. Com mais de um campo, cada um vira `segredo:<name>-<id>`. Exige o app aberto (senão erro pedindo para abrir). Abre uma interação:
```json
{"type":"interaction.opened","data":{"interactionId":"…","request":{"kind":"secret","display":"secret_form","prompt":"Lia pediu um segredo: …","reason":"…",
 "options":[{"id":"approve","label":"Salvar"},{"id":"deny","label":"Agora não"}],
 "secret":{"name":"github-token","names":["github-token"],"reason":"…","description":"","kind":"password","fields":[{"id":"valor","label":"Valor","secure":true}],"domains":["github.com"],"botId":"lia","botName":"Lia"}},"subject":{"callId":"call_…"}}}
```
O app mostra o card com `SecureField`, o motivo, os sites e "Salvar no cofre" (ligado). Ao salvar: grava no Keychain, manda só os metadados (`PUT /vault/secrets/:name`) e responde `approve` na sessão. O servidor confere que os metadados mudaram e devolve ao bot `Ok, salvo como segredo:github-token`. "Agora não" responde `deny`. A linha da ferramenta `request_secret` fica escondida (o card já conta a história); "Permitir todos" não pega formulários.

`list_secrets()` devolve nomes, descrições, sites, se está liberado para o bot, onde está guardado e validade. Nunca valores.

## Rotas do cofre (todas com `Authorization: Bearer <RUNNER_TOKEN>`, só o app tem)

- `GET /vault/secrets` → `{"secrets":[{…metadados, "ref":"segredo:x","env":"SEGREDO_X"}],"serverStorage":true}`
- `PUT /vault/secrets/:name` `{description?, domains?, bots?, touchId?, expiresAt?, kind?, rotated?}` → metadados (cria ou atualiza; `rotated:true` apaga a cópia do servidor)
- `DELETE /vault/secrets/:name` → `{ok:true}` (apaga metadados e `.enc`, esquece a máscara)
- `PUT /vault/secrets/:name/server-copy` `{value}` (≤ 16 KB) / `DELETE …/server-copy`
- `GET /vault/audit?name=&limit=` (mais novo primeiro) / `POST /vault/audit` `{name, outcome: used|denied|revealed, botId?, botName?, tool?, domain?, reason?}`
- Sem token → `401 {"ok":false,"error":"O cofre só responde ao app runelay bots."}`. `POST /vault/exec/:ticket` é a única rota sem token (tíquete de uso único).

## Endurecimento junto

- Filhos (Claude Code, Codex, Bash) não herdam mais `RUNNER_TOKEN`, `JEV_API_KEY`, `RUNELAY_MCP_TOKEN` nem `ELEVENLABS_API_KEY` (`shared/proc.ts`).
- O portão do modo código trata como protegidos `~/.config/runelay-bots`, `/run/runelay-bots`, `/proc`, `vault.key` e `*.enc`.

## App

- Trilho de ícones: "Cofre" (`lock.shield`). Lista com nome, descrição, sites, "Mac" ou "Mac + servidor", último uso e por quem. Detalhe: referência com copiar, "Ver o valor" (Touch ID sempre, mostra 10 s), descrição, sites, bots (todos ou escolhidos), Touch ID (Sempre / A cada 1 h / Nunca), validade, "Usar com o Mac fechado" com o aviso de que é menos seguro, Salvar regras, Trocar valor (Touch ID), Apagar (confirmação) e histórico.
- Mudar o Touch ID entre "Sempre" e outro, ligar a cópia do servidor e trocar o valor pedem Touch ID.

## Ponto de extensão (1Password, fora de escopo agora)

`registerSecretSource({id, handles(meta), read(meta, request)})` em `vault.ts`. Uma fonte registrada atende os segredos que ela reconhece antes do Mac (por exemplo, um item com `op://…` lido pelo `op` CLI ou pela Connect API) e o histórico grava `source: <id>`. As regras do segredo continuam valendo antes da leitura. Nada está registrado hoje.

## Modelo de ameaça

Protege contra:
- o modelo (ou uma injeção de prompt) ler o valor: ele só manipula a referência; saídas com o valor voltam `••••`;
- o valor parar em `data/` (sessões, eventos, histórico, prints de campos preenchidos pelo cofre), no log do Docker ou nos transcripts do Claude Code;
- uso fora das regras: site, bot, validade e Touch ID checados no servidor e de novo no Mac;
- roubo do disco do servidor: só metadados e, na opção de servidor, cifrado com chave fora de `data/`;
- sincronização acidental: o Keychain não vai para o iCloud nem sai deste aparelho.

Não protege contra:
- quem tem shell no container ou no host como `anderson`: o servidor, a chave e o Bash do modo código rodam com o mesmo usuário, então um processo malicioso consegue ler a memória do servidor e a chave (o portão do modo código bloqueia os caminhos, mas não é uma fronteira de usuário);
- o site de destino devolver o valor na própria página (o snapshot é mascarado, mas um texto da página que repete o valor aparece em prints como pixels);
- transformações que a máscara não conhece (o Bash com segredo nega as ferramentas comuns de conversão, mas não todas as combinações possíveis);
- o segredo com "usar com o Mac fechado": com o Mac offline, os bots usam sem Touch ID;
- um bot liberado usar o segredo de um jeito errado dentro do site permitido.

## Verificado 19/11 (instância separada na 2100, dados descartáveis, app simulado no lugar do Mac)

Bot "Teste Cofre" (Sonnet 5.5). O app simulado conectou em `/runner/connect` com `vault`, guardou o valor num Keychain falso e simulou o Touch ID (ok/cancelado).
1. `request_secret` → card → metadados `PUT` → bot: "Pronto: o token ficou salvo no cofre como `segredo:teste-cofre`, liberado só para 127.0.0.1".
2. Página local `http://127.0.0.1:8899/` com campo de texto que ecoa o valor: `browser_fill` com `segredo:teste-cofre`, sem card, Touch ID simulado ok; o snapshot seguinte voltou ao modelo com o campo `••••`; `-webkit-text-security: disc` e `autocomplete=off` aplicados no campo.
3. `http_request` para example.com com o segredo → "O segredo:teste-cofre só pode ser usado em 127.0.0.1, não em example.com." Touch ID cancelado → "A pessoa cancelou o Touch ID."
4. Modo código num repositório descartável: `curl -s -H "Authorization: Bearer $SEGREDO_TESTE_COFRE" http://127.0.0.1:8898/status` contra um servidor que devolve o cabeçalho → o servidor recebeu o token e o bot viu `recebido: Bearer ••••`. O bot se recusou sozinho a rodar `echo $SEGREDO…` e `| base64` (instruções do cofre). Direto no código: `| base64`, `> arquivo`, domínio errado e variável inexistente foram negados; `printenv` sem referência roda sem nenhum segredo no ambiente.
5. Cópia no servidor: `.enc` (AES-256-GCM, 0600) criado; com o app desconectado o `browser_fill` usou a cópia (`source: server`). Sem a cópia e com o app desconectado → "O segredo:teste-cofre fica só no Mac da pessoa, e o Mac está offline…".
6. Histórico: created, used (browser_fill, mac), denied (http_request, example.com, denied_domain), denied (cancelled), used (Bash), server_copy_on, used (server), server_copy_off, denied (mac_offline), deleted.
7. `grep -r` pelo valor e pelo base64 dele: 0 arquivos no `data/` de teste e no de produção, 0 em `~/.claude/projects`, 0 na worktree, 0 em `~/.agent-browser`, `/tmp`, `.cache` e `.config` do container, 0 linhas no log dos dois containers. Segredo apagado com `DELETE` (sumiu do índice e do `.enc`), instância e repositório de teste removidos.

Não testado ao vivo: o Touch ID e o Keychain reais (precisam da pessoa no Mac), `computer_type` com segredo, Codex com segredo, `list_secrets` num turno. Build do Mac + `make-app.sh` assinado "runelay bots Local".

# v25 (19/11): autonomia no código e nos conectores, skills garantidas no prompt, microfone

## Política (invertida em 19/11, pedido da pessoa: "odeio esse bot me pedindo permissão para tudo")
- No modo código e no git o padrão é não pedir nada. Rodam direto, sem card e sem Jev: editar a worktree, Bash, testes, build, dev server, instalar dependência, rede, criar branch, commit (inclusive `--amend`), merge/rebase na branch da tarefa, push da branch da tarefa, `gh pr create/edit/comment`, `workspace_deliver` (commit, push, pr).
- Card só na lista dura (`src/code-policy.ts`): `git push --force`/`-f`/`--force-with-lease`/`--delete`/`+ref`; push para main/master/develop (inclusive `HEAD:main`) ou merge/rebase/pull quando a branch atual é uma delas; `gh pr merge` e merge pela API; `gh release`; deploy (wrangler deploy, vercel, fly, terraform…); migration com prod, `supabase --linked/--remote`, `psql` fora de localhost; `rm`/escrita fora da worktree e de /tmp; `curl -X/-d` para hosts de mensagem ou pagamento (Slack, WhatsApp, Telegram, Twilio, SendGrid, Resend, Mailgun, Postmark, Discord, Asaas, Stripe); sudo, ssh, docker que para ou apaga, systemctl, secret files.
- Negado sem card: `git config` de escrita, commit/PR com `Co-Authored-By`/`Generated with`, `gh pr create --base main` quando a base da tarefa é develop.
- Conectores (`classifyTool` em `src/runelay.ts`): leitura e escrita comum (criar/atualizar issue, documento, label, comentário interno do Linear) rodam direto, sem Jev. Card para o que casa com send, email, mail, message, reply, chat, notify, sms, whatsapp, tweet, dm, invite, slack, refund, charge, payment, payout, pay, transfer, deploy, publish, merge, delete, purge, drop, truncate, migrate, e para ferramentas sql/query com SQL de escrita nos argumentos.
- Uma negação não vale para o próximo pedido. O prompt do bot diz: "Você tem autonomia: não peça permissão para commit, push, PR, testes, build, instalar dependência ou tarefas no Linear… Se a pessoa pedir push, dê push; se já houver PR, o push atualiza o PR. Nunca diga que não pode dar push ou abrir PR."
- `src/delivery-intent.ts` continua só para orientar o prompt: quando a mensagem (ou a skill anexada, ou a cadeia de delegação) pede commit/push/PR, o turno ganha a nota "faça direto" com as regras de commit por módulo.
- Verificado 19/11 (instância 2100, repositório e remoto bare descartáveis): commit por módulo + push + `gh pr create --base develop` sem nenhum card (o `gh` falhou só porque o remoto não é GitHub); `git push --force origin feat/...` → card "Push forçado sempre passa por você."; PR com "Generated with" negado e refeito sem a linha.

## `workspace_deliver {action: "commit"|"push"|"pr", message?}`
- `push`: commit do que estiver pendente (mensagem obrigatória só se houver pendência) + `git push -u origin <branch>`. Se a branch já tem PR aberto (`gh pr view`), o resultado diz que o PR foi atualizado.
- `pr`: igual ao push e abre PR só quando não existe um aberto; senão devolve o existente (`prExisted:true`). "Só push" nunca vira PR novo.
- `POST /bots/:id/code/deliver` aceita `push`.
- Instrução do bot: commits por módulo no Bash (`git add <arquivos>` + `git commit -m`), `workspace_deliver` só para o resto, para o push ou para o PR; "se a pessoa pedir push, dê push; se já houver PR, o push atualiza o PR; nunca diga que não pode dar push".

## Skills anexadas
- O app manda numa mensagem só o texto e todos os chips. O caso de 19/11 ("/Commit" e "/Pr summary" em duas deliveries, sem o texto) veio do Enter do menu "/": ele anexava o chip e o `onSubmit` enviava junto. O composer ignora o submit até 0,6 s depois de escolher no menu.
- O prompt do turno leva a skill inteira ("A pessoa anexou a skill… não é comando de barra… Siga cada uma inteira") e o pedido sem os "/Nome" crus; skill-only vira "Faça o que a skill anexada pede". O bloco saiu do system append, que o Cursor descartava no resume. Vale também para grupo e para delivery que sai da fila.

## Microfone (app)
- `Voice/Microphones.swift`: lista de entrada pelo CoreAudio (sem os `CADefaultDeviceAggregate` do VP), escolha em UserDefaults `voiceInputDeviceUID`/`voiceInputDeviceName`, medidor ao vivo (`MicrophoneMeter`, engine só de entrada) e `MicrophoneCatalog` com listener de dispositivos.
- Seletor "Microfone" na engrenagem da chamada e em Ajustes › Voz ("Padrão do sistema" + dispositivos, barra de nível no escolhido).
- Medido no Mac (19/11): sem VP, a entrada e a saída do AVAudioEngine são o mesmo AUHAL; trocar o dispositivo nele mata a saída (-10875). Com VP, `kAudioOutputUnitProperty_CurrentDevice` no elemento 1 do VPIO aceita e lê de volta, mas o engine entra em loop de `AVAudioEngineConfigurationChange` com 0 buffers; `auAudioUnit.setDeviceID` no VPIO troca a SAÍDA. Por isso: escolhido = padrão do sistema → VP como antes; outro escolhido → engine de captura separado (só entrada, `setDeviceID`) + engine de saída, sem VP (o eco fica com o half-duplex e o descarte de eco do TurnTaker).
- Dispositivo escolhido sumiu → volta ao padrão com "O <nome> não está mais conectado. Voltei para o padrão do sistema." (chamada e ditado).
- Chamada: nos primeiros 3 s ouvindo, pico < 0,002 → "Não estou te ouvindo pelo <nome> · Trocar" na barra e abre o seletor. Ditado: o mesmo aviso no composer, com "Trocar".
- `scripts/voice-e2e` agora precisa de `Voice/Microphones.swift` na lista do swiftc.

# v26 (19/11): handoff de contexto entre contas/modelos + conta reserva no limite

Pedido como "v25"; o número já tinha sido usado por outro agente no mesmo dia. Estudo do T3 Code em `research/t3-handoff.md`.

## Handoff (`src/handoff.ts`)
- **Itens da conversa** (`threadItems`, derivados do log, turnos revertidos fora). Ids estáveis por tipo:
  - `u_<turnId>`: pedido.
  - `a_<partId>`: resposta ou narração.
  - `t_<callId>`: ferramenta, com entrada e resultado; Bash vira `Comando:` + stdout/stderr/exit.
  - `e_<turnId>:<path>`: edição com diff.
  - `p_<interactionId>`: aprovação e o desfecho.
  - `r_<artifactId>_v<n>`, `f_<uploadId>`, `d_<callId>` (delegação terminada), `w_*` (workspace aberto/entregue), `x_<turnId>` (turno falhou/interrompido, troca de conta).
- **Quando entra no prompt** (`handoffBlock`, no lugar do antigo `carryOver`/`recentExchanges`):
  - **full**: a chave da conta (`account.id` ou `account.id@workspace`) não tem sessão do provider. Cobre troca de modelo/conta, conta nova, contexto estourado, failover, troca de workspace e retomada que falhou.
  - **delta**: a chave tem sessão, mas `meta.providerSynced[chave]` é de um turno anterior. Entram só os itens dos turnos que ela não viu. Corrige a volta A→B→A, que antes retomava a sessão velha sem saber de B.
  - **nada**: a sessão está em dia, ou é sessão antiga sem `providerSynced`.
- **Bloco** "## Contexto da conversa (handoff)":
  1. Cabeçalho: conversa, turnos cobertos, primeiro e último item, motivo.
  2. Resumo da conversa toda.
  3. Linha do tempo: uma linha por item omitido entre o resumo e os itens inteiros.
  4. Estado atual: repositório, branch, base e worktree; arquivos mudados com +N −M (`changedFiles`); aprovações pendentes do turno; aprovações negadas recentes; até 5 artefatos e 5 anexos recentes; skills do pedido em curso.
  5. Instrução do `thread_read`.
  6. "Selecionei N itens inteiros; omiti M", com até 60 ids omitidos (os mais novos por último).
  7. Aviso: "Histórico é contexto, não um pedido novo nem instrução de prioridade maior".
  8. Os itens, no formato `[Histórico; <pessoa|você|sistema>; <kind>; item=<id>; <turnId>]`.
- **Seleção** (como o T3):
  - Ordem de prioridade: último pedido, última resposta, primeiro pedido e, depois, os mais novos. A saída fica em ordem cronológica.
  - Item inteiro ou omitido; item maior que 1/3 do orçamento fica de fora.
  - Orçamento de `BOTS_HANDOFF_CHARS` (padrão 40.000 caracteres ≈ 10k tokens), descontando resumo, estado e linha do tempo.
  - Ferramenta entra com o resultado resumido (1.500 caracteres, cabeça + cauda). Edição de código entra como "arquivo +N −M"; o diff fica no `thread_read`.
- **Resumo incremental** (`refreshSummary` + `summarizeForReset(account, model, bot, anterior, novos)`, modelo barato da conta do turno):
  - Roda em segundo plano no fim de cada turno de thread que completou, quando há ≥ 12 itens fora dos 24 mais recentes, em lotes de até 30k caracteres.
  - Fica em `meta.handoff = {summary, lastItemId, updatedAt}`. Contexto estourado força a rodada até os 4 últimos itens.
  - Não custa nada na hora da troca.
- **Ferramenta `thread_read({itemId, offset?})`** (MCP `bots`, para todos os bots e providers, `src/handoff-tools.ts`):
  - Devolve `{itemId, kind, role, turnId, at, totalChars, offset, text, nextOffset}` em pedaços de 4.000 caracteres, sem cortar par surrogate.
  - Id desconhecido devolve erro com os 20 ids mais recentes.
  - No transcript aparece como "Relendo a conversa", e o log guarda só tamanhos (sem duplicar o texto).

## Conta reserva (`engine.fallback`)
- **Configuração:** `engine.fallback: {account, model} | null`.
  - Sem o campo vale a sugestão: `vps:codex` (ou `vps:claude` se a principal já é Codex).
  - `null` desliga.
  - `PATCH /bots/:id {engine:{fallback:{account:"vps:codex"}}}`; o modelo padrão do provider entra se faltar.
  - `GET /bots` devolve o fallback resolvido.
- **Detecção** (`src/limits.ts`):
  - Mensagem de `done` com spend/usage/rate limit, quota, 429, "resets …" e afins.
  - Ou turno sem resposta nem ferramenta cujo único texto é curto e tem cara de aviso de limite ("You've hit your…", "usage limit reached|<epoch>").
  - O horário de volta é lido de `|epoch`, ISO, "try again in 2 hours 5 minutes" e "resets 4:10pm (Zona)". Sem zona, usa a do runner: UTC no container, America/Sao_Paulo no Mac.
  - Sem horário, a conta fica marcada por 15 min. As marcas ficam em memória.
- **Failover no mesmo turno:**
  1. Marca a conta, descarta o texto de limite e emite `account.failover {from, to, until, line}`, com a linha "Limite do Claude acabou · continuei com Codex". Ela só é emitida quando o par muda.
  2. Refaz o pedido na reserva com handoff full ou delta. O motivo diz "refaça o pedido em curso sem repetir o que já foi feito", e os itens do turno que falhou entram no histórico.
  3. Imagens só vão se a reserva for Claude na VPS.
- **Turnos seguintes:** enquanto a principal está marcada, a reserva já começa o turno (sem nova linha). `meta.failover = {from, to, since, until}`.
- **Volta:** passado o reset, a principal tenta de novo. Se completar, emite `account.restored {account, line:"Voltei para o Claude"}` e recebe o delta do que a reserva fez.
- **Sem reserva** (ou reserva fora do ar ou também no limite):
  - O turno termina com `turn.settled failed`, assim: `error {code:"ACCOUNT_LIMIT", message:"O limite do Claude acabou, volta amanhã às 13:10. Quer que eu continue com o Codex?", detail, until, suggest:{account, model, label}}`.
  - `suggest` é a reserva configurada ou a sugestão, só se estiver pronta.
- Grupos não fazem failover.
- **Teste:** `BOTS_FAULTS_FILE=<json {"vps:claude":"mensagem"}>` faz o `runOnRunner` responder com o texto e a falha, sem chamar o provider. Só é lido se a variável existir.

## App
- **Seletor de modelo:** linha nova "Se acabar o limite, usar" com menu das contas prontas e "Não trocar, só avisar". A explicação fica no tooltip. Trocar modelo ou esforço preserva a reserva.
- **Conversa:**
  - Divisor fino no estilo do T3 (`ContextHandoffDivider`): "⇄ <motivo> · logo modelo → logo modelo", centralizado entre linhas finas. A frase inteira fica no tooltip.
    - `context.handoff {from, fromModel, to, toModel}`: o servidor emite quando o turno entra com handoff numa conta ou modelo diferente do último (`meta.lastEngine`). Motivo: "Contexto passado".
    - `account.failover` acrescenta `fromModel`, `toModel` e o motivo "Limite do Claude".
    - `account.restored` acrescenta `from`, `fromModel`, `toModel` e o motivo "Limite liberado".
  - `ACCOUNT_LIMIT` vira aviso com o texto do servidor e o link "Continuar com Codex". O link grava a sugestão como reserva (`PATCH engine.fallback`) e reenvia o último pedido. Como o limite continua marcado, o reenvio já vai para a reserva.

## Verificado 19/11
Instância separada na :2200, imagem própria, sem rotinas, bot e repo descartáveis, tudo apagado no fim.
- **Troca no meio:** Claude Haiku abriu o repo, criou `notas.md` e rodou `echo $((17*23))` + `seq 1 600 … ; echo PALAVRA-FINAL-ZEBRA`. Trocado para Codex, respondeu sem rodar nada: 391, `notas.md` e ZEBRA. Depois leu um item omitido com `thread_read` (`offset 0 → nextOffset 4000`) e acertou "linha 541".
- **Failover:** a falha injetada no Claude ("resets in 1 minute") gerou "Limite do Claude acabou · continuei com Codex" e o Codex seguiu o mesmo turno. Passado 1 min, o Claude voltou com "Voltei para o Claude" e recebeu o delta dos turnos 2–4.
- **Sem reserva:** saiu `ACCOUNT_LIMIT` "O limite do Claude acabou, volta amanhã às 13:10. Quer que eu continue com o Codex?" com `suggest vps:codex`.
- **Resumo incremental:** na conversa real de 148 itens, 2 rodadas de ~7 s.
- **Armadilha que já existia:** no container, o Codex em modo código usa `-s workspace-write`, e o bwrap falha ("No permissions to create a new namespace"). Shell e patch do Codex não rodam na worktree. Como reserva em modo código, o Codex lê e conversa mas não edita até o container liberar userns (ou o modo código do Codex mudar de sandbox).

# v27 (19/11): PR e CI do modo código + mensagem com card aberto

Pedido como "v26"; o número já estava em uso (handoff de contas), então ficou v27.

## Associação e polling (`src/code-pr.ts`)

- O PR fica em `session.meta.workspace.pr` (também sai em `publicWorkspace`, `GET /bots/:id/code` → `workspace.pr` e em `GET /bots` → `code.pr {number, status, ci}`).
- Descoberta: depois de `workspace_deliver` (rota ou ferramenta) o `prUrl` vai direto para `kickPr`; PR aberto pelo bot com `gh pr create` no Bash é achado no polling por `gh pr list --head <branch> --state all` assim que a branch tem upstream ou `refs/remotes/origin/<branch>`.
- Polling: um laço a cada 10 s olha as worktrees ativas; leitura com `gh pr view <n> --json number,title,state,isDraft,mergedAt,closedAt,baseRefName,headRefName,additions,deletions,files,statusCheckRollup,reviewDecision,url,updatedAt`. Intervalo: 20 s com CI rodando, 60 s aberto ou sem PR, 10 min fechado/mergeado (mergeado não relê, só confere o fechamento automático). `CODE_GH_BIN` troca o binário (teste com `gh` falso; o `childEnv` põe `/usr/bin` antes do PATH).
- Checks: `CheckRun` e `StatusContext`; vale o mais recente por `workflow/nome`. `status` = `pending|success|failure|skipped|neutral`, `durationMs` de `startedAt`/`completedAt` (o `0001-01-01` do GitHub vira `null`). `ci` = `failure` se algum falhou, `pending` se algum roda, `success`, ou `none`.
- Arquivos em categorias: **generated** (lockfiles, `dist/ build/ out/ .next/ generated/`, `*.gen.*`, `*.generated.*`, `*.min.js`, `*.snap`, `migrations/meta/`, `*_snapshot.json`, `_journal.json`), **tests** (`*.test.*`, `*.spec.*`, `__tests__/ _tests_/ test(s)/ e2e/ __mocks__/ fixtures/`), **docs** (`*.md`, `*.mdx`, `docs/`, README/CHANGELOG/LICENSE), **code** o resto.

## Eventos (sem escopo de turno)

```json
{"type":"code.pr","data":{"workspaceId","repoName","number":1207,"title","url","status":"open|draft|merged|closed","base":"develop","head":"feat/x","additions","deletions","files":17,
 "categories":{"code":{"files","added","removed"},"tests":{…},"generated":{…},"docs":{…}},"checks":[{"name","workflow","status","startedAt","completedAt","durationMs","url"}],
 "ci":"none|pending|success|failure","review":"approved|changes_requested|review_required|null","mergedAt","closedAt","updatedAt","fetchedAt"}}
{"type":"code.ci","data":{"workspaceId","number","prUrl","outcome":"failure","check":{…},"failed":[{"name","url"}],"log":"…até 4 kB…"}}
{"type":"code.ci","data":{"workspaceId","number","prUrl","outcome":"success","checks":6}}
{"type":"code.review","data":{"workspaceId","number","prUrl","state":"changes_requested","author","body","comments":[{"path","line","body"}]}}
{"type":"code.review","data":{"workspaceId","number","prUrl","state":"approved"}}
{"type":"code.workspace","data":{"action":"removed","by":"user|auto",…workspace,"pr":{"number","status","url"}|null}}
```
- `code.pr` só quando algo muda (ignora `fetchedAt`). `code.ci failure` quando aparece check falho novo (nome + URL do job; re-run tem URL nova); `success` quando vem de `pending` ou `failure`. Reinício do servidor não repete: o estado anterior fica salvo.
- Log resumido: `gh run view --job <id> --log-failed`, sem ANSI/timestamp, sem `✓`, corta no "Post job cleanup", começa no bloco "Failed Tests"/`FAIL`/`error` (senão as últimas 45 linhas), `##[error]` vira "Erro: ".
- Review com mudanças: `gh pr view --json reviews` (o último CHANGES_REQUESTED) + `gh api repos/{owner}/{repo}/pulls/<n>/comments` (até 8 comentários de linha, sem respostas).

## Rotas (`?sessionId=` opcional)

- `GET /bots/:id/code/pr` (`?refresh=1` relê no GitHub) → `{pr}`.
- `POST /bots/:id/code/finish` → fecha o repositório e roda `git worktree remove` (nunca `--force`). `409` com mudança não commitada ("Tem mudança não commitada na worktree…"), commit que não foi para o GitHub ("Tem 1 commit que não foi para o GitHub.") ou bot trabalhando. A branch fica. Registro `status: removed`.
- `POST /bots/:id/code/pr/reopen` → `gh pr reopen` (só PR fechado; o clique da pessoa é o pedido, o app confirma).
- Fechamento automático: PR mergeado há `CODE_PR_AUTOCLOSE_HOURS` (24) sem mudança pendente e sem commit fora do GitHub → `finish` com `by:"auto"`.

## App

- Pílula: depois de "16 · +128 −37" vem `#1207` com ponto de CI (verde passou, amarelo rodando, vermelho falhou). Mergeado: cápsula roxa "Mergeado ✓ #1207" (`Theme.merged`). Fechado: "Fechado #1207" em vermelho.
- Popover: linha do PR (ícone por status, título curto, ponto de CI, `#n`) logo abaixo da branch. Hover (450 ms) ou clique abre o cartão: status com cor e ícone, título, `base ← head`, "N arquivos +a −r" e Código/Testes/Gerado/Docs com ±, lista de checks (ícone, nome, duração, clique abre o log), review (Aprovado / Mudanças pedidas / Aguardando review), "Abrir no GitHub ↗". Mergeado: "Fechar o repositório" em roxo. Fechado: "Reabrir" e "Fechar o repositório". O "Fechar o repositório" do fim do popover vira `finish` (com confirmação) quando o PR está mergeado ou fechado; erro do servidor aparece em vermelho no popover. Abrir o popover relê o PR.
- Conversa: "CI falhou · Tests (1/3) · Ver log ↗ · Pedir para corrigir" (o botão manda "O CI do PR #n falhou em X. Corrige." + log resumido em bloco de código; vira "Pedido enviado"); "CI passou ✓"; "Review pediu mudanças · autor" com até 4 linhas do resumo e "Pedir para corrigir"; "Review aprovado ✓"; "PR #1207 mergeado · repositório fechado".
- Notificação do macOS em `code.ci failure` ao vivo ("CI falhou · PR #n", corpo "bot · check"), na preferência "Turnos com erro", só quando a conversa não está na tela.

## Mensagem com card de aprovação aberto (bug da resposta duplicada)

Causa: na conversa do Engenheiro de Software a pessoa escreveu "não precisa, eu já alterei, só guarde na memória" enquanto o card do `save_issue` estava aberto. O app manda isso como mensagem nova (fica "na fila"); a pessoa depois clicou Negar; o turno pausado seguiu, salvou a memória e respondeu ("Você tem razão… Guardei a regra…"), e só então a fila rodou a mensagem como turno novo, que respondeu de novo ("Já está guardado…"). Não era voz nem handoff.

Agora (`engine.ts`): mensagem de chat só com texto que chega com o turno pausado em aprovação entra **no mesmo turno**: `delivery.consumed` com o escopo do turno e `steer:true`, cada card aberto fecha com `interaction.settled {outcome:"withdrawn", reason:"message"}` (a ferramenta volta negada), a rodada do provedor é encerrada (o mesmo `onEndRun` da troca de worktree) e o texto que ela ainda soltar é descartado. O turno continua com `resume` da sessão do provedor e o prompt "A pessoa respondeu por mensagem enquanto seu pedido de aprovação estava aberto… numa resposta só"; se o `resume` falhar, roda de novo com o resumo da conversa. Mensagem com anexo, skill, voz, grupo ou rodada de delegado continua indo para a fila. App: card mostra "Respondido por mensagem" e a fase volta para trabalhando.

## Verificado 19/11

- Parser contra o PR real #1207 (só leitura: `gh pr view`, `gh run view --log-failed`): 16 arquivos = Código 8 (+100 −32), Testes 7 (+25 −4), Docs 1 (+3 −1); checks Lint 33 s, Typecheck 2 min 15 s, Tests (1/3) falhou em 10 min 6 s; log resumido começa em "Failed Tests 1" com o `AssertionError` de `settle-delivery-without-review.test.ts:399`. Em produção o PR foi achado sozinho pela branch da worktree.
- Instância separada (:2130, dados descartáveis, `gh` falso, repo descartável com remoto bare local): aberto+CI rodando → falhou (`code.ci` com log) → passou (`CI passou`) → mudanças pedidas (resumo + comentário de linha) → fechado → reabrir → mergeado → `finish` recusou arquivo sujo e commit não enviado, removeu a worktree limpa (branch ficou) → fechamento automático com o prazo encurtado: worktree suja ficou, limpa saiu (`by:"auto"`).
- Turno real (Sonnet): `git push` pediu card, mensagem enviada com o card aberto → card "withdrawn", uma resposta só, no `turn_0`, sem turno novo.

# v28 (19/11): uso e limites do Claude e do Codex (VPS + Mac)

Tela "Uso" no app (anéis no trilho, acima da engrenagem) e duas rotas de leitura. Só fontes locais ou do próprio login, nenhuma chave nova. Nada é escrito em `~/.claude` ou `~/.codex`.

## `GET /usage/limits[?refresh=1]`

`{ checkedAt, accounts: [{ id, environment: "vps"|"mac", provider: "claude"|"codex", label, plan, ok, error, windows: [...], failover: [...] }] }`

- `windows[]`: `{ kind: "session"|"weekly"|"monthly"|"weekly_model", label: "Sessão"|"Semanal"|"Mensal"|"Semanal · <modelo>", usedPercent, remainingPercent, resetsAt (ISO), windowMinutes, pacePercent }`.
- `pacePercent` = % da janela que ainda falta no relógio (`(1 - decorrido/duração) * 100`). Na barra, que mostra o restante, é o marcador do ritmo: restante abaixo do marcador = gastando mais rápido que a janela.
- `failover[]`: `{ botId, botName, to, toLabel }`, os bots com `engine.account` igual à conta e a reserva deles (`engineOf`, v26). O app usa isso para dizer "X vai trocar para Codex (VPS)".
- Cache de 90 s; `refresh=1` força.

Fontes:
- **Claude VPS:** `GET https://api.anthropic.com/api/oauth/usage` com `Authorization: Bearer <claudeAiOauth.accessToken>` de `~/.claude/.credentials.json`, `anthropic-beta: oauth-2025-04-20` e `User-Agent: claude-code/<versão>` (sem ele pode dar 429). É a mesma fonte do `/usage` do Claude Code. A sessão e o semanal vêm de `limits[]` (`session`, `weekly_all`), com `five_hour`/`seven_day` como reserva. Limite por modelo = `limits[].kind == "weekly_scoped"` com `scope.model.display_name` (ex.: Fable). Não renova o token: se expirou, devolve erro e o próximo turno do Claude renova.
- **Codex VPS:** `codex app-server` por JSON-RPC (stdio): `initialize` → `initialized` → `account/rateLimits/read`, lendo `rateLimitsByLimitId.codex ?? rateLimits` (`primary`/`secondary`: `usedPercent`, `windowDurationMins`, `resetsAt` em segundos). É ao vivo; o `rate_limits` dos rollouts só é tão novo quanto o último turno.
- **Mac:** pelo WebSocket do runner (capability `usage`), `op: usage.limits`. O app lê o token do Claude do Keychain (`security find-generic-password -s "Claude Code-credentials" -w`, sem diálogo porque o item já confia no `security`), chama a mesma rota OAuth e roda o `codex app-server` local. O servidor interpreta os dados crus com o mesmo código da VPS. App sem a capability = "Atualize o app no Mac".
- Nome da conta: `oauthAccount.displayName` do `~/.claude.json` de cada máquina.

## `GET /usage/summary?range=24h|7d|30d|90d&provider=claude|codex&environment=vps|mac`

Devolve:
- `totals`: `processed`, `input` (fora do cache), `cacheRead`, `cacheWrite`, `output`, `reasoning`, `requests`, `sessions`, `costUsd`, `savingsUsd` e `unpricedTokens`;
- `costByType` e `speeds[]` (`standard`/`fast`);
- `series[]` (`{ bucket, provider, tokens, costUsd }`, por hora em `24h` e por dia nos outros, no fuso America/Sao_Paulo);
- `detail[]` (`{ day, provider, model, environment, ... , costUsd|null }`);
- `environments` (`vps`/`mac`: `ok`, `error`, `scannedAt`, `pending`);
- `pricing`.

O filtro é feito no servidor.

- **Claude:** `~/.claude/projects/**/*.jsonl`, linhas `type: "assistant"` com `message.usage`, sem o `<synthetic>`. A deduplicação usa `message.id:requestId`, porque o Claude Code repete o registro por bloco de conteúdo e entre arquivos de resume/fork; as cópias são idênticas, então vale a primeira. Os campos: `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` (separando `ephemeral_1h`), `output_tokens` e `usage.speed == "fast"`.
- **Codex:** `~/.codex/sessions/**/*.jsonl`. O modelo vem de `turn_context.payload.model`, a velocidade do `service_tier` (`priority`/`fast` = rápido) e a sessão de `session_meta.payload.id`. Os tokens são o delta de `token_count.info.total_token_usage`; se o total cair (resume), usa `last_token_usage`. Eventos com horário anterior ao `session_meta` são histórico copiado de fork e ficam de fora. Input fora do cache = `input − cached − cache_write`.
- **Custo:** preço de API do LiteLLM (`model_prices_and_context_window.json`, baixado 1×/dia para `data/usage/prices.json`). O preço é buscado pelo nome exato, sem `[1m]`/data, e depois com os prefixos `openai/` e `azure/`. O rápido usa o multiplicador `provider_specific_entry.fast`. A economia do cache é `cacheRead × (input − cacheRead)`. Modelo sem preço entra em `unpricedTokens` e aparece como "sem preço".
- **Sessões:** contam pela primeira hora vista de cada sessão.

## Cache incremental

- **VPS:** `data/usage/vps-index.json` guarda o offset em bytes por arquivo (só lê o que cresceu; arquivo menor que o offset é relido do zero), o estado do Codex por arquivo, buckets `hora|provedor|modelo|velocidade → [input, cacheRead, cacheWrite5m, cacheWrite1h, output, reasoning, requests]`, as sessões e os hashes de deduplicação. Tudo com mais de 100 dias é descartado. Leitura no máximo 1×/min; o aquecimento roda 15 s depois de subir. A 2ª passada leva ~80 ms.
- **Mac:** o mesmo esquema em Swift (`Runner/LocalUsage.swift`, actor `LocalUsageScanner`), com índice em `~/Library/Application Support/runelay bots/usage-index.json`. O servidor pede `op: usage.buckets { since }` (timeout 10 min) e guarda a resposta por 2 min. A primeira leitura (~9,6 GB) levou ~1 min. Enquanto ela roda, o resumo volta em até 8 s com `environments.mac.pending = true` e o app tenta de novo a cada 15 s.

## App

- **Anéis no trilho:** `UsageRailIndicator`, um por provedor, 35 pt, com toque de 40 pt. O anel de fora é a sessão de 5 h, o de dentro é o semanal/mensal, e o preenchimento é o % restante: âmbar abaixo de 25%, vermelho abaixo de 10%. Com várias contas, mostra a de menor restante. Tooltip "Claude · sessão 93% restante, volta em 1h 18m · semanal 8% restante, volta em 21h 8m". Atualiza a cada 2 min e quando o app volta ao primeiro plano.
- **Tela Uso:** `AppSection.usage`, fora de `railCases`. Tem as abas Limites/Tokens/Custo e filtros de período, provedor e ambiente.
- **Aviso:** abaixo de 10%, notificação do macOS uma vez por conta+janela+reset (`usage.notified` no UserDefaults), com a linha da reserva quando houver. O clique abre a tela Uso.

## Verificado 19/11

- **Claude VPS:** `/usage` = 7% / 92% / Fable 29%, volta 21:10 UTC e 20/11 17:00 UTC; a rota deu os mesmos valores e horários.
- **Claude Mac** (mesma conta da sessão Claude Code da VPS em `~/.claude-2`, mesmo `accountUuid`): `/usage` = 25% / 16% / Fable 0%, volta 23:10 e 25/11 18:00; a rota deu igual.
- **Codex:** o `rate_limits` do último rollout da VPS (5% / 2%, resets 1795123124 e 1795691872) é igual ao do `app-server`. Mac e VPS usam a mesma conta ChatGPT. O rollout mais novo do Mac era antigo (13:24, janela vencida), por isso a rota usa o `app-server`.
- **Tokens** (Claude VPS) contra o `/usage`: 24 h = 5.126 contra 5.127 requests e 162 contra 163 sessões; 7 d = 24.018 contra 23.654 (+1,5%), porque o início da janela é arredondado para a hora cheia.

# v29 (19/11): várias conversas por bot + modo de permissão por conversa

Pedido como "v28"; o número já tinha sido usado (uso e limites). Código: `server-sdk/src/conversations.ts`, `src/permissions.ts`, ajustes em `engine.ts`, `threads.ts`, `main.ts`, `code-hooks.ts`, `code-policy.ts`, `mcp.ts`, `bots.ts`, `shared/providers/codex.ts`; app em `Models/Conversation.swift`, `Views/Conversation/PermissionPill.swift`, `Views/Sidebar/SidebarView.swift` (árvore) e `Stores/AppModel.swift`.

## Conversas
- Uma conversa é uma sessão com `kind: "conversation"` (as novas) ou a thread principal (`kind: "thread"`), que vira a primeira conversa do bot. Cada uma tem histórico, sessão de provider (`providerSessions`), workspace/worktree e fila próprios: o runtime já era por sessão, então duas conversas do mesmo bot rodam em paralelo. Nada foi migrado; a principal continua no `threads/<bot>.json`.
- `SessionMeta.conversation = {titleSource: auto|user|pending, lastMessage, unread, readAt, archivedAt, updatedAt, delegatedBy?}` e `SessionMeta.permission?`.
- Título automático por heurística (sem modelo): na 1ª mensagem da pessoa, tira saudação e "você pode/por favor…", tira URL e bloco de código, corta em ~44 caracteres na palavra e põe maiúscula ("Oi! Você pode criar o arquivo hello.ts…" → "Criar o arquivo hello.ts com export const…"). Renomear marca `titleSource: "user"` e o automático não mexe mais.
- Rotas (`/bots/:id/conversations`):
  - `GET [?archived=1]` → lista; ordem estável: principal primeiro, depois as outras da mais nova para a mais velha pela criação (atividade não reordena).
  - `POST {title?, permission?, message?, skills?, attachments?}` → 201 com a conversa (+ `sessionBasePath`, `deliveryId` se veio mensagem).
  - `GET|PATCH /:sessionId {title?, permission? (null volta ao padrão do bot)}`.
  - `POST /:sessionId/archive|unarchive` (principal → 400 `main_conversation`; trabalhando → 409 `turn_running`), `read|unread`, `move {botId}` (troca o dono, limpa as sessões de provider para o novo bot entrar pelo resumo do handoff; a worktree continua com a conversa; principal não move; trabalhando → 409).
  - Mensagens continuam pela API de sessão (`/bots/:id/eve/v1/session/:sessionId`).
- `GET /bots` e `GET /bots/:id` ganham `permission` (padrão do bot) e `conversations` (as não arquivadas, mesmo formato): `{sessionId, botId, title, titleSource, main, createdAt, updatedAt, lastMessage, unread, status: working|awaiting|queued|idle, archivedAt, permission, effectivePermission, delegatedBy?, code: {repoName, branch}|null}`.
- `/status/stream`: o snapshot ganha `sessions: {sessionId: {botId, status}}`; novas linhas `{"type":"session","botId","sessionId","status"}` (status por conversa) e `{"type":"conversation","botId","sessionId","conversation":{…}|null}` a cada mudança de título, última mensagem, não lidas, arquivo, permissão ou movimento (`null` = saiu da lista desse bot). As linhas `status` por bot continuam.
- Delegação: `delegate` cria uma conversa nova no bot delegado, título "Boss pediu: …", `delegatedBy` preenchido e a permissão efetiva da conversa de quem delegou. Duas tarefas para o mesmo bot não entram mais em fila. `delegation.updated.sessionId` aponta para essa conversa.
- `hasBrowser`/modo código valem se qualquer conversa do bot tem repositório aberto. Rotinas, voz e canvas continuam na principal.

## Modo de permissão (`readonly | edit | default | full`)
- Padrão do bot: campo `permission` (`PATCH /bots/:id`, default `default`). Por conversa: `PATCH …/conversations/:sid {permission}`. Efetiva = conversa ?? bot ?? default.
- Prompt: seção "## Permissão desta conversa" com o modo, valendo acima das regras de autonomia.
- Gate do código (`beginCall`): a ação é classificada (leitura: Read/Glob/Grep, Bash só de leitura por `commandIsReadOnly` com o parser de shell; edição: Edit/Write; comando: o resto do Bash e `dev_server_start`; entrega: `workspace_deliver`).
  - **Somente leitura**: leitura segue o gate normal; edição, comando e entrega são negados sem card (`TOOL_POLICY`). Codex roda com `-s read-only`.
  - **Editar**: leitura e edição seguem o gate normal; todo comando e entrega viram card (soft), inclusive commit e push da branch da tarefa.
  - **Padrão**: igual à v25.
  - **Acesso total**: nenhum card (`clearedBy: {permission: "full"}`), também nas ferramentas de navegador/computador, de autoconfiguração e nos conectores. Continua negado sem card: assinatura de IA em commit/PR, PR para main quando a base é develop e `push --force` em main/master/develop (`fixedRuleViolation`, inclusive `HEAD:develop` e `+ref`). As outras negações técnicas (caminho protegido, `git config`, `&`) continuam.
- Conectores (`runRemote`): leitura passa em todos; escrita comum e mensagem para fora → negadas no Somente leitura, card no Editar, só mensagem para fora pede card no Padrão, nada pede no Acesso total.
- Limite conhecido: Codex não tem gate por chamada, então no Editar ele roda comandos como no Padrão.

## App
- Barra lateral: bot com 2+ conversas vira grupo: a linha do bot é só cabeçalho (avatar 24 pt, nome; hover: "+" e "⌄" para recolher, guardado em `sidebar.collapsedBots`; clique abre a conversa mais recente), sem prévia nem horário. Conversas abaixo, 30 pt, sem fundo de cartão (só a selecionada tem `Theme.selection`, hover `Theme.hover`), título em 1 linha alinhado ao nome do bot, tempo ou contador à direita; à esquerda, bolinha que pulsa (só enquanto trabalha), ponto de atenção, `</>` com repositório aberto ou nada; hover: Renomear e Arquivar. Linha-guia sai do centro do avatar e para na última conversa. Bot com 1 conversa = linha normal.
- "+"/⌘N abre um rascunho local (área vazia, caixa focada, "Nova conversa" no topo): nada vai ao servidor nem à barra lateral até o 1º envio, que faz `POST …/conversations {message}` e a conversa já nasce com título automático; sair do rascunho sem enviar descarta. Modo de permissão escolhido no rascunho vai no POST.
- Título automático vale também para a principal (1ª mensagem da pessoa; antiga sem título é preenchida pelo 1º `delivery.consumed` de chat do log). A principal agora pode ser renomeada. Recolhido, o bot soma as não lidas. Clique direito na conversa: Renomear (no lugar), Marcar como não lida, Mover para… (outro bot), Arquivar (com Desfazer). Ordem vem do servidor, nada reordena por atividade.
- `threads[botID]` continua sendo a conversa aberta do bot; as outras com store vivo ficam estacionadas (aprovação de conversa delegada notifica). Status do bot = maior entre a conversa aberta e o stream.
- ⌘N cria conversa no bot selecionado (antes focava o campo). ⇧⌘P alterna o modo da conversa. Pílula ao lado do seletor de modelo: ícone + nome; popover "Permissões" com os 4 ícones em segmentado, nome e descrição em pt-BR e "Usar como padrão de <bot>".

## Verificado 19/11 (instância 2110, dados descartáveis, repo + remoto bare locais, tudo apagado no fim)
- Duas conversas do mesmo bot, cada uma com a sua worktree: começaram juntas (20:02:29.34 e .36) e terminaram em ~5 s; `hello.ts` "um" e "dois" em worktrees diferentes; stream de status com `session` working/idle de cada uma.
- Delegação: Chefe Teste → duas conversas novas "Chefe Teste pediu: …" no delegado, com `delegatedBy`.
- Mesmo pedido (editar b.ts + commit + `push --force` da branch) nos 4 modos: Somente leitura não fez nada (e, forçado, `git status` rodou e `echo x > c.ts` foi negado pelo hook); Editar pediu card no `git add`, no `git commit` e no push; Padrão rodou direto e pediu card só no push forçado; Acesso total rodou tudo sem card. `git push --force origin HEAD:develop` no Acesso total → negado sem card (conferido também direto no gate, junto com Co-Authored-By e `--base main`).
- Renomear, ler, arquivar (principal recusada), listar arquivadas, mover para outro bot (a conversa movida continuou respondendo na worktree dela), padrão do bot refletindo em `effectivePermission`.
- `swift build -c release` no Mac e `make-app.sh`, assinatura "runelay bots Local". Sem print.

# v30 (19/11): fila de turnos, processos controlados e resumo de mudanças em lote

## Fila global de turnos
- No máximo `BOTS_MAX_TURNS` (padrão 3) turnos pesados rodando ao mesmo tempo na VPS. Voz passa na frente e não espera; delegado tem prioridade sobre chat, chat sobre rotina. Turno parado num card de aprovação ou esperando um delegado libera a vaga e volta a ocupar quando continua.
- Quem excede recebe, no stream da conversa: `{"type":"turn.queued","data":{"turnId":"turn_3","position":2,"limit":3},"scope":{"turnId":"turn_3"}}` (reemitido quando a posição muda) e, ao começar, `{"type":"turn.dequeued","data":{"turnId":"turn_3"}}`. O app mostra "na fila · 2º" no lugar de "pensando…".
- `GET /status` passou a trazer também `turns {running, queued, max}`, `warmVoice` e `appWatching`.

## Processos
- Todo `claude` de turno e da camada rápida da voz sobe com `RUNELAY_TURN=rb<porta>:<id>` no ambiente, `nice 5` (voz 0), `ulimit -c 0` e `oom_score_adj 300`. Ao terminar ou cancelar, o servidor mata todos os processos com aquele marcador (filhos e netos). Uma varredura a cada 60 s mata marcados órfãos; na subida, também os `claude --input-format stream-json` com pai 1 (só dentro do container).
- Camada rápida da voz: no máximo `VOICE_MAX_WARM` (3) processos quentes, LRU; fecha sozinha após 5 min sem uso e reabre na próxima fala.
- Bash do modo código: testes (vitest, jest, `npm test`…) rodam um por vez na VPS inteira (`flock` em /tmp/runelay-bots-tests.lock, espera até 100 s e avisa), com `nice 10`, `timeout 20m`, `NODE_OPTIONS=--max-old-space-size=2048` e 2 workers; build/tsc/lint ganham o mesmo, sem a trava.
- Chrome do agent-browser fecha após 10 min sem uso (`BROWSER_IDLE_MS`); o print ao vivo durante o turno só roda se alguém olhou o navegador nos últimos 20 s.
- Polling de PR/CI: 30 s com CI rodando, 2 min aberto; sem o app conectado ao `/status/stream`, 4× mais lento.

## Mudanças em lote
- Quando uma varredura acha mais de `CODE_LIVE_BULK_LIMIT` (25) arquivos mudados, sai um só `code.bulk` no lugar dos `code.edit`: `{"callId":"…","workspaceId":"…","files":616,"added":14109,"removed":31960,"paths":["…12 primeiros"],"source":"tool","key":"turn_4:bulk:toolu_…"}`. O app mostra uma linha "616 arquivos mudaram de uma vez" com atalho para o visualizador.

## Container
- `docker-compose.yml`: `mem_limit`/`memswap_limit` 6g (`BOTS_MEM_LIMIT`), `cpus` 3 (`BOTS_CPUS`), `pids_limit` 4096, `ulimits core 0`.
