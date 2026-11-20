# Contas, motor do bot e runners

## v3 (19/11): AI proxy with connected accounts

Captured on 2026-11-19 from `apps/server/` (gateway 127.0.0.1:2000, tailnet :10447) and the Mac runner (`<ip-do-mac-no-tailnet>:4790`).

### Accounts

#### `GET /accounts` → 200 (cached 10 min; `?refresh=1` re-detects)

```json
[{"id":"vps:claude","runner":"vps","provider":"claude","label":"Claude · assinatura (VPS)","status":"ready","models":[{"id":"claude-sonnet-5-5","label":"Sonnet 5.5"},{"id":"claude-opus-5-5","label":"Opus 5.5"},{"id":"claude-haiku-5-5","label":"Haiku 5.5"},{"id":"claude-fable-5-2","label":"Fable 5.2"}],"detail":"ferramentas@… · team","checkedAt":"2026-11-19T13:24:10.112Z"},
 {"id":"vps:codex","runner":"vps","provider":"codex","label":"ChatGPT · Codex (VPS)","status":"ready","models":[{"id":"gpt-6.2-sol","label":"GPT-6.2-Sol"},"…"],"detail":"Logged in using ChatGPT"},
 {"id":"vps:grok","status":"missing","detail":"CLI não instalada nesta máquina.","models":[]},
 {"id":"vps:cursor","status":"missing"},
 {"id":"mac:claude","status":"ready","detail":"voce@exemplo.com · team"},
 {"id":"mac:codex","status":"ready"},
 {"id":"mac:grok","status":"logged_out","detail":"Grok sem login (rode grok login no Mac).","models":[{"id":"grok-4.6","label":"grok-4.6"},{"id":"grok-4.5","label":"grok-4.5"}]},
 {"id":"mac:cursor","status":"ready","detail":"✓ Logged in as voce@exemplo.com","models":[{"id":"auto","label":"Auto (default)"},"… 284 models"]}]
```

`status`: `ready`, `logged_out`, `missing` (CLI not installed), `offline` (runner unreachable; all four `mac:*` entries turn offline with `detail` "Mac fora do ar: …").

Model lists: claude is a static list (Sonnet/Opus/Haiku 5.5, Fable 5.2); codex comes from `codex debug models` (entries with `visibility: "list"`); cursor from `cursor-agent models`; grok from `grok models`.

#### `POST /accounts/refresh` → 200 with the same array, re-detected on every runner.

### Bot engine

Every bot now has `"engine":{"account":"vps:claude","model":"claude-sonnet-5-5","effort":null}` (default for existing bots). `POST /bots` and `PATCH /bots/:id` accept `engine` (partial in PATCH). `account` must be `vps|mac` + `:` + `claude|codex|grok|cursor`; changing `account` without `model` picks the provider default (`claude-sonnet-5-5`, `gpt-5.6-sol`, `grok-4.6`, `auto`); `effort` is `low|medium|high|null`. Errors: `400 {"ok":false,"error":"Conta inválida. Use runner:provedor, por exemplo mac:codex.","field":"engine.account"}`, `field` `engine.model` / `engine.effort`. `GET /meta` adds `"efforts":["low","medium","high"]` and `"engine":"multi-provider"`.

### Runners

- `vps`: in-process (claude via Agent SDK, codex CLI).
- `mac`: `~/runelay-bots/runner` (launchd `com.runelay.bots.runner`, KeepAlive), listening on `<ip-do-mac-no-tailnet>:4790` only, `Authorization: Bearer $RUNNER_TOKEN` (shared with `.env.local`). `GET /health` (no auth), `GET /accounts`, `POST /turns` (body = turn request, response = NDJSON provider events), `POST /turns/:turnId/cancel`.

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

## v21 (19/11): runner do Mac embutido no app

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
- Servidor (`apps/server/src/modules/accounts/services/mac-runner.service.ts`): `apps/server/src/modules/accounts/services/accounts.service.ts`, `apps/server/src/modules/computer/services/computer.service.ts` e o `upgrade` em `apps/server/src/app.ts` usam o WebSocket quando conectado e caem no `MAC_RUNNER_URL` (HTTP antigo) quando não. Conectar ou cair recalcula só as contas `mac:*`. App fechado: `mac:*` = `offline` e as ferramentas do computador devolvem `COMPUTER_UNAVAILABLE`.
- Rollback: `~/runelay-bots/runner` ficou no disco; o plist está em `~/runelay-bots/backup/com.runelay.bots.runner.plist.bak` (voltar para `~/Library/LaunchAgents` e `launchctl bootstrap gui/$(id -u) …`).

