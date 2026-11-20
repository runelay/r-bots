# Protocolo do runelay bots

Contrato verificado entre o servidor do runelay bots (gateway em `127.0.0.1:2000`, exposto no tailnet em `:10447`) e o app do Mac: rotas REST, API de sessão no formato do eve, stream NDJSON de eventos, WebSockets (navegador, desktop, runner) e as ferramentas que os bots recebem. Cada corpo foi capturado do servidor rodando. O texto cresceu por versão (v1 a v39, de 19 e 20/11) e aqui está separado por assunto; dentro de cada arquivo as seções seguem a ordem em que foram escritas, com o título da versão de origem. Por isso a numeração às vezes sai fora de ordem (v8.1 depois da v11, v14 antes da v13, v20 antes da v19, v24 antes da v23). Até a v20 o texto está em inglês; da v21 em diante, em português.

## Arquivos

- [overview.md](overview.md): base, URLs, desvios do contrato, endpoint MCP do gateway e notas gerais.
- [bots.md](bots.md): bots como dados (`/bots`, `/meta`), criação, autoconfiguração, barra lateral e exclusão.
- [conversations.md](conversations.md): API de sessão, thread principal, sessões, limpar conversa, delegação, handoff de contexto e várias conversas por bot.
- [events.md](events.md): formato do stream, tipos de evento, regras de renderização, turnos capturados e histórico paginado.
- [approvals.md](approvals.md): responder aprovação, Jev (camada de decisão), aprovações legíveis, mensagem com card aberto e modos de permissão.
- [code.md](code.md): modo código (worktree, política de comandos, diffs ao vivo, dev server, checkpoints, entrega, PR e CI, mudanças em lote).
- [voice.md](voice.md): chamada de voz com ElevenLabs e escolha de microfone.
- [artifacts.md](artifacts.md): artefatos HTML e canvas editável.
- [uploads.md](uploads.md): anexos nos dois sentidos (upload, envio, o que o modelo recebe, anydoc).
- [vault.md](vault.md): cofre de segredos (Keychain, regras, resolução, máscara, rotas).
- [accounts.md](accounts.md): contas conectadas, motor do bot, runners (VPS e Mac) e conta reserva.
- [computer.md](computer.md): navegador do bot, navegador ao vivo, computador virtual e uso do Mac da pessoa.
- [memory-skills.md](memory-skills.md): memória inteligente e skills no composer.
- [connectors.md](connectors.md): conectores via runelay, catálogo e instalação.
- [schedules-groups-sections.md](schedules-groups-sections.md): rotinas na thread, seções e grupos.
- [blocks.md](blocks.md): blocos do bot (notas, planilhas, agenda), eventos `block.*`, rotas, ferramentas e exportação.
- [usage-status-limits.md](usage-status-limits.md): uso e limites do Claude e do Codex, fila global de turnos, processos e limites do container.
- [integrations.md](integrations.md): ElevenLabs, Jev e runelay configurados pelo app (chave cifrada, validação, fallback sem cada uma) e tokens internos gerados no primeiro boot.
- [auth.md](auth.md): autenticação (better-auth): primeiro dono, convites, login por senha e Touch ID, chaves de API do runner e rotas livres.
- [servers.md](servers.md): servidores de desenvolvimento dos projetos liberados (lista, logs ao vivo, perfis, prévia) e as ferramentas `server_*` do bot.

## Versão → arquivo

