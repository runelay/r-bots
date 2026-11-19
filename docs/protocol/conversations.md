# Conversas, threads, sessões e handoff

## runelay bots: verified protocol

### Custom routes

#### `GET /bots/:id/sessions` → 200, newest first

```json
[{"sessionId":"wrun_01M7SW01SG47J8MDJJGP31M92Y","title":"Como está a produção?","startedAt":"2026-11-19T12:20:10.784Z","source":"chat"}]
```
Schedule runs add `"source":"schedule"` and `"scheduleId":"watch"`. Title is the first user message, at most 80 characters.

### eve session API (under `sessionBasePath`, e.g. `/bots/lia/eve/v1`)

#### Create a session with the first message

`POST {sessionBasePath}/session`
```json
{"message":"Abre https://example.com e me diz o título."}
```
→ `202`, header `x-eve-session-id`:
```json
{"ok":true,"sessionId":"wrun_01M7SVS11QFQ16PH7JZ5ASRMA7","deliveryId":"e9dc1213-0751-4a97-b7fe-8f233f958fb2"}
```
Without a body it creates a prewarmed session: same `202` and shape.

#### Send a follow-up message

`POST {sessionBasePath}/session/:sessionId`
```json
{"message":"Tenta de novo."}
```
→ `202`
```json
{"ok":true,"sessionId":"wrun_01M7SVS11QFQ16PH7JZ5ASRMA7","deliveryId":"73609329-1316-4753-a5d2-4b1a46173724"}
```
A message sent while a turn runs steers that turn (default `turnPolicy: "steer"`).

#### Cancel the running turn

`POST {sessionBasePath}/session/:sessionId/cancel` (optional body `{"turnId":"turn_0"}`) → `202 {"ok":true,"sessionId":"...","deliveryId":"..."}`.

#### Errors

- Unknown or ended session: `409 {"ok":false,"code":"session_not_active","error":"The session is no longer active."}`
- Unknown body field: `400 {"ok":false,"error":"Unknown field 'text'. Accepted fields: inbox, message, answers, clientContext, outputSchema, turnPolicy, callback, forwardedPrincipal, idempotencyKey."}`
- Bot process down: `502 {"ok":false,"error":"Lia está fora do ar.","detail":"..."}` (gateway)

## v2 (19/11): Claude Agent SDK engine

### Main thread per bot

Each bot has one continuous conversation. Talk to it like a messenger: get the thread, then use the normal session API on its `sessionId`.

#### `GET /bots/:id/thread` → 200 (creates the thread on first call)