## v26 (19/11): handoff de contexto entre contas/modelos + conta reserva no limite

### Conta reserva (`engine.fallback`)
- **Configuração:** `engine.fallback: {account, model} | null`.
  - Sem o campo vale a sugestão: `vps:codex` (ou `vps:claude` se a principal já é Codex).
  - `null` desliga.
  - `PATCH /bots/:id {engine:{fallback:{account:"vps:codex"}}}`; o modelo padrão do provider entra se faltar.
  - `GET /bots` devolve o fallback resolvido.
- **Detecção** (`apps/server/src/modules/accounts/services/limits.service.ts`):
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

## v38 (19/11): dispositivos e conexão reversa (o Mac chama o servidor)

`MAC_RUNNER_URL`, `PUBLIC_MCP_BASE` e `RUNNER_TOKEN` saíram: nenhuma é lida. O servidor nunca chama o Mac; o app abre uma conexão de saída com o servidor no mesmo endereço configurado nele e tudo passa por ela. Login é obrigatório: o Mac só conecta com um token de dispositivo emitido para uma sessão do better-auth. A chave interna que sobrou (`<data>/runner.token`) é gerada sozinha no primeiro boot.

### Dispositivos

Cada Mac é um dispositivo da conta. O token é uma chave `rbk_` do better-auth (`name: "device"`, `metadata: {kind:"device", deviceId, name, model, osVersion, appVersion, machineId, registeredAt}`), guardada no Keychain do Mac (`com.runelay.bots.auth`, conta `<origem>|device`).

- `POST /devices` (só com a sessão; token de dispositivo ou chave dá 403) `{name, model?, osVersion?, appVersion?, machineId?}` → 201 `{ok, device, token}`. Mesmo `machineId` do mesmo usuário reaproveita o `id` e o `registeredAt` e troca o token (o antigo deixa de valer). Erros: 400 `{field}` (`name` obrigatório até 80, `model` até 80, `osVersion`/`appVersion` até 40, `machineId` até 128).
- `GET /devices` → 200 `{ok, devices:[{id, name, model, osVersion, appVersion, userId, registeredAt, connected, connectedAt, lastSeenAt}]}`. O dono vê todos; membro vê os dele.
- `DELETE /devices/:id` → 200 `{ok, id, revoked:true, disconnected}`. Apaga o token e fecha a conexão viva com o código `4001 revoked`. Membro só remove os dele (404 nos outros).
- Sem sessão: 401 `unauthorized`.

### Conexão (`GET wss://<servidor>/runner/connect`)

- `Authorization: Bearer <token do dispositivo>`. Sessão, chave `rbk_` comum ou a chave interna dão 401; um socket sem dispositivo fecha com `4003`.
- Uma conexão por dispositivo (a nova do mesmo Mac fecha a antiga com `4000 replaced`); vários Macs ao mesmo tempo.
- Ping do servidor a cada 15 s, do app a cada 20 s; o app reconecta com espera de 1 s a 15 s. Ao receber 401/403 ou `4001`, o app apaga o token, mostra "Este Mac foi desconectado da conta" e não volta sozinho; "Conectar este Mac" em Ajustes › Dispositivos registra de novo.
- `hello.capabilities` ganha `mcp-proxy`. Os frames da v21 (contas, turnos, computador, arquivos, gravação, cofre, uso) continuam iguais.
- Proxy MCP: o app sobe um servidor HTTP em `127.0.0.1:<porta aleatória>`. Para um Mac com `mcp-proxy`, o servidor manda `turn.mcp.url` só com o caminho (`/mcp/<bot>/<sessão>`) e o app troca por `http://127.0.0.1:<porta>/mcp/…` antes de abrir a CLI. Cada chamada da CLI vira:
  - app → servidor: `{"type":"mcp.request","id","method":"POST"|"GET"|"DELETE","path":"/mcp/<bot>/<sessão>","headers":{authorization, content-type, accept, mcp-session-id, mcp-protocol-version},"body":"<json>"}`
  - servidor → app: `{"type":"mcp.response","id","status","headers":{content-type, mcp-session-id},"body":"<json>"}`
  - O servidor só aceita esse caminho (outros dão 404) e repassa ao próprio `/mcp`, que continua exigindo o token do turno.

