# Uso, status e limites

## v28 (19/11): uso e limites do Claude e do Codex (VPS + Mac)

Tela "Uso" no app (anéis no trilho, acima da engrenagem) e duas rotas de leitura. Só fontes locais ou do próprio login, nenhuma chave nova. Nada é escrito em `~/.claude` ou `~/.codex`.

### `GET /usage/limits[?refresh=1]`

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

### `GET /usage/summary?range=24h|7d|30d|90d&provider=claude|codex&environment=vps|mac`

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

### Cache incremental

- **VPS:** `data/usage/vps-index.json` guarda o offset em bytes por arquivo (só lê o que cresceu; arquivo menor que o offset é relido do zero), o estado do Codex por arquivo, buckets `hora|provedor|modelo|velocidade → [input, cacheRead, cacheWrite5m, cacheWrite1h, output, reasoning, requests]`, as sessões e os hashes de deduplicação. Tudo com mais de 100 dias é descartado. Leitura no máximo 1×/min; o aquecimento roda 15 s depois de subir. A 2ª passada leva ~80 ms.
- **Mac:** o mesmo esquema em Swift (`Features/Accounts/Runner/LocalUsage.swift`, actor `LocalUsageScanner`), com índice em `~/Library/Application Support/runelay bots/usage-index.json`. O servidor pede `op: usage.buckets { since }` (timeout 10 min) e guarda a resposta por 2 min. A primeira leitura (~9,6 GB) levou ~1 min. Enquanto ela roda, o resumo volta em até 8 s com `environments.mac.pending = true` e o app tenta de novo a cada 15 s.

### App

- **Anéis no trilho:** `UsageRailIndicator`, um por provedor, 35 pt, com toque de 40 pt. O anel de fora é a sessão de 5 h, o de dentro é o semanal/mensal, e o preenchimento é o % restante: âmbar abaixo de 25%, vermelho abaixo de 10%. Com várias contas, mostra a de menor restante. Tooltip "Claude · sessão 93% restante, volta em 1h 18m · semanal 8% restante, volta em 21h 8m". Atualiza a cada 2 min e quando o app volta ao primeiro plano.
- **Tela Uso:** `AppSection.usage`, fora de `railCases`. Tem as abas Limites/Tokens/Custo e filtros de período, provedor e ambiente.
- **Aviso:** abaixo de 10%, notificação do macOS uma vez por conta+janela+reset (`usage.notified` no UserDefaults), com a linha da reserva quando houver. O clique abre a tela Uso.

### Verificado 19/11

- **Claude VPS:** `/usage` = 7% / 92% / Fable 29%, volta 21:10 UTC e 20/11 17:00 UTC; a rota deu os mesmos valores e horários.
- **Claude Mac** (mesma conta da sessão Claude Code da VPS em `~/.claude-2`, mesmo `accountUuid`): `/usage` = 25% / 16% / Fable 0%, volta 23:10 e 25/11 18:00; a rota deu igual.
- **Codex:** o `rate_limits` do último rollout da VPS (5% / 2%, resets 1795123124 e 1795691872) é igual ao do `app-server`. Mac e VPS usam a mesma conta ChatGPT. O rollout mais novo do Mac era antigo (13:24, janela vencida), por isso a rota usa o `app-server`.
- **Tokens** (Claude VPS) contra o `/usage`: 24 h = 5.126 contra 5.127 requests e 162 contra 163 sessões; 7 d = 24.018 contra 23.654 (+1,5%), porque o início da janela é arredondado para a hora cheia.

## v30 (19/11): fila de turnos, processos controlados e resumo de mudanças em lote

### Fila global de turnos
- No máximo `BOTS_MAX_TURNS` (padrão 3) turnos pesados rodando ao mesmo tempo na VPS. Voz passa na frente e não espera; delegado tem prioridade sobre chat, chat sobre rotina. Turno parado num card de aprovação ou esperando um delegado libera a vaga e volta a ocupar quando continua.
- Quem excede recebe, no stream da conversa: `{"type":"turn.queued","data":{"turnId":"turn_3","position":2,"limit":3},"scope":{"turnId":"turn_3"}}` (reemitido quando a posição muda) e, ao começar, `{"type":"turn.dequeued","data":{"turnId":"turn_3"}}`. O app mostra "na fila · 2º" no lugar de "pensando…".
- `GET /status` passou a trazer também `turns {running, queued, max}`, `warmVoice` e `appWatching`.