| Versão | Assunto | Arquivo(s) |
| --- | --- | --- |
| v1 (sem número, "runelay bots: verified protocol") | base eve | [overview](overview.md) (desvios, base), [bots](bots.md) (`GET /bots`), [conversations](conversations.md) (sessões, API de sessão, erros), [events](events.md) (stream, renderização), [approvals](approvals.md) (responder aprovação), [computer](computer.md) (rotas do navegador) |
| v2 | motor Claude Agent SDK | [overview](overview.md) (introdução), [events](events.md) (diferenças, turnos capturados), [conversations](conversations.md) (thread principal, sessões, erros), [bots](bots.md) (bots como dados), [schedules-groups-sections](schedules-groups-sections.md) (rotinas na thread) |
| v3 | proxy com contas conectadas | [accounts](accounts.md) (contas, motor, runners), [events](events.md) (diferenças, histórico paginado), [overview](overview.md) (endpoint MCP), [computer](computer.md) (navegador ao vivo, comportamento) |
| v4 | navegador ao vivo e operável | [computer](computer.md) |
| v5 | Jev | [approvals](approvals.md) |
| v6, v6.1 | bots se configuram | [bots](bots.md) |
| v7 | barra lateral, seções, exclusão | [bots](bots.md) (preferências, exclusão), [schedules-groups-sections](schedules-groups-sections.md) (seções), [conversations](conversations.md) (não lida) |
| v8 | conectores via runelay | [connectors](connectors.md) |
| v8.1 | memória inteligente | [memory-skills](memory-skills.md) |
| v9 | grupos | [schedules-groups-sections](schedules-groups-sections.md) |
| v10 | sem mudança no servidor | [overview](overview.md) |
| v11 | computador virtual | [computer](computer.md) |
| v12 | uso do Mac da pessoa | [computer](computer.md) |
| v13 | voz | [voice](voice.md) |
| v14 | catálogo de conectores | [connectors](connectors.md) |
| v15 | aprovações legíveis | [approvals](approvals.md) |
| v16 | skills no composer | [memory-skills](memory-skills.md) |
| v17 | limpar conversa | [conversations](conversations.md) |
| v18 | artefatos HTML | [artifacts](artifacts.md) |
| v19 | modo código | [code](code.md); "Layout and look" e o "Verified" do canvas, que estavam dentro da v19, foram para [artifacts](artifacts.md), junto da v20 |
| v19.1 | diff ao vivo e painel novo | [code](code.md) |
| v20 | canvas | [artifacts](artifacts.md) |
| v21 | runner do Mac no app | [accounts](accounts.md) |
| v22 | anexos | [uploads](uploads.md) |
| v23 | cofre de segredos | [vault](vault.md) |
| v24 | delegação na conversa do delegado + status leve (`/status`) | [conversations](conversations.md) |
| v25 | autonomia, skills no prompt, microfone | [code](code.md) (política, `workspace_deliver`), [memory-skills](memory-skills.md) (skills anexadas), [voice](voice.md) (microfone) |
| v26 | handoff + conta reserva | [conversations](conversations.md) (handoff, app, verificado), [accounts](accounts.md) (conta reserva) |
| v27 | PR e CI + mensagem com card aberto | [code](code.md) (PR e CI), [approvals](approvals.md) (mensagem com card aberto) |
| v28 | uso e limites | [usage-status-limits](usage-status-limits.md) |
| v29 | várias conversas + modo de permissão | [conversations](conversations.md) (conversas, app, verificado), [approvals](approvals.md) (modo de permissão) |
| v30 | fila de turnos, processos, mudanças em lote | [usage-status-limits](usage-status-limits.md) (fila, processos, container), [code](code.md) (mudanças em lote) |
| v31 | blocos: notas, planilhas, agenda e exportação (contrato antes do servidor) | [blocks](blocks.md) |
| v32 | autenticação: contas, sessões, passkey, chaves de API, primeiro dono e convites | [auth](auth.md) |
| v33 | conversas no SQLite, busca por texto (FTS5) | [conversations](conversations.md) |
| v34 | repositórios liberados (`workspace_add`), sem `prod_query`, instalação sem variáveis | [code](code.md) |
| v35 | integrações pelo app (sem `.env.local`), `GET /meta.integrations`, tokens internos no `data/` | [integrations](integrations.md) |
| v36 | primeiro acesso pelo app, portão automático quando existe dono, `RUNNER_TOKEN` com o portão ligado, troca de senha | [auth](auth.md) |
| v37 | foto da conta: `PUT/DELETE /auth/me/avatar`, `GET /auth/avatars/:userId/:arquivo`, `user.image` no `/auth/me` | [auth](auth.md) |
| v38 | dispositivos (`POST/GET/DELETE /devices`), o Mac chama o servidor, proxy MCP pela conexão, contas por Mac, sem `MAC_RUNNER_URL`/`PUBLIC_MCP_BASE`/`RUNNER_TOKEN` | [accounts](accounts.md) |
| v39 | fila de jobs no Redis (turnos, rotinas, exportações, captura, anexos), `GET /jobs`, `POST /jobs/:id/retry`, `/status` da fila | [usage-status-limits](usage-status-limits.md) |
| v40 | banco no Postgres; busca de conversas e notas com `tsvector` + `unaccent` (mesmas rotas e corpos) | [conversations](conversations.md) |
| v41 | login obrigatório: portão sempre ligado, `BOTS_AUTH=off` só em teste, app sem modo sem conta | [auth](auth.md) |
| v42 | tela de login dividida, `GET /auth/providers`, login social pela página `/device`, `rememberMe` | [auth](auth.md) |
| v43 | origem pela requisição (sem `BETTER_AUTH_URL`), senha de 8 caracteres, chaves do Garage em `<dados>/secrets`, servidor sem `.env.local` | [auth](auth.md) |
| v44 | `agenda_list` mostra o bloco de Agenda (`silent`), `calendarUrl` e link de vídeo do texto no evento, prompt manda agenda/nota/planilha para o bloco nativo | [blocks](blocks.md) |
| v45 | desligar a chamada por voz (`call.hangup`, `action:"hangup"`), agradecimento sem ack duplicado, fuso da pessoa no prompt (`X-Timezone`) | [voice](voice.md) |
| v46 | agenda no fuso da pessoa (`user.timezone`), sem `-03:00` fixo | [blocks](blocks.md) |
| v47 | contas de IA por diretório no servidor (`~/.claude*`, `~/.codex*`), sem contas de modelo do Mac, `PATCH/DELETE /accounts/:id`, `POST /accounts/dirs`, `GET /accounts/login-guide`, uso e limites por conta (`account`), failover outra Claude → reserva também com a conta fora do ar | [accounts](accounts.md), [usage-status-limits](usage-status-limits.md) |
| v48 | servidores de desenvolvimento: `GET/POST /servers`, stop/restart/logs (NDJSON ao vivo), `/servers/projects`, `/servers/scripts`, perfis em `/servers/profiles`, linhas `server` no `/status/stream`, ferramentas `server_*` e evento `server.card` | [servers](servers.md) |
| v49 | perguntas estruturadas: ferramenta `ask_user`, `interaction.opened` com `kind:"question"`, resposta por `answers[].questions` ou `optionId:"skip"`, `summary` no `interaction.settled`, perguntas na chamada de voz (`question.asked`, `action:"question"/"answered"`) | [approvals](approvals.md) |
| v50 | terminal para todo bot Claude da VPS (pasta `.bots/<botId>`, chave `<conta>@home`), leitura de produção por `supabase db query --read-only` sem card, lista dura de produção com card também em Acesso total, `add_schedule` sem "Pede aprovação", `wrangler` na imagem | [code](code.md) |

## Contrato

O contrato original entre o backend e o app do Mac está em [CONTRACT.md](CONTRACT.md).