### Contas por Mac

- O primeiro Mac registrado (ordem de `registeredAt`) usa `mac:<provedor>`; os outros, `mac-<8 primeiros caracteres do id>:<provedor>`. `runner` continua `"mac"` e cada conta traz `device: {id, name, connected}`; o rótulo vira `Claude · <nome do Mac>`.
- Mac registrado e app fechado: `status:"offline"`, `detail:"Mac desconectado: abra o app runelay bots nele."`. Nenhum Mac na conta: `mac:*` com `device:null` e `detail:"Nenhum Mac na conta: entre no app runelay bots no Mac."`.
- Turno para um Mac fora da conexão termina com `done {ok:false, message:"Mac desconectado."}`. Computador, cofre, uso e arquivos usam o Mac conectado mais antigo.

### Runner Node antigo

Já não roda desde a v21 e nada depende dele. Para tirar do Mac (a pasta de trabalho `~/runelay-bots/runner/data/work` é usada pelo app no `--resume` do Claude; não apague):

```sh
launchctl bootout gui/$(id -u)/com.runelay.bots.runner 2>/dev/null
rm -f ~/Library/LaunchAgents/com.runelay.bots.runner.plist ~/runelay-bots/backup/com.runelay.bots.runner.plist.bak
find ~/runelay-bots/runner -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
rm -f ~/Library/Application\ Support/runelay\ bots/runner.token
```

### Verificado

Instância separada (`GATEWAY_PORT=2110`, `BOTS_SCHEDULES=off`, banco novo, dono criado), exposta só no tailnet, com o app de teste no Mac:

```
POST /devices (pelo app, sessão)          -> registrou "MacBook Air de Anderson (2)", Mac17,3, 26.6.2
log: mac runner connected (7619b352-…)
GET /accounts?refresh=1
  mac:claude ready  "Claude · MacBook Air de Anderson (2)"  device {id:"7619b352-…", name:"MacBook Air de Anderson (2)", connected:true}
  mac:codex ready · mac:grok logged_out · mac:cursor ready
servidor reiniciado -> o app reconectou sozinho
turno em mac:claude (claude-haiku-5-5): call.requested computer_apps -> call.settled completed (apps do Mac)
  -> "São 12 apps abertos. Um deles é o Finder."  (CLI no Mac -> proxy local -> conexão -> /mcp -> computer.tool -> executor)
DELETE /devices/7619b352-…  -> {"ok":true,"revoked":true,"disconnected":true}
log: mac runner disconnected (7619b352-…); 25 s sem reconexão
GET /accounts: mac:claude offline "Nenhum Mac na conta: entre no app runelay bots no Mac."

POST /devices {"name":"Mac de teste",…,"machineId":"doc-capture"} -> 201
  {"ok":true,"device":{"id":"60f5b9fb-…","name":"Mac de teste","model":"Mac17,3","osVersion":"26.6.2","appVersion":"0.5.0","userId":"fZtW…","registeredAt":"2026-11-19T23:59:23.137Z","connected":false,"connectedAt":null,"lastSeenAt":null},"token":"rbk_…"}
POST /devices com o token do dispositivo -> 403 {"ok":false,"code":"forbidden","error":"Entre pelo app para registrar este Mac."}
POST /devices {} -> 400 {"ok":false,"error":"Falta name.","field":"name"}
GET /devices sem credencial -> 401 {"ok":false,"error":"Entre de novo para continuar.","code":"unauthorized"}
WS /runner/connect: sessão 401 · token do dispositivo 101
DELETE /devices/60f5b9fb-… -> {"ok":true,"id":"60f5b9fb-…","revoked":true,"disconnected":false}; de novo -> 404 {"ok":false,"code":"not_found","error":"Dispositivo não encontrado."}
```