### Processos
- Todo `claude` de turno e da camada rápida da voz sobe com `RUNELAY_TURN=rb<porta>:<id>` no ambiente, `nice 5` (voz 0), `ulimit -c 0` e `oom_score_adj 300`. Ao terminar ou cancelar, o servidor mata todos os processos com aquele marcador (filhos e netos). Uma varredura a cada 60 s mata marcados órfãos; na subida, também os `claude --input-format stream-json` com pai 1 (só dentro do container).
- Camada rápida da voz: no máximo `VOICE_MAX_WARM` (3) processos quentes, LRU; fecha sozinha após 5 min sem uso e reabre na próxima fala.
- Bash do modo código: testes (vitest, jest, `npm test`…) rodam um por vez na VPS inteira (`flock` em /tmp/runelay-bots-tests.lock, espera até 100 s e avisa), com `nice 10`, `timeout 20m`, `NODE_OPTIONS=--max-old-space-size=2048` e 2 workers; build/tsc/lint ganham o mesmo, sem a trava.
- Chrome do agent-browser fecha após 10 min sem uso (`BROWSER_IDLE_MS`); o print ao vivo durante o turno só roda se alguém olhou o navegador nos últimos 20 s.
- Polling de PR/CI: 30 s com CI rodando, 2 min aberto; sem o app conectado ao `/status/stream`, 4× mais lento.

### Container
- `docker-compose.yml`: `mem_limit`/`memswap_limit` 6g (`BOTS_MEM_LIMIT`), `cpus` 3 (`BOTS_CPUS`), `pids_limit` 4096, `ulimits core 0`.

## v39 (19/11): fila de jobs no Redis, `GET /jobs` e `POST /jobs/:id/retry`

O trabalho que precisa sobreviver a um reinício saiu da memória do processo e foi para uma fila no Redis (BullMQ, prefixo `runelay-bots`, duas filas):

- `turns`: um job `turn.run` por mensagem (`turn-<deliveryId>`), com prioridade delegado > chat > rotina. Concorrência = `BOTS_MAX_TURNS`, mais uma vaga para cada turno parado num card de aprovação ou esperando um delegado. Mensagens da mesma conversa rodam uma por vez e na ordem de chegada (lista `runelay-bots:turn-order:<sessionId>`). Voz não passa pela fila.
- `tasks`: `memory.capture` (captura de memória depois do turno, 4 tentativas), `export.render` (exportação, 3 tentativas), `upload.prepare` (transcrição e extração do anexo, 4 tentativas), `schedule.fire` (rotina) e `connectors.refresh` (lista de conexões do runelay a cada 5 min).

Comportamento:
- Uma mensagem aceita (`202`) já está gravada no Redis; se o servidor cai, ela roda quando ele volta. No desligamento normal (`SIGTERM`) o turno em andamento volta para a fila na hora; se o processo morre, volta em até ~30 s (job travado). O turno interrompido aparece fechado com `turn.settled {"outcome":"cancelled","reason":"server_restart"}` e roda de novo do começo com o mesmo `deliveryId`. Uma mensagem que já tem `delivery.settled {"outcome":"handled"}` não roda de novo.
- Rotinas viraram agendamentos repetíveis no Redis (`schedule.<botId>.<nome>`). Se o servidor estava fora na hora marcada, a rotina perdida roda uma vez assim que ele volta.
- Falha em todas as tentativas leva o job para a lista de falhos, que é o dead-letter: fica 30 dias e pode ser tentado de novo pela rota abaixo.
- `POST /bots/:id/exports` continua respondendo com o `ExportJob`: o servidor espera o job por até 90 s; se passar disso, volta `pending` e o app segue consultando como antes.

### Rotas