```json
{"sessionId":"wrun_01M7SY2J60VK52GW9WJ5BM1BJV","lastMessage":{"role":"bot","text":"Não está \"tudo normal\". Vi três pontos, o primeiro é o mais sério: - **`trackin…","at":"2026-11-19T13:00:28.419Z"},"unread":2,"running":false}
```

`lastMessage` is `null` before the first message. `role` is `"user"` or `"bot"`; `text` is at most 80 characters. Schedule prompts do not change `lastMessage`; the bot reply they produce does. `unread` counts bot replies since the last `POST /bots/:id/thread/read`.

#### `POST /bots/:id/thread/read` → 200

```json
{"sessionId":"wrun_01M7SY2J60VK52GW9WJ5BM1BJV","lastMessage":{"role":"bot","text":"…","at":"2026-11-19T13:00:28.419Z"},"unread":0}
```

#### Sending

`POST /bots/davi/eve/v1/session/<thread sessionId>` with `{"message":"Quantas tabelas tem no schema public?"}` → `202 {"ok":true,"sessionId":"wrun_…","deliveryId":"…"}`. Stream it with `GET …/session/<thread sessionId>/stream?startIndex=N`. The thread `sessionId` never changes; the server keeps the SDK session behind it with `resume` and lets Claude Code compact long contexts.

#### `GET /bots/:id/sessions`

Main thread first (`"thread":true`, title `"Conversa principal"`), then other sessions created with `POST {sessionBasePath}/session`, newest first. eve sessions from v1 are not carried over.

```json
[{"sessionId":"wrun_01M7SY2J60VK52GW9WJ5BM1BJV","title":"Conversa principal","startedAt":"2026-11-19T12:56:30.145Z","source":"chat","thread":true}]
```

#### Other errors

- Unknown answer: `409 {"ok":false,"code":"interaction_not_pending","error":"Essa aprovação não está mais pendente."}`
- Unknown session, or a session of another bot: `409 {"ok":false,"code":"session_not_active","error":"The session is no longer active."}`

## v7 (19/11): sidebar preferences, sections, soft delete

### Thread unread

`POST /bots/:id/thread/unread` → `200 {"sessionId","lastMessage","unread","total"}` with `unread = max(1, current)`. `POST /bots/:id/thread/read` is unchanged.

## v17 (19/11): clear conversation

### `POST /bots/:id/thread/reset` → 200

Starts a new thread for the bot. The old one is archived on disk (`data/threads/archive/<botId>/<archiveId>.json` keeps its thread state; its session NDJSON stays in `data/sessions`, nothing is deleted).

```json
{"sessionId":"wrun_01M7T6CGEKFCES0TK7HP0WE28F","lastMessage":null,"unread":0,"total":1,"running":false,"archiveId":"tha_01M7T6CGEH1SKZDN8WCFNHVHWK"}
```
- New `sessionId`: the visible conversation is empty (only `session.started`) and the model context starts from zero (no provider session, no carry-over, no pending notes). Reopen the stream on the new `sessionId`.
- Routines and memory are untouched: schedules keep firing into the bot's (new) thread and the per-schedule reply summaries are copied over; runelay memories are not touched.
- `GET /bots/:id/sessions` lists only the current thread; archived threads don't show there.

### `POST /bots/:id/thread/restore {"archiveId":"tha_…"}` → 200

Undo: the archived thread becomes the bot's thread again (same `sessionId`, history, `lastMessage` and `unread` as before the reset) and its archive file is removed. If the thread being replaced already has messages, it is archived in turn and its id comes back as `archiveId`; otherwise `archiveId` is `null`.

```json
{"sessionId":"wrun_01M7T5FFDSBKRWK4283AG0AJWY","lastMessage":{"role":"bot","text":"Beleza, qualquer coisa é só chamar.","at":"2026-11-19T15:18:42.222Z"},"unread":0,"total":207,"running":false,"archiveId":null}
```
- Malformed `archiveId` → `400 {"field":"archiveId"}`. Unknown or already restored → `404 {"ok":false,"error":"Essa conversa arquivada não existe mais."}`.

### Turn in progress

Both routes answer `409 {"ok":false,"code":"turn_running","error":"O bot ainda está respondendo. Pare a resposta antes de limpar a conversa."}` while the thread has a turn running or a delivery queued (also during the gap between `POST …/session/:id` and `turn.started`). Nothing is cancelled for you: a running turn may be waiting on an approval or in the middle of a browser/computer action, and its late events would land in a thread the person no longer sees. Cancel it first (`POST …/session/:sessionId/cancel`) and retry.

### Mac

- `/limpar` in the composer's "/" menu, "Limpar conversa" in the bot's context menu (sidebar), and ⌘K with the conversation open.
- No confirmation: messages leave with a spring fade + slight rise (plain fade with Reduce Motion), and a "Conversa limpa · Desfazer" notice stays a few seconds. Desfazer calls restore. The sidebar preview follows the new thread.

### Verified 19/11

`teste-de-voz`: reset → new `sessionId`, `total` 1, `lastMessage` null, `/sessions` shows only the new thread. Restore with the returned id → original `sessionId`, `total` 207, last message back. Restoring the same id again → 404; `archiveId:"x"` → 400. The 409 path was not exercised live: `teste-de-voz` was soft-deleted during the check (sending gives `bot_deleted`) and the only active bots were Boss and Davi.

---

## v24 (19/11): delegação roda na conversa do bot delegado + status leve

### Servidor
- `delegate` não roda mais numa sessão escondida dentro da do Boss. O pedido vira uma entrega (`source: "delegate"`) na **thread principal** do delegado (`ensureThread`), com fila: se ele estiver no meio de um turno, espera a vez. Nunca roda dois turnos na mesma thread.
- Na thread do delegado: `delivery.admitted.source = {channel:"channel:delegate", botId, sessionId, callId}`, `turn.started.delegatedBy = <bot de origem>`, `delivery.consumed` com `source:"delegate"` e `from:{botId, name, sessionId, callId}`. Tool calls, texto, aprovações, `code.*` e workspace saem lá, como num turno normal (resume da sessão do próprio delegado). `lastMessage` da thread vira "Boss pediu: …" (role bot, sem unread).
- No Boss: o `call.requested` ganha `delegation:{botId}`; o progresso vem em `delegation.updated {callId, botId, sessionId, deliveryId, turnId?, status, summary?, error?}` com `status` = `starting|queued|working|awaiting|completed|failed|cancelled`. `call.settled.output` continua sendo a resposta final do delegado. Os passos internos não aparecem mais no Boss.
- Ciclo: delegar para quem já está esperando por você (direto ou em cadeia) falha na hora com erro claro, em vez de travar.
- Cancelar o turno do Boss **cancela o turno delegado** (tira da fila ou aborta, `turn.settled {outcome:"cancelled", reason:"Boss cancelou o pedido."}`), e o Boss recebe "Pedido cancelado.". Parar o delegado na conversa dele devolve "X parou antes de terminar." ao Boss.
- Formato velho (`owner.callId` + `origin.agent` no stream do Boss) continua sendo lido pelo app; nada migrado.
- Status: `GET /bots` → `thread.running` e `thread.status` (`working|awaiting|idle`). `GET /status` → `{bots:{id:status}}` (só não-idle). `GET /status/stream` (ndjson): `{"type":"snapshot","bots":{…}}`, depois `{"type":"status","botId","status"}` a cada mudança e heartbeat de 15 s. Grupos aparecem pelo id `grp_…`.

### App
- `status(for:)`/`mood(for:)` usam a conversa aberta; sem ela, o stream de status (fallback: `thread.running` do GET /bots). Um único stream para todos os bots; conversa só abre (`ensureThread`) para o bot que está recebendo uma delegação, para as aprovações dele notificarem.
- Boss: linha centralizada cinza, sem card: "[avatar] X está trabalhando…" → "Mensagem de [avatar] X" (clique abre a conversa dele), "X precisa de você" na cor de atenção quando há aprovação pendente lá. Várias delegações no mesmo turno: "N mensagens com [avatares] N bots", que expande uma linha por delegação. Sem texto do relatório: o Boss resume na bolha dele.
- Delegado: bolha "Boss pediu" com o personagem do Boss e o pedido em MarkdownView.

### Verificado 19/11
Bots de teste Chefe Teste → Ajudante Teste (apagados no fim). Ajudante `running:true` durante a tarefa, eventos na thread dele, Boss recebe "332". Fila: Ajudante ocupado → `queued` → `working` → `completed`. Aprovação (clique no navegador com autoaprovação desligada): `awaiting` no Chefe, card na conversa do Ajudante, respondido lá → `completed`. Cancelar o Chefe no meio: turno do Ajudante cancelado em ~2 s. Grupo com handoff Chefe → Ajudante sem mudança. `/status/stream` emitiu working/idle dos dois. Build no Mac + `make-app.sh` assinado "runelay bots Local". Sem print.

## v26 (19/11): handoff de contexto entre contas/modelos + conta reserva no limite

Pedido como "v25"; o número já tinha sido usado por outro agente no mesmo dia. Estudo do T3 Code em `research/t3-handoff.md`.

### Handoff (`apps/server/src/modules/conversations/services/handoff.service.ts`)
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
- **Ferramenta `thread_read({itemId, offset?})`** (MCP `bots`, para todos os bots e providers, `apps/server/src/modules/conversations/services/handoff-tools.service.ts`):
  - Devolve `{itemId, kind, role, turnId, at, totalChars, offset, text, nextOffset}` em pedaços de 4.000 caracteres, sem cortar par surrogate.
  - Id desconhecido devolve erro com os 20 ids mais recentes.
  - No transcript aparece como "Relendo a conversa", e o log guarda só tamanhos (sem duplicar o texto).

### App
- **Seletor de modelo:** linha nova "Se acabar o limite, usar" com menu das contas prontas e "Não trocar, só avisar". A explicação fica no tooltip. Trocar modelo ou esforço preserva a reserva.
- **Conversa:**
  - Divisor fino no estilo do T3 (`ContextHandoffDivider`): "⇄ <motivo> · logo modelo → logo modelo", centralizado entre linhas finas. A frase inteira fica no tooltip.
    - `context.handoff {from, fromModel, to, toModel}`: o servidor emite quando o turno entra com handoff numa conta ou modelo diferente do último (`meta.lastEngine`). Motivo: "Contexto passado".
    - `account.failover` acrescenta `fromModel`, `toModel` e o motivo "Limite do Claude".
    - `account.restored` acrescenta `from`, `fromModel`, `toModel` e o motivo "Limite liberado".
  - `ACCOUNT_LIMIT` vira aviso com o texto do servidor e o link "Continuar com Codex". O link grava a sugestão como reserva (`PATCH engine.fallback`) e reenvia o último pedido. Como o limite continua marcado, o reenvio já vai para a reserva.

### Verificado 19/11
Instância separada na :2200, imagem própria, sem rotinas, bot e repo descartáveis, tudo apagado no fim.
- **Troca no meio:** Claude Haiku abriu o repo, criou `notas.md` e rodou `echo $((17*23))` + `seq 1 600 … ; echo PALAVRA-FINAL-ZEBRA`. Trocado para Codex, respondeu sem rodar nada: 391, `notas.md` e ZEBRA. Depois leu um item omitido com `thread_read` (`offset 0 → nextOffset 4000`) e acertou "linha 541".
- **Failover:** a falha injetada no Claude ("resets in 1 minute") gerou "Limite do Claude acabou · continuei com Codex" e o Codex seguiu o mesmo turno. Passado 1 min, o Claude voltou com "Voltei para o Claude" e recebeu o delta dos turnos 2–4.
- **Sem reserva:** saiu `ACCOUNT_LIMIT` "O limite do Claude acabou, volta amanhã às 13:10. Quer que eu continue com o Codex?" com `suggest vps:codex`.
- **Resumo incremental:** na conversa real de 148 itens, 2 rodadas de ~7 s.
- **Armadilha que já existia:** no container, o Codex em modo código usa `-s workspace-write`, e o bwrap falha ("No permissions to create a new namespace"). Shell e patch do Codex não rodam na worktree. Como reserva em modo código, o Codex lê e conversa mas não edita até o container liberar userns (ou o modo código do Codex mudar de sandbox).

## v29 (19/11): várias conversas por bot + modo de permissão por conversa

Pedido como "v28"; o número já tinha sido usado (uso e limites). Código: `apps/server/src/modules/conversations/services/conversations.service.ts`, `apps/server/src/modules/approvals/services/permissions.service.ts`, ajustes em `apps/server/src/modules/engine/services/engine.service.ts`, `apps/server/src/modules/conversations/services/threads.service.ts`, `apps/server/src/app.ts`, `apps/server/src/modules/code/services/hooks.service.ts`, `apps/server/src/modules/code/services/policy.service.ts`, `apps/server/src/modules/engine/services/mcp-gateway.service.ts`, `apps/server/src/modules/bots/services/bots.service.ts`, `packages/providers/src/codex.ts`; app em `Models/Conversation.swift`, `Features/Conversation/Views/PermissionPill.swift`, `Features/Sidebar/SidebarView.swift` (árvore) e `Stores/AppModel.swift`.

### Conversas
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

### App
- Barra lateral: bot com 2+ conversas vira grupo: a linha do bot é só cabeçalho (avatar 24 pt, nome; hover: "+" e "⌄" para recolher, guardado em `sidebar.collapsedBots`; clique abre a conversa mais recente), sem prévia nem horário. Conversas abaixo, 30 pt, sem fundo de cartão (só a selecionada tem `Theme.selection`, hover `Theme.hover`), título em 1 linha alinhado ao nome do bot, tempo ou contador à direita; à esquerda, bolinha que pulsa (só enquanto trabalha), ponto de atenção, `</>` com repositório aberto ou nada; hover: Renomear e Arquivar. Linha-guia sai do centro do avatar e para na última conversa. Bot com 1 conversa = linha normal.
- "+"/⌘N abre um rascunho local (área vazia, caixa focada, "Nova conversa" no topo): nada vai ao servidor nem à barra lateral até o 1º envio, que faz `POST …/conversations {message}` e a conversa já nasce com título automático; sair do rascunho sem enviar descarta. Modo de permissão escolhido no rascunho vai no POST.
- Título automático vale também para a principal (1ª mensagem da pessoa; antiga sem título é preenchida pelo 1º `delivery.consumed` de chat do log). A principal agora pode ser renomeada. Recolhido, o bot soma as não lidas. Clique direito na conversa: Renomear (no lugar), Marcar como não lida, Mover para… (outro bot), Arquivar (com Desfazer). Ordem vem do servidor, nada reordena por atividade.
- `threads[botID]` continua sendo a conversa aberta do bot; as outras com store vivo ficam estacionadas (aprovação de conversa delegada notifica). Status do bot = maior entre a conversa aberta e o stream.
- ⌘N cria conversa no bot selecionado (antes focava o campo). ⇧⌘P alterna o modo da conversa. Pílula ao lado do seletor de modelo: ícone + nome; popover "Permissões" com os 4 ícones em segmentado, nome e descrição em pt-BR e "Usar como padrão de <bot>".

### Verificado 19/11 (instância 2110, dados descartáveis, repo + remoto bare locais, tudo apagado no fim)
- Duas conversas do mesmo bot, cada uma com a sua worktree: começaram juntas (20:02:29.34 e .36) e terminaram em ~5 s; `hello.ts` "um" e "dois" em worktrees diferentes; stream de status com `session` working/idle de cada uma.
- Delegação: Chefe Teste → duas conversas novas "Chefe Teste pediu: …" no delegado, com `delegatedBy`.
- Mesmo pedido (editar b.ts + commit + `push --force` da branch) nos 4 modos: Somente leitura não fez nada (e, forçado, `git status` rodou e `echo x > c.ts` foi negado pelo hook); Editar pediu card no `git add`, no `git commit` e no push; Padrão rodou direto e pediu card só no push forçado; Acesso total rodou tudo sem card. `git push --force origin HEAD:develop` no Acesso total → negado sem card (conferido também direto no gate, junto com Co-Authored-By e `--base main`).
- Renomear, ler, arquivar (principal recusada), listar arquivadas, mover para outro bot (a conversa movida continuou respondendo na worktree dela), padrão do bot refletindo em `effectivePermission`.
- `swift build -c release` no Mac e `make-app.sh`, assinatura "runelay bots Local". Sem print.

## v33 (19/11): conversas no SQLite e busca por texto

As conversas saíram dos `.json`/`.ndjson` e foram para o banco (`conversations` + `conversation_events`, uma linha por evento com `seq` a partir de 1). O contrato existente não muda: `GET …/eve/v1/session/:sid/stream` devolve as mesmas linhas, byte a byte, e `GET …/eve/v1/session/:sid/events?limit&before` continua paginando por índice (`index = seq - 1`), agora lido direto do banco por cursor, sem carregar a conversa inteira.

### `GET /bots/:id/conversations/search?q=…&limit=20&cursor=0` → 200

Busca nas mensagens (texto do usuário e respostas do bot) de todas as conversas do bot, com FTS5. Ignora acento e caixa ("producao" acha "produção"). `q` vai até 200 caracteres; `limit` até 50.

```json
{
  "hits": [
    {
      "botId": "qa",
      "sessionId": "wrun_01M7TY8AQPYW37RXP70GH4MASY",
      "index": 3,
      "at": "2026-11-19T22:18:53.565Z",
      "role": "user",
      "snippet": "Teste de [fumaça]: responda só com a palavra OK."
    }
  ],
  "nextCursor": null
}
```

- `index` é o mesmo índice do `events`: para abrir no ponto, peça `events?before=index+1`.
- `snippet` marca o termo encontrado entre `[` e `]`.
- `nextCursor` vai em `cursor` na próxima página; `null` quando acabou.
- Erro: `q` vazio ou longo demais → 400 `{ok:false, error, field:"q"}`.

### Verificado 19/11 (instância :2100, cópia dos dados de produção)

Conversa de 1.361 eventos: stream idêntico ao da produção (mesmo md5) e as 7 páginas de `events` somam 1.361. Busca por "conty-api", "producao" e "fumaça" devolve os trechos certos.
