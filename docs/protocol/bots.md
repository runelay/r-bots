# Bots

## runelay bots: verified protocol

### Custom routes

#### `GET /bots` → 200

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

## v2 (19/11): Claude Agent SDK engine

### Bots as data

Since 19/11 (evening) bots are only data: `data/bots/<id>.json`, created by the person or by another bot (`create_bot`). There is no seed and no built-in bot: an empty `BOTS_DATA_DIR` starts with `GET /bots` → `[]` and the app shows "Criar seu primeiro bot". The `builtIn` field was dropped from responses (old files may still carry it; it is ignored), no bot is protected from edit, archive or delete, and the list is ordered by `createdAt` (then `id`). Delegation targets are every other active bot (`delegatesOf`). `LEGACY_SERVER_DIR` is gone; the old eve server lives in `runelay-bots-archive/server-eve`, outside this repo. The examples below predate this and still show `builtIn`.

#### `GET /bots` → 200 (archived bots only with `?archived=1`)

```json
[{"id":"boss","name":"Boss","role":"Chefe do time","accent":"indigo","glyph":"auto","sessionBasePath":"/bots/boss/eve/v1",
  "schedules":[{"name":"briefing","description":"Briefing dos dias úteis às 08:30, com o retrato de produção do Davi.","cron":"30 8 * * 1-5","timezone":"America/Sao_Paulo","prompt":"Bom dia. Monte o briefing do dia útil. …"}],
  "hasBrowser":false,"instructions":"# Boss\n\nVocê é o Boss, …","capabilities":{"browser":false,"prodQuery":false,"delegate":["davi","lia"]},
  "builtIn":true,"createdAt":"2026-11-19T12:56:10.000Z","updatedAt":"2026-11-19T12:56:10.000Z","archivedAt":null,
  "thread":{"sessionId":null,"lastMessage":null,"unread":0}}]
```

Built-in accents moved into the v2 palette: Boss `indigo`, Davi `teal` (was `green`), Lia `violet` (was `pink`). `GET /bots/:id` returns one object. `thread.sessionId` is `null` until the thread is created (`GET /bots/:id/thread` or the first schedule run).

#### `POST /bots` → 201

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

#### `PATCH /bots/:id` → 200

Partial update of the same fields; `capabilities` is merged key by key, `schedules` replaces the list. Built-in bots are editable. Schedules reload right away.
```json
{"role":"Testador","schedules":[{"name":"manha","cron":"0 9 * * 1-5","prompt":"oi"}]}
```
→ the full bot, with `"schedules":[{"name":"manha","cron":"0 9 * * 1-5","timezone":"America/Sao_Paulo","prompt":"oi","description":""}]`.

#### `POST /bots/:id/archive`, `POST /bots/:id/unarchive` → 200 with the bot

`archivedAt` set (or cleared). Archived bots leave `GET /bots`, stop their schedules, are dropped from other bots' delegation, and refuse new messages with `409 {"ok":false,"code":"bot_archived","error":"Esse bot está arquivado."}`. Their history stays readable.

#### `GET /meta` → 200

```json
{"accents":["electric","teal","violet","royal","sky","indigo"],
 "capabilities":[{"id":"browser","label":"Navegador","description":"Abre páginas, lê, clica e preenche. Clique e preenchimento pedem aprovação."},
                 {"id":"prodQuery","label":"Consulta em produção","description":"Roda SELECT no banco de produção, só leitura."},
                 {"id":"delegate","label":"Delegar","description":"Passa partes do trabalho para outros bots do time."}],
 "engine":"claude-agent-sdk","model":"claude-sonnet-5-5"}
```

## v6 (19/11): bots configure themselves

### Creating

`POST /bots` needs only `name` (plus optional `accent` and `instructions`). If `role` is missing or empty, it comes from the first sentence of the instructions (≤ 60 chars), for example "Acompanho o clima de São Paulo e mando resumos curtos". Defaults for a new bot:
- `engine` `{"account":"vps:claude","model":"claude-sonnet-5-5","effort":null}`
- `capabilities` `{"browser":true,"prodQuery":false,"delegate":[every other active bot]}`
- `schedules` `[]`
- `decisions` `{"autoApprove":true,"threshold":0.85}`

### Self-configuration tools (MCP server `bots`, every bot)

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

### v6.1 (19/11): create with name + glyph + color

- `POST /bots` needs only `name`. `instructions` and `role` are optional. Without instructions, `role` is `"Novo no time"`.
- `glyph`: any id matching `^[a-z0-9-]{1,40}$` (e.g. `face-07`, default `auto`). Pickable faces are the presets `crown`, `visor`, `antenna` plus `face-1`…`face-11`; the face never comes from the bot id (`auto` = generated from the id hash). Old names are aliases, saved and read as the preset: `boss` → `crown`, `davi` → `visor`, `lia` → `antenna`. Otherwise `400 {"ok":false,"error":"Ícone inválido: use até 40 caracteres de a-z, 0-9 e hífen.","field":"glyph"}`.
- `accent`: `GET /meta` now lists `["white","amber","red","orange","yellow","green","teal","blue","violet","pink","grey"]` (default `blue`). The old names `electric`, `royal`, `sky` and `indigo` are still accepted for existing bots.
- A bot without instructions runs on a default system prompt: it is new on the team with no job yet; on the first message it introduces itself in one sentence and asks what to do; once told, it configures itself with `set_role`, `update_instructions` (replace), and `add_schedule` / `request_capability` if needed, then confirms in one line.
- Right after creation the server writes a fixed greeting into the bot's thread, with no model call: `content.completed` `{"kind":"text","partId":"greeting.0","phase":"reply","runId":"greeting","value":"Oi! Eu sou <nome> e acabei de chegar no time. O que você quer que eu faça?","greeting":true}`. The thread's `lastMessage` is the greeting and `unread` is 1. There is no surrounding `turn.started` / `turn.settled`. The first real turn gets the greeting in its conversation summary.

---

## v7 (19/11): sidebar preferences, sections, soft delete

### Bot sidebar prefs

`GET /bots` (and `GET /bots/:id`) add `"sidebar":{"pinned":false,"sectionId":null,"hidden":false}` and `"deletedAt":null`.

`PATCH /bots/:id/sidebar` partial update → 200 with the bot:
```json
{"sectionId":"sec_9dd8d5659073","pinned":true}
```
→ `"sidebar":{"pinned":true,"sectionId":"sec_9dd8d5659073","hidden":false}`. An unknown or archived section gives `400 {"ok":false,"error":"Seção não encontrada.","field":"sectionId"}`. A non-boolean `pinned`/`hidden` or an unknown field also gives 400.

`GET /bots` leaves out hidden bots; `?hidden=1` includes them. Hidden bots still run their schedules and can still be reached by id. Filters combine: `?archived=1&hidden=1&deleted=1&q=…`.

### Soft delete ("Excluir")

- `POST /bots/:id/delete` → 200 with the bot, `deletedAt` set. Nothing is removed from disk.
- `POST /bots/:id/restore` → 200, `deletedAt:null`.
- Deleted bots leave `GET /bots` unless `?deleted=1`, their schedules are unloaded, and they are dropped from other bots' delegation. New messages get `409 {"ok":false,"code":"bot_deleted","error":"Esse bot foi excluído."}`. Archive and unarchive work as before.

---
