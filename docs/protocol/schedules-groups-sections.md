# Rotinas, grupos e seções

## v2 (19/11): Claude Agent SDK engine

#### Schedules post into the thread

A schedule run is a new turn in the bot's thread, not a new session:

```jsonl
{"type":"delivery.admitted","data":{"deliveryId":"b0d11d2e-0d11-42e1-8172-4ea18b317133","principal":{"id":"anonymous","type":"anonymous"},"source":{"channel":"channel:schedule","scheduleId":"watch"}}}
{"type":"turn.started","data":{"cause":{"deliveryId":"b0d11d2e-0d11-42e1-8172-4ea18b317133"},"follows":null,"turnId":"turn_1"},"scope":{"turnId":"turn_1"}}
{"type":"delivery.consumed","data":{"deliveryId":"b0d11d2e-0d11-42e1-8172-4ea18b317133","parts":[{"kind":"text","text":"Ronda de produção. Procure problemas óbvios usando só `prod_query`. …"}],"turnId":"turn_1","source":"schedule","scheduleId":"watch"},"scope":{"turnId":"turn_1"}}
```

The Mac should render a `delivery.consumed` with `"source":"schedule"` as a small system line (for example "Rotina watch") instead of a user bubble. The bot reply arrives as a normal `content.completed` `phase:"reply"`.

Model context: a schedule turn runs in a fresh SDK session (no resume). The model sees only the bot's system prompt, the schedule prompt and, when there is one, a one-paragraph summary of the previous reply of the same schedule. Its events still land in the thread NDJSON as above, and its `usage.recorded` is that run alone. Chat turns resume the thread's own SDK session, which never contains schedule tool transcripts; the next chat turn gets a short note with the replies of the schedules that ran since the last chat message. When a chat turn ends with more than ~120k input tokens of context (`BOTS_CONTEXT_LIMIT`), the next chat turn starts a new SDK session behind the same thread `sessionId`, seeded with the last exchanges as a summary.

#### `POST /bots/:id/schedules/:name/run` → 202

Runs a schedule now, into the bot's thread, exactly like the cron would.
```json
{"ok":true,"sessionId":"wrun_01M7SYEEHE51CHWFHPJR17Z2AM","deliveryId":"4875d431-dfdf-4942-af3a-3d9a02b55fcc","scheduleId":"watch"}
```
Unknown schedule → `404 {"ok":false,"error":"Rotina não encontrada."}`; archived bot → `409 bot_archived`. Captured run (Davi `watch`, 6 queries): `"usage":{"inputTokens":1406,"outputTokens":3426,"cacheReadTokens":58443,"cacheWriteTokens":12474}`, against `cacheReadTokens: 331032` for the same schedule when it resumed the thread.

## v7 (19/11): sidebar preferences, sections, soft delete

### Sections

- `GET /sections` → `[{"id":"sec_d88d6324968c","name":"QA","order":1},{"id":"sec_9dd8d5659073","name":"Prod","order":5}]` (active only, sorted by `order`).
- `POST /sections {"name":"Produção"}` → `201 {"id":"sec_9dd8d5659073","name":"Produção","order":0}`. `order` is optional; by default it goes after the last section. `name` is 1–40 chars.
- `PATCH /sections/:id {"name":"Prod","order":5}` → 200. `order` must be an integer from 0 to 10000.
- `POST /sections/:id/archive` → `200 {"id","name","order","archivedAt"}`. Bots in that section get `sectionId:null`. Unknown id → 404.

## v9 (19/11): groups

### Routes

- `POST /groups {"name":"Time","members":["boss","davi"]}` → 201:
```json
{"id":"grp_1fbee052aa1f","name":"Time","members":["boss","davi"],"sessionBasePath":"/groups/grp_1fbee052aa1f/eve/v1","createdAt":"…","updatedAt":"…","archivedAt":null,
 "thread":{"sessionId":"wrun_01M7T3QJ7V5V1F3WEZEE43NQ54","lastMessage":null,"unread":0,"total":1,"running":false}}
```
  `name` is 1–40 chars. `members` takes 2–8 active bot ids. Errors are 400 with `field`, for example `"Um grupo precisa de pelo menos dois bots."` or `"Não existe bot ativo com id \"nina\"."`.
- `GET /groups` (`?archived=1`), `GET /groups/:id`, `PATCH /groups/:id {name?, members?}`, `POST /groups/:id/archive|unarchive`.
- `GET /groups/:id/thread`, `POST /groups/:id/thread/read`, `POST /groups/:id/thread/unread`. The thread's `lastMessage.text` is prefixed with the bot name, and `lastMessage.botId` is set.
- The session API is the same as for bots, under `sessionBasePath`: `POST …/session/:id` with `message` or `answers`, `/cancel`, `/stream`, `/events`. Creating extra sessions (`POST …/session`) gives 405: a group has only its thread.

### Turn routing

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
- Nina could not join because she had been soft-deleted from the app at 14:21. The test group was archived afterwards.
