# Servidores de desenvolvimento

Servidores que o runelay bots sobe para rodar os projetos liberados (web, API, app Expo): lista global, logs ao vivo, perfis salvos e ferramentas do bot. O `dev_server_*` do modo código (v19) continua por tarefa e entra na mesma lista.

## v48 (20/11): servidores, logs ao vivo, perfis e ferramentas do bot

### Modelo

Um servidor é um processo filho do servidor dos bots, numa porta livre a partir de `DEV_PORT_BASE` (5310), sempre em `127.0.0.1`/`::1`:

- `kind`: `workspace` (subido pelo `dev_server_start` numa tarefa de código) ou `project` (subido por esta API ou por `server_start`, num repositório liberado ou numa worktree dele).
- `tool`: `vite`, `wrangler`, `expo`, `next`, `astro`, `remix`, `nuxt`, `storybook`, `bun`, `deno`, `python`, `rust`, `go`, `node` ou `process`, lido do corpo do script do `package.json` (também quando o comando é `npm run <script> -- …`).
- `status`: `starting` → `running` (a porta respondeu) → `exited` (saiu sozinho, "caiu") ou `stopped` (parado por alguém). Parados somem da lista 10 min depois; os que caíram ficam até `DELETE`.
- Bind só local: o comando ganha `--port <porta>` e, por ferramenta, `--ip 127.0.0.1` (wrangler), `--hostname 127.0.0.1` (next) ou `--localhost` (expo). Se um servidor de projeto ainda assim abrir a porta em `0.0.0.0`/`::` (lido em `/proc/net/tcp{,6}`), o servidor dos bots para ele, marca `exited` e escreve o motivo no log.
- Variáveis: o `.env.local` e o `.env.development.local` da pasta (numa worktree, os do checkout principal valem por baixo) entram no ambiente do processo. A resposta traz só os nomes (`envKeys`). Valores de chaves com cara de segredo (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `DATABASE_URL`, `AUTH`…) viram `••••` no log. Numa worktree sem `.env`, `.env.local`, `.env.development.local` ou `.dev.vars`, o arquivo do checkout principal vira link simbólico, só se o git ignora esse caminho.
- Ambiente do processo de projeto: `FORCE_COLOR=1` (log com cores ANSI), `XDG_CONFIG_HOME=<home do host>/.config` (login do wrangler e de outras CLIs do host), sem `NAPI_RS_NATIVE_LIBRARY_PATH` (no container ele desvia todo binding napi-rs, inclusive o do rolldown/Vite).
- O registro fica em memória: reiniciar o container derruba os servidores.

### Objeto servidor

```json
{"id":"dev_1746d5aba5","workspaceId":"prj_38d0fd4a71","kind":"project","name":"conty-api","branch":"feat/overlays-compartilhaveis","path":"/home/<você>/projects/conty-dev/conty-api","cwd":"","command":"npm run dev -- --enable-containers=false --port 5311 --ip 127.0.0.1","tool":"wrangler","script":null,"profileId":"api-dev","startedBy":"user","botId":null,"sessionId":null,"envKeys":["CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CONTY","CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_MAGALU","CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_SPARK"],"port":5311,"url":"http://localhost:5311","previewPath":"/preview/prj_38d0fd4a71/5311/?t=<token>","status":"running","exitCode":null,"startedAt":"2026-11-20T03:40:28.113Z","endedAt":null}
```

`workspaceId` é o id da tarefa (`kind:"workspace"`) ou `prj_` + hash do caminho (`kind:"project"`). A prévia continua a da v19: `GET {previewPath}` grava o cookie `rb_preview` (HttpOnly, Secure, 12 h) e redireciona para `/`; daí em diante o tráfego fora das rotas da API vai para o servidor. Token errado ou servidor parado → `403`.

### Rotas

Todas exigem sessão ou chave (portão da v41).

| Rota | Resposta |
| --- | --- |
| `GET /servers` | `200 {"servers":[servidor…]}`, mais novo primeiro |
| `POST /servers` `{path?, cwd?, script?, cmd?, profile?, port?}` | `202 {"ok":true,"server":servidor}` com `status:"starting"`; o resto chega pelo `/status/stream` |
| `GET /servers/:id` | `200 servidor` |
| `POST /servers/:id/stop` | `200 {"ok":true,"server":servidor}` com `status:"stopped"` |
| `POST /servers/:id/restart` | `202 {"ok":true,"server":servidor}`: mesmo `id`, porta de antes se estiver livre, token de prévia novo |
| `DELETE /servers/:id` | `200 {"ok":true}`; `400` se ainda está rodando |
| `GET /servers/:id/logs?lines=500&query=` | `200 {"server":servidor,"lines":[…]}`: linhas cruas com ANSI, até 2000; `query` filtra sem diferenciar maiúsculas |
| `GET /servers/:id/logs/stream?lines=500` | NDJSON: `snapshot` `{server, lines}`, depois `lines` `{lines}`, `server` `{server, removed}` e `heartbeat` a cada 15 s |
| `GET /servers/projects` | `200 {"projects":[{name, path, worktrees:[{path, branch, main}]}]}`: repositórios liberados e as worktrees deles que ficam numa área liberada |
| `GET /servers/scripts?path=&cwd=` | `200 {name, path, repoPath, branch, cwd, manager, scripts:[{name, command, tool}], envFiles, envKeys}` |
| `GET /servers/profiles` | `200 {"profiles":[{id, name, path, cwd, script, cmd, port}]}` |
| `POST /servers/profiles` `{id?, name, path, cwd?, script? \| cmd?, port?}` | `200 {"ok":true,"profile":…}`; `id` sai do nome quando falta |
| `DELETE /servers/profiles/:id` | `200 {"ok":true}` ou `404` |

