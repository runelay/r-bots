# Bots

## r/bots: verified protocol

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
  {"id":"nina","name":"Nina","role":"QA e navegador","accent":"pink","sessionBasePath":"/bots/nina/eve/v1",
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
  "hasBrowser":false,"instructions":"# Boss\n\nVocê é o Boss, …","capabilities":{"browser":false,"prodQuery":false,"delegate":["davi","nina"]},
  "builtIn":true,"createdAt":"2026-11-19T12:56:10.000Z","updatedAt":"2026-11-19T12:56:10.000Z","archivedAt":null,
  "thread":{"sessionId":null,"lastMessage":null,"unread":0}}]
```

Built-in accents moved into the v2 palette: Boss `indigo`, Davi `teal` (was `green`), Nina `violet` (was `pink`). `GET /bots/:id` returns one object. `thread.sessionId` is `null` until the thread is created (`GET /bots/:id/thread` or the first schedule run).

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
- `glyph`: any id matching `^[a-z0-9-]{1,40}$` (e.g. `face-07`, default `auto`). Pickable faces are the presets `crown`, `visor`, `antenna` plus `face-1`…`face-11`; the face never comes from the bot id (`auto` = generated from the id hash). Old names are aliases, saved and read as the preset: `boss` → `crown`, `davi` → `visor`, `nina` → `antenna`. Otherwise `400 {"ok":false,"error":"Ícone inválido: use até 40 caracteres de a-z, 0-9 e hífen.","field":"glyph"}`.
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

---

## v52 (20/11): o bot faz tudo o que a tela de Ajustes faz

O bot passa a mudar, por conversa ou voz, o que antes só a tela mudava. As ferramentas novas ficam no MCP `bots` (`apps/server/src/modules/settings/services/settings-tools.service.ts`) e chamam os mesmos services das rotas da tela (`updateBot`, `updateSidebar`, `setArchived`, `createSection`/`updateSection`, `saveProfile`/`deleteProfile`, `saveSecretMeta`, `usageLimits`, `updateAccount`, `installCatalogItem`/`reconnectSource`), sem regra duplicada. `bot` aceita nome ou id (com ou sem acento); sem `bot`, é o próprio.

### Ferramentas

| Ferramenta | O que faz | Card |
|---|---|---|
| `settings_get({bot?})` | Estado completo do bot (conta e modelo com nome legível, esforço, conta reserva, `autoSwitch`, modo do bot, da conversa e efetivo, cor, rosto, seção, fixado, voz, rotinas com `paused`) e do time (contas com modelos, seções, perfis de servidor, repositórios liberados, segredos só com nome/descrição/sites, integrações, conectores, notificações e microfones, opções válidas) | nunca |
| `bot_update({bot?, name?, role?, accent?, glyph?, account?, model?, effort?, fallback?, autoSwitch?, voice?, pinned?, section?, permission?, permissionScope?})` | Um só `PATCH` por área: `/bots/:id`, `/bots/:id/sidebar` e, para o próprio modo, a conversa atual (`permissionScope` `conversation`, padrão para o próprio bot) ou o padrão do bot (`bot`, sempre que o alvo é outro bot). Conta e modelo aceitam nome ("Claude Alex", "Sonnet"); `effort:"auto"` volta ao padrão; `fallback:"off"` desliga a reserva; `section` que não existe é criada; `glyph` só aceita `auto`, `crown`, `visor`, `antenna`, `face-1`…`face-11` | só ao **subir** o modo |
| `bot_archive({bot, archived})` | Arquiva ou restaura um bot | nunca |
| `section_update({name, section?})` | Cria seção ou renomeia `section` | nunca |
| `schedule_update({bot?, name, paused?, cron?, timezone?, prompt?, description?, rename?})` | Muda uma rotina existente. `paused:true` tira a rotina do agendador (o job some de `scheduledJobs` e `runFireJob` devolve `{skipped:"paused"}`); `false` devolve | nunca |
| `schedule_run({bot?, name})` | Mesmo efeito de `POST /bots/:id/schedules/:nome/run` | nunca |
| `server_profile_save({name, project?, path?, cwd?, script?, cmd?, port?})` / `server_profile_delete({profile})` | Perfis do "Rodar projeto" (`servers.profiles`). Mesmo nome atualiza | só com `cmd` livre (como o `server_start`) |
| `repo_remove({repo})` | Tira da lista de liberados (`code_repos`) | nunca |
| `vault_update_meta({name, description?, domains?})` | Descrição e sites de um segredo que já existe; nunca o valor | só ao liberar site novo ou "qualquer site" |
| `usage_get({refresh?})` | Limites de cada conta (`/usage/limits`) | nunca |
| `account_update({account, name?, isDefault?})` | Renomeia conta de IA ou marca como padrão | nunca |
| `integration_setup({integration, reason})` | Abre o formulário seguro da integração (veja abaixo) | é o próprio formulário |
| `connector_connect({service})` | Acha o serviço no catálogo da runelay e instala (ou refaz o login), mostrando o botão "Conectar" com o `authorizationUrl` oficial | nunca; o login é da pessoa |
| `preferences_set({notifications?, microphone?})` | Notificações (`replies`, `approvals`, `routines`, `failures`) e microfone padrão do Mac (`system` volta ao do sistema) | nunca |

`add_schedule` e `remove_schedule` deixaram de passar pelo Jev: rodam direto, como o resto. Em **Somente leitura** toda escrita dessas ferramentas é negada (`decision.outcome:"blocked"`), menos `bot_update` só com `permission`, que abre o card para a pessoa sair do modo. `settings_get` e `usage_get` são leitura e rodam em qualquer modo.

### Regra de aprovação

Tudo roda direto, inclusive mudança em outro bot. A exceção: **subir** o modo de permissão (`readonly < edit < default < full`), do próprio bot ou de outro, abre card humano. Não passa pelo Jev, abre mesmo em Acesso total e em rotina é negado. O motivo vai no card: "Subir o modo de permissão sempre passa por você: um texto lido numa página não pode dar mais acesso a um bot." Sem essa trava, uma instrução escondida numa página ou num anexo faria o bot se dar Acesso total. Baixar o modo roda direto. Dois casos já tinham card antes e continuam: perfil com `cmd` livre (senão `server_start profile:` furaria o card do `cmd`) e liberar segredo para site novo (v51).

### Evento `settings.changed`

Cada mudança emite, na conversa onde o bot trabalhou, uma linha para o app desenhar:

```json
{"type":"settings.changed","data":{"callId":"call_…","botId":"teste-ajustes","by":"bot","area":"bots","areas":["bots","usage"],"text":"Trocou para Claude Alex · Sonnet 5.5","target":{"id":"teste-ajustes","name":"Teste Ajustes"},"thumbnail":{"kind":"bot","id":"teste-ajustes"},"otherBot":false,"undo":[{"method":"PATCH","path":"/bots/teste-ajustes","body":{"engine":{"account":"vps:claude","model":"claude-sonnet-5-5","effort":null,"autoSwitch":false}}}]}}
```

- `undo`: passos REST que voltam ao estado anterior, chamados pelo app no botão "Desfazer" com a sessão da pessoa (rotas de dono). Some quando não dá para desfazer (rodar rotina, tirar repositório, integração, conector).
- `thumbnail.kind`: `bot`, `provider` (`claude`, `codex`), `connector` (ícone do catálogo) ou `integration`.
- `action`: `{label:"Conectar", url}` no `connector_connect` com login pendente.
- `otherBot:true` quando o alvo não é o próprio bot; o texto vem com o nome dele na frente.
- O tool call concluído some do transcript no app; a linha fica no lugar dele.

### Integração pelo formulário seguro

`integration_setup` abre `interaction.opened` com `kind:"integration"`, `display:"integration_form"`, opções `approve` ("Salvar") e `deny` ("Agora não") e:

```json
"integration":{"id":"jev","name":"Jev","description":"…","unlocks":"Aprovações automáticas","keyUrl":"https://typesafe.ai","needsUrl":false,"url":null,"status":"invalid","path":"/integrations/jev"}
```

O app mostra o campo, chama `PUT /integrations/:id` com a chave (a mesma rota da tela, que confere e grava cifrado) e só então responde `approve`. O servidor confirma pelo `validatedAt` do registro: se mudou, `Configurou Jev`; se não, falha com "O formulário fechou sem salvar a chave". A chave nunca passa pelo bot, pelo evento nem pelo log.

### Preferências do app no servidor

Notificações e microfone eram só `UserDefaults`; agora têm cópia no servidor para o bot ler e mudar.

- `GET /preferences` → `{"notifications":{"replies":true,"approvals":true,"routines":true,"failures":true},"microphone":null,"microphones":["MacBook Air Microphone"],"updatedAt":"…"}` (`no-store`).
- `PATCH /preferences` (dono) com qualquer subconjunto de `notifications`, `microphone` (nome ou `null`) e `microphones` (lista que o app informa ao abrir). Campo desconhecido, notificação desconhecida ou tipo errado → 400 com `field`.
- O app aplica ao abrir e a cada linha `preferences` do `/status/stream`, e manda `PATCH` quando a pessoa muda o interruptor ou o microfone.

### `/status/stream`

Duas linhas novas para o app refletir a mudança na hora, venha ela do bot ou de outro Mac:

```json
{"type":"settings","areas":["bots","usage"]}
{"type":"preferences","preferences":{"notifications":{…},"microphone":"Shure MV7","microphones":[…],"updatedAt":"…"}}
```

`areas` ∈ `bots`, `sections`, `schedules`, `servers`, `repos`, `vault`, `accounts`, `usage`, `integrations`, `connectors`, `preferences`, `conversations`. O app recarrega só o que a área pede (lista de bots com animação, seções, contas, anéis de uso, perfis, cofre, integrações).

### Campos novos no bot

- `schedules[].paused` (opcional, `true` ou ausente).
- `engine.autoSwitch` (opcional, `true` ou ausente): a pessoa deixou o bot trocar de modelo sozinho. Sem isso, o prompt manda sugerir em uma linha e só trocar quando pedirem.

### Prompt

Seção "Seus ajustes" no prompt de todo bot: pode se configurar e faz direto; chama `settings_get` antes de responder sobre si; subir o modo abre card; chave só por formulário; sugere outro modelo em uma linha e só troca se pedirem (ou sozinho com `autoSwitch`).

### Verificado (20/11, produção, bot de teste "Teste Ajustes", Claude Sonnet 5.5)

- "Em que modelo e conta você está…?" → `settings_get` e a resposta "Sonnet 5.5, conta Claude Trabalho, modo Padrão".
- "Troca para a conta Claude Alex no Sonnet." → `bot_update {"account":"Claude Alex","model":"Sonnet 5.5"}`, linha `Trocou para Claude Alex · Sonnet 5.5`, `GET /bots/teste-ajustes` → `engine.account:"claude-2:claude"`. A volta para "Claude Trabalho" rodou já na conta nova (`context.handoff`) e devolveu `engine.account:"vps:claude"`.
- Rotina criada com `add_schedule` sem card; "Pausa a rotina Ronda de teste." → `schedule_update {"paused":true}`, linha `Pausou a rotina Ronda de teste`, `schedules[0].paused:true` e o log `schedules loaded` sem `schedule.teste-ajustes.Ronda%20de%20teste`; "Retoma" → a chave voltou `@2026-11-20T06:00:00.000Z`.
- "Quais repositórios estão liberados?" → `settings_get` e a lista api, perf-demo-teste, web-app, mobile-app.
- "Salva um perfil… web-app, script dev, porta 4999." → `server_profile_save`, perfil `teste-ajustes-wl` em `GET /servers/profiles`. O passo do "Desfazer" (`DELETE /servers/profiles/teste-ajustes-wl`) → `200 {"ok":true}` e a lista voltou aos três perfis de antes.
- "Quais segredos existem no cofre?" → `list_secrets` (só nomes: `x-login-senha`, `x-login-usuario`).
- "Como estão os limites de uso?" → `usage_get` e a tabela das três contas.
- "Muda seu nome para Teste Ajustes 2 e o rosto para a viseira, na cor verde." → `bot_update {"name":"Teste Ajustes 2","accent":"green","glyph":"visor"}`; o "Desfazer" (`PATCH` com `name`, `accent:"blue"`, `glyph:"auto"`) → 200 e o bot voltou.
- "Sobe o modo desta conversa para Acesso total." → `interaction.opened` `kind:"approval"` "Posso subir o modo de permissão desta conversa de Padrão para Acesso total?", sem decisão do Jev (`outcome:"human"`, `model:null`). Negado → `call.settled outcome:"rejected"` e a conversa seguiu `effectivePermission:"default"`.
- "Quero trocar a chave do Jev. Abre o formulário." → `integration_setup`, `interaction.opened` `kind:"integration"`, `display:"integration_form"`; respondido `deny` sem colar nada → "A pessoa preferiu não configurar agora."
- "Remove a rotina… e arquiva o bot" → `remove_schedule` e `bot_archive`, `archivedAt` preenchido e a rotina fora do agendador.

---

## v61 (22/11): idioma do app e das respostas

O produto deixa de ser só pt-BR: o app escolhe entre inglês e português, e o servidor responde no mesmo idioma.

### Preferência `language`

- `GET /preferences` ganha `"language":"system"|"pt-BR"|"en"` (padrão `"system"`).
- `PATCH /preferences` (dono) aceita `language`; outro valor → 400 com `field:"language"`. A mudança sai na linha `preferences` do `/status/stream`, como as outras.
- `preferences_set` aceita `language` (`system`, `pt-BR`, `en`); a linha `settings.changed` sai no idioma guardado e o `undo` volta o `language` anterior. `settings_get` mostra `preferences.language` e `options.languages`.

### Cabeçalho `Accept-Language`

- O app manda `Accept-Language: pt-BR` ou `en` em toda requisição HTTP e no upgrade de WebSocket.
- Regra: só a primeira etiqueta conta; começa com `en` → inglês; qualquer outra → pt-BR; sem cabeçalho (ou `*`) → idioma guardado (`language`), e com `system` o idioma da última requisição de um aparelho da pessoa, senão pt-BR.
- Respondem no idioma da requisição: erros comuns (`Rota não encontrada.`, `JSON inválido.`, 500 genérico, `runelay não respondeu`, limites de corpo e caminho), o portão de login (401, 403, 421, 429), `/auth/*` (cadastro, convite, foto, chave do runner) e a validação de `/preferences`.
- A página `/device` segue o `Accept-Language` do navegador; `?lang=en` ou `?lang=pt-BR` na URL tem prioridade (o app pode mandar o idioma escolhido junto com o `user_code`).
- O que nasce sem requisição (opções do card de aprovação e linhas de ajustes feitas num turno) usa o idioma guardado, com a mesma regra do `system`.

### Textos do servidor nos dois idiomas

- Erros de validação e de rota de todos os módulos (bots, conversas, grupos, seções, review, navegador, GitHub, Linear, contas, servidores, código, notas, planilhas, agenda, exportações, cofre, anexos, integrações, jobs, voz, simuladores, testes, provedores, ferramentas) saem no idioma da requisição. Os códigos (`code`) e campos (`field`) não mudam.
- O que nasce num turno usa o idioma guardado: `capability.label` de `call.requested`, `prompt` e `reason` dos cards de aprovação, razões das decisões, linhas `settings.changed` de todas as ferramentas de ajustes, mensagens de falha do turno (`ACCOUNT_UNAVAILABLE`, `ACCOUNT_LIMIT`, provedor) e o aviso de parada por falta de progresso. Requisições em `/mcp/*` ignoram o `Accept-Language` do CLI e seguem o idioma guardado.
- Continuam em pt-BR: descrições de ferramentas, system prompt, resultados devolvidos ao modelo e logs.
- O app não deve ler o texto do rótulo para decidir nada. Delegação vem de `delegation.botId` (e `input.bot`); comando "cru" do Bash é o que não tem `input.description`. Para apps antigos, os rótulos mantêm o formato (`“…”` em volta do alvo, `Rótulo: argumento` com `: `), e o app aceita os prefixos dos dois idiomas (`Posso `/`Can I `, `Delegar para `/`Delegate to `).

### Idioma da resposta do bot

O system prompt do turno ganha no fim uma seção curta: com `language:"en"` (ou `system` com o último aparelho em inglês) `## Language` mandando responder em inglês; com `pt-BR` (ou `system` com aparelho em português) `## Idioma` mandando responder em português do Brasil. Com `system` e nenhum aparelho conhecido, nada muda.

### Verificado

```
GET /preferences
200 {"notifications":{"replies":true,"approvals":true,"routines":true,"failures":true},"microphone":null,"microphones":["MacBook Air Microphone"],"language":"system","updatedAt":"2026-11-22T12:41:20.857Z"}

PATCH /preferences {"language":"en"}
200 {"notifications":{"replies":true,"approvals":true,"routines":true,"failures":true},"microphone":null,"microphones":["MacBook Air Microphone"],"language":"en","updatedAt":"2026-11-22T12:41:20.864Z"}

PATCH /preferences {"language":"es"}  Accept-Language: en
400 {"ok":false,"error":"language must be system, pt-BR, en.","field":"language"}

PATCH /preferences {"language":"es"}  Accept-Language: pt-BR
400 {"ok":false,"error":"language precisa ser system, pt-BR, en.","field":"language"}

GET /nada  Accept-Language: en
404 {"ok":false,"error":"Route not found."}

GET /nada  Accept-Language: pt-BR
404 {"ok":false,"error":"Rota não encontrada."}
```