- `GET /status` passou a refletir a fila: `turns {running, queued, failed, max}` (rodando de fato, na fila incluindo os adiados, falhos) e `jobs {running, queued, failed, queues: {turns, tasks}}` com `{running, queued, delayed, failed}` por fila. `jobs` é `null` quando a fila não está ligada.
- `GET /jobs?status=failed|active|waiting|delayed|completed&queue=turns|tasks&page=1&pageSize=20` → 200 `{"items":[JobView],"page","pageSize","total"}`. Paginação e filtro no servidor; `status` padrão `failed`, `pageSize` até 100. Filtro inválido → 400 `{"ok":false,"error","field"}`.
- `JobView` = `{"id","queue","type","status","attempts","maxAttempts","ref":{"botId"?,"sessionId"?,"deliveryId"?,"exportId"?,"uploadId"?,"scheduleId"?},"createdAt","startedAt","finishedAt","error"}`. O payload do job não sai na rota; `ref` traz só os ids.
- `POST /jobs/:id/retry` → 202 `{"ok":true,"job":JobView}` com as tentativas zeradas. Job que não está nos falhos → 400; id desconhecido → 404.
- Sem Redis no boot o servidor não sobe. Com a fila desligada, `/jobs` responde 503 `{"ok":false,"error":"A fila não está ligada."}`.

### Para quem grava no banco

`enqueueInTx(tx, {type, payload, id?})` grava o job na tabela `job_outbox` dentro da mesma transação do Postgres; o relay (`startOutboxRelay(db)`) lê o outbox com `FOR UPDATE SKIP LOCKED`, publica no Redis com id `outbox-<id>` e marca `dispatched_at`. Tipo desconhecido é descartado com aviso; Redis fora deixa a linha para a próxima volta.

### Verificado

Instância separada (`:2100`, Postgres e Redis do compose em portas altas e volumes temporários, `BOTS_SCHEDULES=off` exceto no teste de rotina), bot com `claude-haiku-5-5`:

- Três mensagens na mesma conversa, `SIGKILL` com a terceira no meio: no boot `settled 1 turns left open by a restart`; o job travado voltou e a terceira concluiu 20 s depois, na ordem. Com `SIGTERM` e as três pendentes (uma rodando, duas adiadas), o turno ativo voltou para a fila na hora e as três concluíram 8 s depois do boot, na ordem.
- Exportação `md`, `docx` e `pdf` de uma nota pelos jobs `export.render`, todas `ready` na resposta do `POST`.
- Rotina `* * * * *`: servidor parado às 23:55:51, a das 23:56:00 rodou no boot (23:56:19) e a próxima ficou para 23:57:00.
- Retry: com o Chrome num caminho inexistente o PDF falhou 3 vezes e foi para os falhos; com o servidor de volta ao normal, o retry deixou a exportação `ready`.

`GET /status` com um job falho:
```json
{"bots":{},"turns":{"running":0,"queued":0,"failed":0,"max":2},"jobs":{"running":0,"queued":1,"failed":1,"queues":{"turns":{"running":0,"queued":0,"delayed":0,"failed":0},"tasks":{"running":0,"queued":0,"delayed":1,"failed":1}}},"warmVoice":0,"appWatching":false}
```

`GET /jobs?status=failed&page=1&pageSize=20`:
```json
{"items":[{"id":"export-exp_01m7v3s00eapf1eckzxh2d7afk","queue":"tasks","type":"export.render","status":"failed","attempts":3,"maxAttempts":3,"ref":{"botId":"fila","exportId":"exp_01m7v3s00eapf1eckzxh2d7afk"},"createdAt":"2026-11-19T23:55:22.610Z","startedAt":"2026-11-19T23:55:25.657Z","finishedAt":"2026-11-19T23:55:25.955Z","error":"ENOENT: no such file or directory, posix_spawn '/nao/existe/chrome'"}],"page":1,"pageSize":20,"total":1}
```

`POST /jobs/export-exp_01m7v3s00eapf1eckzxh2d7afk/retry`:
```json
{"ok":true,"job":{"id":"export-exp_01m7v3s00eapf1eckzxh2d7afk","queue":"tasks","type":"export.render","status":"active","attempts":0,"maxAttempts":3,"ref":{"botId":"fila","exportId":"exp_01m7v3s00eapf1eckzxh2d7afk"},"createdAt":"2026-11-19T23:55:22.610Z","startedAt":"2026-11-19T23:55:35.143Z","finishedAt":null,"error":null}}
```

O mesmo retry de novo: `400 {"ok":false,"error":"Só um job falho pode ser tentado de novo.","field":"id"}`. `GET /jobs?status=sumido`: `400 {"ok":false,"error":"status precisa ser active, waiting, delayed, failed, completed.","field":"status"}`.