`POST /servers` precisa de `script` (do `package.json`, rodado com o gerenciador do lockfile: `npm run`, `pnpm run`, `yarn`, `bun run`), `cmd` ou `profile`. Erros de entrada voltam `400 {"ok":false,"error","field"}`; falha ao subir (sem porta livre, por exemplo) volta `400 {"ok":false,"error"}`. Perfis ficam na tabela `settings` (`servers.profiles`), nunca no código.

### `/status/stream`

O `snapshot` ganha `servers` (a mesma lista do `GET /servers`) e cada mudança de estado vira uma linha:

```json
{"type":"server","server":servidor,"removed":false}
```

`removed:true` quando o servidor saiu da lista (parado há mais de 10 min ou `DELETE`).

### Ferramentas do bot

Para todo bot, no MCP `bots`:

- `server_list {}`: servidores, projetos liberados (com as branches das worktrees) e perfis.
- `server_start {project?, branch?, script?, profile?, cmd?, cwd?, port?}`: sobe e espera responder. `script` e `profile` rodam direto; `cmd` livre abre card de aprovação. Na classe de permissão é `command` (como o `dev_server_start`).
- `server_logs {id, lines?, query?}`, `server_restart {id}`, `server_stop {id}`.

Todas emitem `call.*` como as outras ferramentas. `server_start`, `server_logs`, `server_restart` e `server_stop` também emitem:

```json
{"type":"server.card","data":{"serverId":"dev_…","botId":"engenheiro-de-software","server":servidor}}
```

O app mostra um card do servidor na conversa (um por servidor, id `server-<serverId>`), com o estado ao vivo vindo do `/status/stream`.

### App

- Inspetor › Atividade › **Servidores**: os servidores que não estão parados, com ícone da ferramenta, bolinha de estado (pulsa em "Subindo", anel único ao ficar "No ar", vermelha em "Caiu"), porta discreta e branch. Clique abre o painel; o menu traz Abrir no painel, Abrir no navegador, Copiar URL, Logs, Reiniciar/Rodar de novo, Parar/Tirar da lista.
- **Rodar projeto**: perfis salvos (um clique), ou repositório + worktree + script, com "Salvar como perfil". Mostra quantas variáveis do `.env.local` entram (os nomes no tooltip, nunca os valores).
- Painel dividido (o mesmo dos blocos e artefatos, `kind:"server"`, ⇧⌘F tela cheia): abas Prévia (WebView na URL de prévia) e Logs (busca, cores ANSI, segue o fim). O stream de log só fica aberto com o painel aberto.

### Limitações

- O cookie `rb_preview` é um por origem: abrir a prévia de outro servidor no mesmo navegador troca a prévia ativa.
- Caminhos que batem com rotas da API (`/auth`, `/health`, `/api`, `/bots`…) não chegam ao servidor na prévia; para uma API, use os logs ou `curl` no próprio servidor.
- O wrangler roda sem Docker no container: projetos com Containers do Cloudflare precisam de `--enable-containers=false` (o perfil `api dev` usa).
- Processos de dev que não foram subidos pelo runelay bots não aparecem.

### Verificado

Servidor de produção (imagem `servers-4`), repositórios reais, 20/11 03:40 UTC:

`POST /servers {"profile":"whitelabel-dev"}` e `{"profile":"api-dev"}` → `202`; comandos `npm run dev -- --port 5310` (vite) e `npm run dev -- --enable-containers=false --port 5311 --ip 127.0.0.1` (wrangler). `ss -ltn`: `[::1]:5310` e `127.0.0.1:5311`.

`GET /servers/scripts?path=…/conty-whitelabel`:

```json
{"name":"conty-whitelabel","path":"/home/<você>/projects/conty-dev/conty-whitelabel","repoPath":"/home/<você>/projects/conty-dev/conty-whitelabel","branch":"feat/desfazer-aprovacao","cwd":"","manager":"npm","scripts":[{"name":"dev","command":"vite","tool":"vite"},{"name":"build","command":"vite build && tsc --noEmit","tool":"vite"},{"name":"preview","command":"vite preview","tool":"vite"},{"name":"test","command":"vitest run","tool":"process"},{"name":"lint","command":"biome check","tool":"process"},{"name":"format","command":"biome check --write","tool":"process"},{"name":"deploy","command":"npm run build && wrangler deploy","tool":"wrangler"}],"envFiles":[".env.local"],"envKeys":["VITE_API_URL","VITE_TENANT_ID"]}
```

