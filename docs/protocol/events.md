# Stream de eventos

## runelay bots: verified protocol

### eve session API (under `sessionBasePath`, e.g. `/bots/lia/eve/v1`)

#### Stream

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
{"data":{"callId":"call_probe_1","outcome":"completed","output":{"url":"https://example.com/","title":"Example Domain","updatedAt":"2026-11-19T12:18:22.831Z","screenshot":"/data/bots/lia/browser/shots/2026-11-19T12-18-22-323Z.png"}},"type":"call.settled","scope":{"turnId":"turn_0","runId":"run_0"}}
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

#### Rendering rules

- Bubble: `content.completed` with `kind:"text"`, `phase:"reply"`. Muted line: same with `phase:"narration"`. Live typing: accumulate `progress` `content.delta` by `partId` and replace with `content.completed.value`.
- Tool row: open on `call.requested` (`capability.name`, `capability.label`, `input`), close on `call.settled` (`outcome`: `completed`, `failed`, `rejected`; `output` or `error`). Match by `callId`. Hide rows with `capability.hidden:true` or `capability.kind:"control"`.
- Approval card: `interaction.opened` with `request.kind:"approval"`, title `request.prompt`, buttons from `request.options`. Close on `interaction.settled` with the same `interactionId` (`outcome` `accepted` or `declined`, or another outcome when withdrawn).
- Status: working from `turn.started` until `turn.settled`; `turn.paused` means waiting for the person. A failed turn has `turn.settled.data.error.message`.
- Tokens: sum `usage.recorded.data.usage.inputTokens` and `outputTokens`.
- Boss delegating: the call to `davi` or `lia` shows as `call.requested` with `capability.name` `davi`/`lia`, plus `task.started` and `child.opened` (child stream path is member-relative, see Deviations 4). Approvals from Boss's Lia show up on Boss's own stream as `interaction.opened` with an `origin`, and are answered on Boss's session.

---

## v2 (19/11): Claude Agent SDK engine

### Differences from v1 events

1. `session.started.data.runtime` is `{"agentId","agentName","engine":"claude-agent-sdk","model"}` (no `eveVersion`); a thread adds `"thread":true`.
2. Approval option labels are pt-BR: `{"id":"approve","label":"Aprovar"}`, `{"id":"deny","label":"Negar"}`. Ids unchanged.
3. Delegation: Boss calls a subagent with the SDK `Agent` tool. It shows as `call.requested` with `capability.name` = the delegated bot id and `capability.label` `"Delegar para Davi"`; its `call.settled.output` is the subagent's final report (string). The subagent's own tool calls come on the same stream as `call.requested` with `"owner":{"callId":"<delegation callId>"}` and `"origin":{"agent":"davi"}`. There are no `task.started` / `child.opened` events and no child stream. Approvals from a delegated Lia come as `interaction.opened` with `"origin":{"agent":"lia"}` and are answered on the Boss session.
4. Messages sent while a turn runs are queued and become the next turn (no steering).
5. `usage.recorded` comes once per turn, after the reply, and counts every model call in the turn (subagents included).
6. `delivery.consumed.data` carries `"source":"chat"|"schedule"` and, for schedules, `"scheduleId"`. `delivery.admitted.data.source` is `{"channel":"channel:schedule","scheduleId":"watch"}` for schedule deliveries.
7. Approvals in schedule turns are denied right away (`call.settled` `outcome:"rejected"`, `TOOL_EXECUTION_DENIED`) without an `interaction.opened`.
8. Cancel aborts the SDK query; the turn ends with `turn.settled` `outcome:"cancelled"`, and open approvals settle with `outcome:"withdrawn"`.
9. Event `at` values are unique within a session (bumped by 1 ms when needed), so the Mac's `at#index#type` key stays unique.

### Captured v2 turns

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
{"type":"call.settled","data":{"callId":"toolu_01Gq5fMFx6YUxWbBCGNQd48K","outcome":"completed","output":{"url":"https://example.com/","title":"Example Domain","updatedAt":"2026-11-19T12:57:31.215Z","screenshot":"…/data/bots/lia/browser/shots/2026-11-19T12-57-30-712Z.png"}},"scope":{"runId":"run_1","turnId":"turn_0"}}
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

## v3 (19/11): AI proxy with connected accounts

### Event differences

- `model.started.data.account` = `{"id":"mac:codex","provider":"codex","runner":"mac","label":"ChatGPT · Codex (Mac)"}`; `modelId` is the bot's `engine.model`.
- `usage.recorded.data.account` = account id. Token fields as before; providers that don't report a field send 0 (codex has no cache write; cursor reports all four).
- Tool calls come from the gateway MCP handler for every provider: `callId` is ours (`call_…`), not the provider's. A new run (`model.started`, `run_N`) starts after each tool call.
- Live `content.delta` progress only for claude; codex and cursor send whole text blocks (`content.completed`).
- Delegation is a `delegate` MCP tool (`{"bot":"davi","message":"…"}`), provider-agnostic: the delegated bot runs on its own engine/account. It shows as before (`capability.name` = bot id, label "Delegar para Davi", output = report), and the delegated bot's tool calls carry `owner.callId` + `origin.agent`.
- Unavailable account: no model call, the turn fails at once:
```json
{"type":"turn.settled","data":{"outcome":"failed","turnId":"turn_0","error":{"code":"ACCOUNT_UNAVAILABLE","id":"…","message":"A conta Grok (Mac) está sem login. Grok sem login (rode grok login no Mac)."}}}
```

### Paged history

#### `GET {sessionBasePath}/session/:id/events?before=<index>&limit=<n>` → 200

Newest page when `before` is omitted; `limit` default 60, max 200. Each event is a stored NDJSON line (`{at, facts}`) plus its `index`, oldest first inside the page. `nextBefore` is the `before` for the next older page, `null` at the start. `total` is the number of stored lines.

```json
{"events":[{"index":80,"at":"2026-11-19T13:30:39.328Z","facts":[{"type":"delivery.settled","data":{"deliveryId":"152f7716-f45b-4913-b809-5ede24b9cd7f","outcome":"handled","turnId":"turn_1"}}]}],"nextBefore":80,"total":81}
```

Captured chain on Davi's thread (81 lines, `limit=25`): `56–80 → nextBefore 56`, `31–55 → 31`, `6–30 → 6`, `0–5 → null`. Bad `before` → `400 {"ok":false,"error":"before inválido.","field":"before"}`. Unknown session → `409 session_not_active`.

The server keeps each session's lines in memory (loaded once at startup, appended live), so a page is an O(limit) slice; nothing replays the file per request.

`GET /bots/:id/thread` and the `thread` object in `GET /bots` now carry `"total": <stored line count>`. To show history then follow live: load `events` pages backwards, then open `…/stream?startIndex=<total>`. It sends no backlog and only new lines (and heartbeats), with the same cursor rules as before.
