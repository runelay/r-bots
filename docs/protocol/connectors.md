# Conectores (runelay)

## v8 (19/11): connectors via runelay

The server is an MCP client of the user's runelay. It uses the same endpoint and token as the user's Codex/Claude Code (`http://127.0.0.1:4312/v1/mcp`, copied into `.env.local` as `RUNELAY_MCP_URL` / `RUNELAY_MCP_TOKEN`, chmod 600, never logged). It uses runelay's tools `list_connections`, `search_tools`, `call_tool`, `search_context`, `read_memory`, `write_memory`, `read_skill` and `read_skill_file`.

### `GET /connectors` (cache 60 s) / `POST /connectors/refresh` → 200

```json
[{"name":"linear_server","label":"Linear","icon":"linear","status":"ok","toolCount":84,"reconnectUrl":null}, "… 16 connections"]
```
- `icon` is runelay's value: a slug like `linear` or `github`, a path like `/logos/conty.png`, or `null`.
- `status` is `ok`, `needs_auth` or `error`.
- `reconnectUrl` is `RUNELAY_RECONNECT_URL` when set and the status is not ok, otherwise `null`.
- Connection configs and headers are never exposed.
- `503` when runelay isn't configured, `502` when it doesn't answer.

### Bot `connectors`

`"connectors":{"allowed":["linear_server"],"memory":true}` appears in `/bots` and can be changed with PATCH (`allowed` takes runelay connection names, `[a-z0-9_-]{1,60}`). Default: nothing allowed, memory on. The self-config tool `request_connector(name, reason)` always opens a human card and then adds the name to `allowed`.

### Bot MCP tools

- `connector_search(query, limit?)` → runelay `search_tools`, filtered to `allowed` connections. Returns `[{name:"linear_server.list_teams", description, inputSchema}]`.
- `connector_call(tool, args)`: `tool` is `connection.tool`, and the connection must be in `allowed`. Goes to runelay `call_tool`; output is cut at 20 k chars.
- With `memory:true`: `memory_search(query, kind?)`, `memory_read(slug)`, `skill_read(slug, path?)`, and `memory_write(slug, body, name?, description?)`, which is gated as a write.

### Gate (by tool name, in code)

- **outbound:** send, email, mail, message, reply, comment, chat, notify, sms, whatsapp, tweet, dm, invite, share. Always a human card; Jev is not asked (`decision.made` reason "Mensagem para fora sempre passa por uma pessoa."). Examples: `linear_server.save_comment`, `gmail.send_email`.
- **read:** tool name starts with get, list, search, read, fetch, query, find, describe, show, view, count, me, lookup, check, status, and so on, as a whole word. Runs after a Jev check. Only Jev risk ≥ 2 with confidence ≥ 0.5 sends it to a person (`outcome` `allowed` or `human`).
- **write:** everything else (create, update, save, merge, execute, …). Jev is asked and logged, and then always a human card ("Escrita em serviço externo sempre passa por uma pessoa.").
- In schedule turns, anything that needs a person is denied.

Events: `call.requested.data.capability = {"kind":"tool","name":"connector:linear_server.list_teams","label":"Linear: list_teams","connector":"linear_server"}`, so the Mac can show the service logo. Search and memory calls use `name` `connector_search`, `memory_search`, `memory_read`, `skill_read` or `memory_write`.

Verified 19/11:
- **Direct, no model:** 16 connections, all ok. Search "linear issue" returned `get_attachment` [read] and `create_attachment` / `delete_attachment` [write]. `linear_server.list_teams` returned the teams. Classifier checks: `save_comment` outbound, `save_issue` write, `merge_pull_request` write, `list_comments` read, `get_me` read.
- **One real turn:** Davi with `allowed:["linear_server"]`, asked "Quais times existem no Linear?", ran `connector_search` then `connector:linear_server.list_teams` with no card, and replied "Many, Conty, Conty - Operacoes, Magalu, Conty GTM". Usage 6 / 178 / 9,526 / 6,003. No write was made to any service.

---

## v14 (19/11): connector catalog and install

The server now forwards runelay's catalog and install APIs (`/v1/catalog`, `/v1/catalog/install`, `/v1/sources/:name/oauth`, `DELETE /v1/sources/:name`) with the same `RUNELAY_MCP_TOKEN` (an org API key). The API base is `RUNELAY_API_URL`, or the origin of `RUNELAY_MCP_URL`. Errors: `400` for bad input, `404` for an unknown catalog id, `409` when it is already installed, `502` when runelay fails, `503` when runelay isn't configured. Every error is `{"ok":false,"error":"…"}` in pt-BR.

### `GET /connectors/catalog?query=` → 200

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

### `POST /connectors/:id/install {"token"?}` → 201

Installs the catalog item on runelay and, for `oauth`, starts the login:
```json
{"sourceName":"sentry","status":"needs_auth","error":"A conexão precisa de login.","authorizationUrl":"https://mcp.sentry.dev/oauth/authorize?…"}
```
The app opens `authorizationUrl` in the browser and reloads the catalog when it becomes active again. `api_key` items need `token` (400 without it). `none` items return `authorizationUrl:null` and are ready. The `GET /connectors` cache is cleared.

### `POST /connectors/:sourceName/reconnect` → 200

`{"sourceName":"sentry","authorizationUrl":"https://…"}`. `authorizationUrl` is `null` when the connection didn't need a login. Note that runelay clears the stored OAuth tokens before starting a new login.

### `DELETE /connectors/:sourceName` → 200

`{"ok":true,"sourceName":"sentry"}`. Removes the connection from runelay for every agent in the org.

Verified 19/11: catalog with 1 featured + 3 sections (8/13/12 items), search `goo` returned only Google items, `install` for `NOPE` (400), `inexistente` (404), `linear` (409, already installed) and `firecrawl` without a token (400). `install sentry` created the connection as `needs_auth` and returned the Sentry OAuth URL (login not completed), `reconnect sentry` returned a new URL, and `DELETE /connectors/sentry` removed the test connection, so the org is back to where it started.