`GET /servers/profiles`:

```json
{"profiles":[{"id":"api-dev","cmd":"npm run dev -- --enable-containers=false","cwd":"","name":"api dev","path":"/home/<você>/projects/conty-dev/conty-api","port":null,"script":null},{"id":"whitelabel-dev","cmd":null,"cwd":"","name":"whitelabel dev","path":"/home/<você>/projects/conty-dev/conty-whitelabel","port":null,"script":"dev"}]}
```

`GET /servers/dev_1746d5aba5/logs?lines=3&query=Ready` → `{"server":{…},"lines":["\u001b[32m[wrangler:info]\u001b[39m Ready on \u001b[32mhttp://127.0.0.1:5311\u001b[39m"]}`

`GET /servers/dev_6fa22a0926/logs/stream?lines=2`, primeira linha:

```json
{"type":"snapshot","server":{"id":"dev_6fa22a0926","kind":"project","name":"conty-whitelabel","tool":"vite","port":5310,"status":"running","…":"…"},"lines":["  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5310\u001b[22m/\u001b[39m","\u001b[2m  \u001b[32m➜\u001b[39m  \u001b[1mNetwork\u001b[22m\u001b[2m: use \u001b[22m\u001b[1m--host\u001b[22m\u001b[2m to expose\u001b[22m"]}
```

Prévia pelo tailnet: `GET https://<vps>:10447{previewPath}` → `302` para `/` com `rb_preview`; `GET /` com o cookie → HTML do Vite (`/@vite/client`); token errado → `403`. API local: `GET http://127.0.0.1:5311/` → `404` do worker, com `--> GET / 404` no log.

Erros: `GET /servers/nope` → `400 {"ok":false,"error":"Esse servidor não existe mais.","field":"id"}`; `POST /servers {"path":"/etc","script":"dev"}` → `400 {"ok":false,"error":"Esse caminho não está num repositório liberado.","field":"project"}`.

Antes dos ajustes desta versão, os dois caíram e a lista mostrou `exited` com o motivo no log: o Vite com `TypeError: Class extends value undefined` (binding do rolldown desviado pelo `NAPI_RS_NATIVE_LIBRARY_PATH`) e o wrangler com `it's necessary to set a CLOUDFLARE_API_TOKEN` (login do host fora do `XDG_CONFIG_HOME`); a primeira subida do `api dev` abriu `*:5311` e foi parada à mão, o que levou ao `--ip` por ferramenta e à trava de exposição.

Bot (turno real, Engenheiro de Software, Claude): "use server_list … e server_logs …" → respondeu "Estão no ar o conty-api (wrangler, porta 5311, branch feat/overlays-compartilha…".

## v51 (20/11): servidores junto com o endurecimento de segurança

- `POST/PATCH/PUT/DELETE /servers/**` e `/accounts/**` só para o dono da conta (`403 {"ok":false,"code":"forbidden","error":"Só o dono da conta pode fazer isso."}` para membro). `GET` continua para todos.
- Comando com `--host 0.0.0.0`, `--host` sozinho, `-H 0.0.0.0`, `HOST=0.0.0.0` ou `::` é recusado antes de subir: "O servidor de desenvolvimento só pode ouvir em 127.0.0.1. Tire o --host 0.0.0.0 do comando." Vite e Astro ganham `--host 127.0.0.1`, Next `-H 127.0.0.1`, wrangler `--ip 127.0.0.1` quando o comando não diz o host.
- Servidor da tarefa (`dev_server_start`): roda no sandbox de uid quando `BOTS_TOOL_SANDBOX=uid`, no máximo `CODE_DEV_SERVER_MAX` (3) por tarefa, e para sozinho depois de `CODE_DEV_SERVER_MAX_MIN` (240) minutos. Servidor de projeto subido pelo bot (`server_start`) também para depois desse tempo; o subido pela pessoa no app não.
- Servidor de projeto roda como o usuário do servidor, fora do sandbox, com a configuração do host (v48). O navegador do bot (`browser_open`) alcança a porta de qualquer servidor de projeto no ar, além dos servidores das próprias tarefas.
- A prévia usa o cookie de uso único da v51 ([code](code.md)): o link `previewPath` vale uma vez; abrir de novo no mesmo navegador segue pelo cookie da sessão.

### Verificado

Por testes: `dev-server.test.ts` (casos de porta e host, limite por tarefa, vencimento, sandbox), `policy.test.ts`, `browser-guard.test.ts` (porta de servidor de projeto liberada).
