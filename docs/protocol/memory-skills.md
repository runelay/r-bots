# Memória e skills

## v8.1 (19/11): smart memory

Per-bot `"memory":{"recall":true,"capture":true}` appears in `/bots` and can be changed with PATCH (booleans; an unknown key gives 400 with `field`).

### Recall (before every chat turn; schedule turns skip it)

- runelay `search_context {query: message + role, kind:"memory", limit:5}` (~130 ms, 3 s timeout, skipped on error). This covers the user's own memories (shared with Claude Code) and the ones bots wrote.
- The results go into the turn's system prompt as `## O que você já sabe` (name + description + slug per memory, capped at 6,000 chars ≈ 1.5 k tokens).
- Also added: `## O que o time fez hoje`, the last 5 lines from **other** bots in the team log (`data/team-log.ndjson`, today only).
- Event: `{"type":"memory.recalled","data":{"slugs":[…],"titles":[…]}}`.

### Capture (after each non-group chat turn, async, after `turn.settled`)

1. **Jev:** two nouls, `durable` (decision / preference / fact / recurring task) and `secret`. Logged as `decision.made {kind:"memory", answer:{durable, secret}, outcome:"capture"|"skip"|"skip_secret"|"fallback"}`. Capture only when durable ≥ 0.6, secret < 0.3, and the text matches no secret regex (API keys, ghp/xox/Bearer tokens, long hex/base64, card numbers, CPF, "senha: …").
2. **One cheap extraction call** on the bot's own account: Haiku 5.5 on Claude, `auto` on Cursor, the bot's own model on Codex/Grok, no tools. It returns `{"facts":[{title, body, tags}], "summary"}` with 0–3 facts written about the user, not the bot.
3. **Dedupe:** a fact whose title or slug matches a recalled memory updates that memory. New ones get the slug `rb-<botId>-<slug(title)>`. Written with runelay `write_memory` (`type:"user"`, body ends with `Tags: runelay-bots, <botId>, …`).
4. `summary` (one line) goes into the team log.
5. Event: `{"type":"memory.saved","data":{"titles":["…"],"items":[{"title","slug","updated":false}],"botId":"davi"}}`. The Mac can show "Lembrei: …".

### Context reset

When a chat session passes ~120 k tokens, the provider session is dropped as before. One cheap summary call (same model rule) then replaces the 12-exchange carry-over with a real summary of the last 60 exchanges.

### Verified 19/11

- **Davi:** "Anota uma preferência minha: quando me passar números, prefiro em tabela." He replied and also called `update_instructions` himself. Jev: durable 0.97, secret 0.02, so `capture`. `memory.saved` gave `rb-davi-preferencia-numeros-em-tabela`, which runelay `read_memory` returned. The team log got one line.
- **Boss** (new session): "como eu prefiro receber números?" `memory.recalled` included `rb-davi-preferencia-numeros-em-tabela`, and Boss answered "Em tabela." His own capture updated the same memory instead of duplicating it.
- **Fixes after the check:** the first extraction wrote the fact as Davi's preference and used a slug as the title. The extraction prompt now says "Pessoa" is the user and asks for a readable title, and I rewrote that memory. Usage: Davi 4 / 135 / 7,728 / 2,284 plus one Haiku extraction; Boss 2 / 8 / 0 / 4,522 plus one Haiku extraction.

---

## v16 (19/11): skills in the composer ("/")

### `GET /skills?query=` → 200

```json
[{"slug":"commit","name":"Commit","description":"Quando o usuário pedir para commitar, fazer commit, criar commits ou organizar mudanças no git."}]
```
- Source: runelay REST `GET /v1/skills` (same origin and token as `RUNELAY_MCP_URL` / `RUNELAY_MCP_TOKEN`), enabled skills only.
- No `query`: every skill (pages of 100), sorted by name, cached 60 s. With `query`: runelay's own server-side search (`?query=`), first 100 hits, cached 30 s per term. `?refresh=1` skips the cache.
- `name` is runelay's name; when that is just the slug, it becomes readable (`acompanhar-missoes` → `Acompanhar missoes`). `description` is the first sentence, cut at 140 chars.
- `503` when runelay isn't configured, `502` when it doesn't answer.

### Field `skills` on send

`POST /bots/:id/eve/v1/session` and `POST /bots/:id/eve/v1/session/:sessionId` accept `"skills": ["commit", …]` (up to 5 slugs, `[a-z0-9][a-z0-9_.-]{0,119}`).
- The server loads each skill with runelay `GET /v1/skills/:slug` (cache 60 s). Unknown slug → `400 {"field":"skills","error":"Essa skill não existe mais na runelay."}`; nothing is delivered.
- `message` can be empty when `skills` is set: the turn text becomes `/Nome` for each skill.
- The turn's system prompt gets, per skill: `## Siga a skill <nome>`, the line "A pessoa anexou esta skill à mensagem. Siga as instruções dela neste turno.", the SKILL.md body (cut at 40 k chars) and, when the bot has `connectors.memory`, the list of the skill's files to read with `skill_read(slug, path)`.
- `delivery.consumed.data.skills = [{"slug","name"}]`, so the Mac shows the chips above the user bubble, also when loading history.

### Mac

- Typing `/` at the start of the composer or after a space opens a menu above it: "Comandos" (`/novo-bot`, `/limpar` since v17) and "Skills" (icon, name, one-line description). The skill list comes from `GET /skills?query=` with a 140 ms debounce. ↑↓ moves, ↩/Tab picks, Esc closes.
- A picked skill becomes a removable chip inside the composer (⌫ on an empty field removes the last one). Several are allowed (max 5).

### Verified 19/11

- `GET /skills` → 176 skills; `?query=commit` → Commit, Resolver pr, Pr summary, … Unknown slug → 400; `"skills":"x"` → 400.
- One real turn on `teste-de-voz` (Haiku) with `skills:["animation-vocabulary"]`: "Como se chama o efeito do popover que abre quicando?" → "**Pop in**: …", the term from the skill. `delivery.consumed` carried `skills:[{"slug":"animation-vocabulary","name":"Animation vocabulary"}]`. Usage 2 / 441 / 0 / 9,697. No side effects.

---

## v25 (19/11): autonomia no código e nos conectores, skills garantidas no prompt, microfone

### Skills anexadas
- O app manda numa mensagem só o texto e todos os chips. O caso de 19/11 ("/Commit" e "/Pr summary" em duas deliveries, sem o texto) veio do Enter do menu "/": ele anexava o chip e o `onSubmit` enviava junto. O composer ignora o submit até 0,6 s depois de escolher no menu.
- O prompt do turno leva a skill inteira ("A pessoa anexou a skill… não é comando de barra… Siga cada uma inteira") e o pedido sem os "/Nome" crus; skill-only vira "Faça o que a skill anexada pede". O bloco saiu do system append, que o Cursor descartava no resume. Vale também para grupo e para delivery que sai da fila.
