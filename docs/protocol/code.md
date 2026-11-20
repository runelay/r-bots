# Modo código

## v19 (19/11): code mode (any bot codes in a task worktree)

Code belongs to the conversation, not to the bot. There is no `capabilities.code` and no toggle: any bot can open a repository at any time. Each conversation (session) gets its own git worktree and branch, so many bots can code in the same repo in parallel.

### Repositories

`GET /code/repos?query=&refresh=1` → 200, sorted by name. Since v34: the repositories the person allowed (`code_repos` in SQLite) that still have a `.git` directory. Cached 30 s.
```json
[{"name":"my-api","path":"/home/<seu-usuário>/projects/acme/my-api","location":"acme","branch":"feat/overlays-compartilhaveis"}]
```
A name can appear twice when two different clones exist (`conty-lp` under `conty-dev/` and `projects/`); resolution by name takes the first root (`conty-dev`).

### Opening a workspace

Three ways, same result:
1. **Tool** `workspace_open({repo, task})` (MCP `bots`, every bot, no approval). `repo` is a name (exact, case-insensitive, then loose match; ambiguous → the tool lists the options and the bot asks) or an absolute path.
2. **App**: `POST /bots/:id/code/workspace {"repo","task"?}` (`?sessionId=`, default = the bot's thread). `409` while a turn runs.
3. **Mention**: `@<repo-name>` in a chat message opens it before the turn starts (bot ids/names win over repo names).

What happens:
- `git fetch origin` (45 s, errors ignored), base = first of `origin/develop`, `origin/main`, `origin/master`, `develop`, `main`, `master`, `HEAD`.
- `git worktree add -b feat/<slug> ~/.local/share/runelay-bots-worktrees/<repo>/<repo>-<bot>-<slug> <baseCommit>` (fixed since v34; `~` is the host HOME). Slug from the task (≤ 40 chars); `-2`, `-3`… when the folder or branch exists.
- Dependencies: never a symlink. The lockfile decides (`bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `npm ci`), in the background, log in `data/code/<id>/install.log`. `dev_server_start` waits for it.
- The same repo again in the same conversation reuses the worktree (`reopened`).
- Mid-turn switch: when `workspace_open` succeeds, the server ends the current provider run itself (~300 ms after the tool result) and continues **the same turn** in a fresh provider session with cwd = worktree, a summary of the conversation and the original request. Leaving it to the model failed: it read "end your answer" and called `workspace_close`.
- Provider sessions are keyed `account@workspaceId` (Claude Code stores sessions per cwd).

`workspace_close()` (or `DELETE /bots/:id/code/workspace`) turns code mode off, stops the dev servers, keeps the worktree and branch, and clears the provider sessions so the next turn starts with a summary.

Events (no turn scope unless noted):
```json
{"type":"code.workspace","data":{"action":"opened|reopened|closed|failed","id":"conty-lp-dev-teste-botao-hero…","repo":"/…/conty-lp","repoName":"conty-lp","path":"/…/worktrees/conty-lp-dev-teste-botao-hero…","branch":"feat/botao-hero-black-friday-garantir-meu","base":"origin/develop","task":"…","active":true,"install":{…}}}
{"type":"code.install","data":{"workspaceId":"…","status":"running|done|failed|skipped","manager":"npm","command":"npm ci --no-audit --no-fund","durationMs":9097,"error?":"…"}}
```

### Turns in code mode

- **Claude (VPS)**: the SDK runs with `tools: ["Read","Edit","MultiEdit","Write","Glob","Grep","Bash","TodoWrite"]`, `cwd` = worktree, `permissionMode: "default"`, `mcp__bots` still allowed. Every native call goes through a `PreToolUse` hook (gate, up to 900 s for a person) and `PostToolUse`/`PostToolUseFailure` (settle + diff). Claude Code 2.1 has no `MultiEdit`; the name is passed and ignored.
- **Codex (VPS)**: `-s workspace-write -C <worktree>`, shell on. No per-call gate is possible (no hook); the sandbox blocks network and writes outside the worktree, so `git add`/`commit` fail there (the worktree's gitdir lives in the main repo). Commands and file changes show as `call.*` with ids `ext_<item>`, and edits arrive at the end of the turn (sweep).
- **Cursor, Grok, any `mac:*` account**: no code tools; the system prompt tells the bot to ask the person to pick a Claude or Codex model of the VPS.
- Delegated bots do not get code mode in v19.
- Every bot's system prompt has a "## Código" section (repo list, `workspace_open`, ask when the repo is not obvious, commit/push/PR only through `workspace_deliver` when the person asks). With a workspace open, "## Repositório aberto" adds path, branch, base, install status, running dev servers and the rules.

Native calls render like any tool, with `capability.surface:"code"`, `callId` = the SDK `toolu_…`, and pt-BR labels (`Ler x.tsx`, `Editar x.tsx`, `Criar x.ts`, `Procurar “…”`, Bash uses its `description` or `Rodar <cmd>`). `input` is trimmed (Write → `{file_path, lines}`, Edit strings ≤ 2 k, paths relative to the worktree); `output` too (Bash stdout tail 4 k / stderr 2 k).

### Diffs: `code.edit`

After each Edit/Write (hook) and at the end of every turn (sweep of files changed by Bash, codegen or Codex), one event per file:
```json
{"type":"code.edit","data":{"callId":"toolu_…|null","workspaceId":"…","path":"src/components/lp/black-friday/black-friday-hero-cta.tsx","absPath":"/…","outside":false,
 "before":"…full text or null…","after":"…","hunks":[{"oldStart":11,"oldLines":7,"newStart":11,"newLines":7,"lines":[" import …","-  pt: { label: \"Aproveite a Black\" },","+  pt: { label: \"Garantir meu desconto\" },"," …"]}],
 "added":2,"removed":2,"created":false,"deleted":false,"source":"tool|sweep"},"scope":{"turnId":"turn_1"}}
```
Hunks come from `git diff --no-index -U3` on the server. `before`/`after` are `null` above 200 kB (then no context expansion). The sweep skips files already reported with the same content in the turn.

### Changes panel routes (`?sessionId=` optional, default thread)

- `GET /bots/:id/code` → `{workspace:{…, files, added, removed}|null, files:[{path,status,added,removed,binary}], servers:[…], checkpoints:[{turnId,at,workspaceId}], running}`. Changes are against the task's `baseCommit` (committed + uncommitted + untracked), so they survive an approved commit.
- `GET /bots/:id/code/files` (`?fresh=1`).
- `GET /bots/:id/code/diff?path=` → `{path,status,added,removed,binary,hunks,patch,before,after}`; without `path` → `{files:[{…,hunks}], patch}` ("Ver tudo").
- `POST /bots/:id/code/revert {"path"}` → restores the file from `baseCommit` (or deletes it when it did not exist); emits `code.reverted {path, by:"user"}`.
- `GET /bots/:id` and `GET /bots` carry `"code":{"repoName","branch","path","files","added","removed","running"}|null` (cached 3 s) for the sidebar badge. `hasBrowser` is true while the bot codes.

### Approval: one order for every code action

hard rules (deny or person) → remembered grant for this repo → automatic read/dev → Jev → person.

- **Parse, not regex.** `apps/server/src/modules/code/services/policy.service.ts` has its own conservative shell parser: quotes, `&&`, `||`, `;`, `|`, newlines, `$( )`, backticks, `<( )`, `${ }`, redirections (`>`, `>>`, `2>`, `&>`, `<<<`), heredocs (body is data), subshell parentheses. Each segment is judged with the `cd` cwd carried along; `bash -c '…'` is parsed recursively; `find -exec` and `xargs` judge the inner command. Unbalanced quotes/parens, a missing heredoc end or a stray `&` → **person** (fail-closed). A command name built at runtime (`$CMD`, `$(…)`) → person. Anything piped into `sh/bash/node/python…` without a script → person (`git status && curl … | sh` is caught).
- **Hard rules (person, never remembered):** `git push`, `git commit`, rebase/merge/reset --hard/clean -f/branch -D/tag/remote changes/worktree add|remove, `gh pr create|merge` and other GitHub writes, `sudo`, deploys (`wrangler deploy|secret|… --remote`, vercel/netlify/fly/…, any `deploy` script), Supabase remote/linked/push, migrations to prod, DB clients (`psql`…), package publish, `ssh/scp/nc…`, system commands (`kill`, `systemctl`, `apt`…), writes or `rm` outside the worktree (and `/tmp`), reading secret files (`.env*`, `.ssh`, `*.pw`, credentials…), editing outside the worktree.
- **Protected paths (denied outright, even inside the worktree):** anything under `.git/` (hooks, config), `.claude/`, `.grok/`, `.cursor/*hooks|permissions|mcp.json`, `.env*` / `.dev.vars`, `data`, `.env.local`, `~/.claude*`, `~/.codex`, `~/.ssh`, `~/.config/systemd`. `git config` writes are denied too. `call.settled.error.code` is `TOOL_POLICY`.
- **Automatic:** Read/Glob/Grep inside the worktree or under `~/projects` (not secrets), Edit/Write inside the worktree, TodoWrite, and Bash made only of read/dev commands (git status/diff/log/add…, ls/cat/rg/sed/find…, npm/pnpm/bun run/test/build, npx vitest/tsc/biome, node/tsx, curl to localhost, rm/mv/cp inside the worktree). `&` at the end is denied with "use dev_server_start".
- **Soft (rememberable):** unknown programs (→ Jev first), `curl` to an outside host, `npm i <pkg>`, reads outside `~/projects`. The card then has a third option `{"id":"approve_always","label":"Sempre neste repositório"}` and `request.grant` = `"curl example.com em conty-lp"`. Answering `approve_always` stores the grant key in `data/code/grants.json` (per repo path); next time `decision.made` has `outcome:"granted"` and `call.started.clearedBy = {"grant":"curl example.com"}`. `GET /code/grants`, `DELETE /code/grants {"repo","key"}`.
- Batch: several open approvals are answered with one `answers` array (already supported); the app shows "Permitir todos / Agora não para todos".
- Schedule turns deny anything that needs a person.

### Dev servers and testing in the browser

Tools (only while a workspace is open): `dev_server_start({cmd, port?, cwd?})`, `dev_server_stop({port?})`, `dev_server_logs({port?, lines?})`.
- `cmd` goes through the same command gate. Runs `bash -lc` detached (own process group) in the worktree, `PORT`/`HOST=127.0.0.1`, free port from `DEV_PORT_BASE` (5310). `{port}` in `cmd` is replaced; otherwise `npm run x` gets `-- --port N` and vite/next/astro/wrangler/pnpm/bun get `--port N`. Waits until the port answers (127.0.0.1 or ::1, 120 s) and returns `url` (`http://localhost:N`) and the last 25 log lines. Log in `data/code/<id>/dev/<port>.log`, 400-line ring in memory.
- The bot tests with its own browser (`browser_open` on that url, `browser_screenshot`, clicks); the app's live view shows it.
- Events: `code.devserver {action:"started"|"exited"|"stopped", id, port, url, command, previewPath, status}`. `GET /bots/:id/code/servers`, `POST /bots/:id/code/servers/stop {port?}`. Servers stop on workspace close, rewind and server shutdown.

**Preview on the Mac** (authenticated gateway proxy): `GET /preview/<workspaceId>/<port>/?t=<token>` (token per server, in `previewPath`) sets the `rb_preview` cookie (HttpOnly, Secure, 12 h) and redirects to `/`. From then on, any path that is not an API prefix (`bots`, `code`, `meta`, `mcp`…) is proxied to that dev server, including WebSocket upgrades (Vite HMR). Without the cookie those paths stay 404. Apps whose own routes collide with an API prefix (e.g. `/bots`) won't preview there.

### Checkpoints and undo (files + conversation together)

- At the start of every turn with an open workspace (and when one opens mid-turn) the server snapshots the worktree into a hidden ref `refs/runelay/checkpoints/<sessionId>/<turnId>` (temporary index, `git add -A`, `write-tree`, `commit-tree` on HEAD; respects `.gitignore`). Event `code.checkpoint {turnId, ref, commit, workspaceId}`.
- `POST /bots/:id/code/rewind {"turnId":"turn_1"}` → `409` while busy. Restores the worktree files to that turn's checkpoint (or the first later one), deletes files created after it, resets the index, stops dev servers, marks that turn and every later one as reverted (`meta.revertedTurns`), drops provider sessions so the model forgets them, and emits:
```json
{"type":"turn.reverted","data":{"turnId":"turn_1","turnIds":["turn_1","turn_2"],"files":true,"restored":864,"removed":0,"checkpoint":"refs/runelay/checkpoints/wrun_…/turn_1"}}
```
- Commits approved in a reverted turn stay in the branch (the files are restored, HEAD is not moved): the working tree then shows the reverse change.
- Clients hide entries whose `turnId` is reverted. `recentExchanges` (summaries) skips them too.

### Deliver (separate from close)

`workspace_deliver({action:"commit"|"pr", message, title?, body?})` — always a hard person card ("Fazer commit de 1 arquivo na branch feat/x? Mensagem: “…”"). Same from the app: `POST /bots/:id/code/deliver {action, message}` (the click is the request; the app confirms first). Rules in code: conventional commit message, no AI signature (`Co-Authored-By`, `Generated with`). `commit` = `git add -A` + `git commit` with the repo's git identity; `pr` = commit + `git push -u origin <branch>` + `gh pr create --base <develop|main>`. Event `code.delivered {action, commit, prUrl, files, branch, base}`.

### Registry and cleanup

`data/code/worktrees.json` (`GET /code/worktrees`): `{id, path, repo, repoName, branch, base, baseCommit, botId, sessionId, createdAt, lastAccessedAt, status: alive|closed|delivered|stale|removed, pinned, prUrl}`. A collector runs 1 min after start and every 6 h: worktrees not active in any session, not pinned, untouched for `CODE_WORKTREE_TTL_DAYS` (14) and clean (no uncommitted changes, no unpushed commits) are removed with `git worktree remove` (never `--force`; the branch stays). Dirty ones become `stale` and stay.

### App (Mac)

- "+" in the composer: "Trabalhar num repositório…" (searchable list from `/code/repos`), "Ver mudanças" when open; `/repo` in the "/" menu; `@repo` in the text.
- Top of the conversation: one quiet line `repo · branch · N arquivos +a −r` (spinner while installing) that opens the Changes panel.
- Diff card per `code.edit`: file name strong, folder grey, `+N −M`, mono lines with one number gutter, removed lines on a subtle red, added on a subtle green, context runs collapsed into "⋯ N linhas" (expand on click, also before/after hunks from `after`), light regex highlight for ts/tsx/js, swift, sql, css, json, py, sh. Cards over 40 rows show "Mostrar tudo".
- Changes panel (modal): file list with `+/−` and status, full diff of the selected file, "Ver tudo", "Desfazer arquivo" (confirm), "Abrir no editor" (Zed CLI `zed ssh://<host><path>`, else VS Code Remote URL, else copies the path; host in `UserDefaults codeEditorHost`, empty by default, which only copies the path), "Abrir o app no Safari" (preview link), "Entregar" (commit / commit e PR), "Voltar para antes de um pedido" (rewind), "Fechar o repositório".
- Right click on a user message: "Desfazer este pedido (arquivos e conversa)".
- Sidebar: small `</> N` badge on bots whose thread has a workspace open (blue while working).
- Approval cards gain "Sempre neste repo"; two or more open approvals show "Permitir todos / Agora não para todos" above the composer.

### Verified 19/11 (separate instance on :2100, scratch data, schedules off, disposable repo)

Disposable repo: a snapshot of conty-lp re-initialized as a new repo in `worktrees/sandbox`, with `origin` pointing to a bare repo next to it (nothing could reach the real repo).
1. First try: the bot opened the workspace and then called `workspace_close` because the tool told it to "end the answer". Fixed with the server-side run switch above.
2. Second try (Sonnet 5.5, one message): `workspace_open` → `reopened` → checkpoint → Grep → Read → Bash `sed -i` (text + `bg-[color-mix(in_oklab,var(--bf-yellow)_88%,black)]`) → `dev_server_start` (`npm run dev -- --port {port}`, port 5610, after `npm ci` of 9 s) → `browser_open http://localhost:5610/pt` → screenshot → reply. `code.edit` (sweep, 2 hunks, +2 −2). `GET /code`, `/code/diff`, `GET /bots` badge and the preview proxy (302 + cookie, HTML and `/@vite/client` 200, 404 without cookie) checked with curl.
3. "faça o commit…": the bot used `workspace_deliver`, the hard card appeared, approved → commit `a48d818` in the sandbox, no push.
4. Rewind `turn_1`: text back to the original, turns 1–2 marked reverted, dev server stopped, checkpoints hidden.
5. `curl -sI https://example.com`: card with "Sempre neste repositório" → `approve_always` → second run `granted`, no card.
6. Policy unit run over 40 commands (pipes into sh, `$(rm -rf ~)`, heredocs, `cd .. && rm -rf`, protected `.git/hooks`, `git config`, `wrangler deploy`, `npm i lodash`, `find / -exec rm`…).
The test bot was deleted, the instance stopped and the sandbox removed. Not run live: Codex in code mode, MultiEdit, Vite HMR over the preview WebSocket, the worktree collector (no worktree is 14 days old), PR delivery (needs a real remote).

### v19.1 (19/11): diff ao vivo e painel novo

- **Causa do "sem mudanças":** edição por Bash (`sed -i`, `python3 <<EOF`) só virava `code.edit` na varredura do fim do turno, e o app só relia `/code` ao chegar um `code.*` ou `turn.settled`. Num turno longo (tsc rodando) o app ficava com a foto de antes das edições, e o selo da barra lateral usava essa foto.
- **Servidor (`apps/server/src/modules/code/services/live-diff.service.ts`):** depois de cada Edit/Write/MultiEdit/Bash (hook) e de cada comando/edição do Codex, roda `git diff --numstat` + untracked na worktree (≈25 ms no conty-api) e emite, para cada arquivo que mudou desde a última varredura, `code.edit` **acumulado do turno** (`before` = conteúdo no início do turno) com `cumulative:true` e `key:"<turnId>:<path>"`. Mudou o total → `code.status {workspaceId, files, added, removed}`. O fim do turno é só mais uma varredura (`source:"sweep"`). Edição fora da worktree continua com o `code.edit` antigo (sem `key`).
- **App:** `code.edit` com `key` substitui o card daquele arquivo no turno e o leva para o fim (um card por arquivo, diff acumulado; hunks vazios = card some). `code.status` atualiza a contagem na hora. Grupo de passos rodando mostra o passo atual em linguagem humana ("Checando tipos", "Rodando os testes", "Editando x.ts"), traduzido do comando no app (`CommandPhrase`).
- **Pílula do topo:** vidro (Capsule), ícone de branch, repo, "13 · +118 −34"; branch no tooltip; spinner + brilho passando enquanto o bot trabalha. Clique abre o popover; o botão redondo ± abre o visualizador.
- **Popover (300 pt):** repo + copiar caminho + abrir no editor (Zed/VS Code); branch (copiar); Commit ⌄ (mensagem, Commit / Commit e PR, com confirmação); Mudanças +a −r → visualizador; Safari quando há dev server; Histórico (pedido, tempo relativo, relógio ↶ no hover com confirmação); "Fechar o repositório".
- **Visualizador:** lista estreita (nome + ±, caminho no tooltip) e diff ocupando o resto; "Abrir no editor" e "Desfazer arquivo" como ícones no cabeçalho do arquivo. O ↗ de um card abre o visualizador naquele arquivo.

- **Diff em blocos (19/11, 2ª rodada):** cada hunk é um card (Theme.surface) com cabeçalho "linhas a–b" e a seção da função quando o git dá (`hunks[].section`, texto depois do `@@`). Linhas ± com barra de 3 pt, fundo 16 %, sinal em negrito e diff de palavras no par removida→adicionada (LCS por token, desligado quando mais de 70 % da linha mudou). Entre blocos: "⋯ N linhas ocultas" numa linha, clicável. Lista de arquivos com 240 pt, só o nome e ±, caminho no tooltip; entradas +0 −0 somem e binário mostra "binário".
- **Popover (versão final, 19/11):** padding horizontal único (Spacing.m), linhas de 30 pt e cursor de mão em tudo que é clicável. O popover tem: repo + copiar caminho + editor (só os instalados: `dev.zed.Zed` com logo `zedindustries` do Simple Icons, `com.microsoft.VSCode` com o ícone do app, porque `visualstudiocode` dá 404 no Simple Icons) + "Copiar caminho"; linha da branch que copia; "Mudanças +a −r" → visualizador; Histórico; "Fechar o repositório". **Sem bloco de commit:** o usuário não usa, o commit é do bot via `workspace_deliver`, com o card. A rota `commit-message` foi removida. Histórico: `checkpoints[].request` = texto do pedido, "Boss pediu: …" (delegação), "Rotina: …", "Áudio de 0:26" / "Imagem" / nome do arquivo (anexo sem texto), ou `null`, e o app esconde o item. Clique no item = voltar para antes dele (com confirmação), ↶ aparece no hover. O botão ± ao lado da pílula e o selo `</> N` da barra lateral saíram.

Verificado 19/11 em instância separada (:2100) com bot e sandbox descartáveis: Edit e `sed -i` viraram card na hora; contagem 0 → 1 durante um `sleep 25` no meio do turno; duas edições do mesmo arquivo viraram um card acumulado (+2 −2). Build no Mac + `make-app.sh` assinado "runelay bots Local".

## v25 (19/11): autonomia no código e nos conectores, skills garantidas no prompt, microfone

### Política (invertida em 19/11, pedido da pessoa: "odeio esse bot me pedindo permissão para tudo")
- No modo código e no git o padrão é não pedir nada. Rodam direto, sem card e sem Jev: editar a worktree, Bash, testes, build, dev server, instalar dependência, rede, criar branch, commit (inclusive `--amend`), merge/rebase na branch da tarefa, push da branch da tarefa, `gh pr create/edit/comment`, `workspace_deliver` (commit, push, pr).
- Card só na lista dura (`apps/server/src/modules/code/services/policy.service.ts`): `git push --force`/`-f`/`--force-with-lease`/`--delete`/`+ref`; push para main/master/develop (inclusive `HEAD:main`) ou merge/rebase/pull quando a branch atual é uma delas; `gh pr merge` e merge pela API; `gh release`; deploy (wrangler deploy, vercel, fly, terraform…); migration com prod, `supabase --linked/--remote`, `psql` fora de localhost; `rm`/escrita fora da worktree e de /tmp; `curl -X/-d` para hosts de mensagem ou pagamento (Slack, WhatsApp, Telegram, Twilio, SendGrid, Resend, Mailgun, Postmark, Discord, Asaas, Stripe); sudo, ssh, docker que para ou apaga, systemctl, secret files.
- Negado sem card: `git config` de escrita, commit/PR com `Co-Authored-By`/`Generated with`. PR para a main é permitido (19/11): a base é a que a pessoa pedir ou a mais próxima entre origin/main e origin/develop.
- Conectores (`classifyTool` em `apps/server/src/modules/connectors/services/runelay.service.ts`): leitura e escrita comum (criar/atualizar issue, documento, label, comentário interno do Linear) rodam direto, sem Jev. Card para o que casa com send, email, mail, message, reply, chat, notify, sms, whatsapp, tweet, dm, invite, slack, refund, charge, payment, payout, pay, transfer, deploy, publish, merge, delete, purge, drop, truncate, migrate, e para ferramentas sql/query com SQL de escrita nos argumentos.
- Uma negação não vale para o próximo pedido. O prompt do bot diz: "Você tem autonomia: não peça permissão para commit, push, PR, testes, build, instalar dependência ou tarefas no Linear… Se a pessoa pedir push, dê push; se já houver PR, o push atualiza o PR. Nunca diga que não pode dar push ou abrir PR."
- `apps/server/src/modules/approvals/services/delivery-intent.service.ts` continua só para orientar o prompt: quando a mensagem (ou a skill anexada, ou a cadeia de delegação) pede commit/push/PR, o turno ganha a nota "faça direto" com as regras de commit por módulo.
- Verificado 19/11 (instância 2100, repositório e remoto bare descartáveis): commit por módulo + push + `gh pr create --base develop` sem nenhum card (o `gh` falhou só porque o remoto não é GitHub); `git push --force origin feat/...` → card "Push forçado sempre passa por você."; PR com "Generated with" negado e refeito sem a linha.

### `workspace_deliver {action: "commit"|"push"|"pr", message?}`
- `push`: commit do que estiver pendente (mensagem obrigatória só se houver pendência) + `git push -u origin <branch>`. Se a branch já tem PR aberto (`gh pr view`), o resultado diz que o PR foi atualizado.
- `pr`: igual ao push e abre PR só quando não existe um aberto; senão devolve o existente (`prExisted:true`). "Só push" nunca vira PR novo.
- `POST /bots/:id/code/deliver` aceita `push`.
- Instrução do bot: commits por módulo no Bash (`git add <arquivos>` + `git commit -m`), `workspace_deliver` só para o resto, para o push ou para o PR; "se a pessoa pedir push, dê push; se já houver PR, o push atualiza o PR; nunca diga que não pode dar push".

## v27 (19/11): PR e CI do modo código + mensagem com card aberto

Pedido como "v26"; o número já estava em uso (handoff de contas), então ficou v27.

### Associação e polling (`apps/server/src/modules/code/services/pull-request.service.ts`)

- O PR fica em `session.meta.workspace.pr` (também sai em `publicWorkspace`, `GET /bots/:id/code` → `workspace.pr` e em `GET /bots` → `code.pr {number, status, ci}`).
- Descoberta: depois de `workspace_deliver` (rota ou ferramenta) o `prUrl` vai direto para `kickPr`; PR aberto pelo bot com `gh pr create` no Bash é achado no polling por `gh pr list --head <branch> --state all` assim que a branch tem upstream ou `refs/remotes/origin/<branch>`.
- Polling: um laço a cada 10 s olha as worktrees ativas; leitura com `gh pr view <n> --json number,title,state,isDraft,mergedAt,closedAt,baseRefName,headRefName,additions,deletions,files,statusCheckRollup,reviewDecision,url,updatedAt`. Intervalo: 20 s com CI rodando, 60 s aberto ou sem PR, 10 min fechado/mergeado (mergeado não relê, só confere o fechamento automático). `CODE_GH_BIN` troca o binário (teste com `gh` falso; o `childEnv` põe `/usr/bin` antes do PATH).
- Checks: `CheckRun` e `StatusContext`; vale o mais recente por `workflow/nome`. `status` = `pending|success|failure|skipped|neutral`, `durationMs` de `startedAt`/`completedAt` (o `0001-01-01` do GitHub vira `null`). `ci` = `failure` se algum falhou, `pending` se algum roda, `success`, ou `none`.
- Arquivos em categorias: **generated** (lockfiles, `dist/ build/ out/ .next/ generated/`, `*.gen.*`, `*.generated.*`, `*.min.js`, `*.snap`, `migrations/meta/`, `*_snapshot.json`, `_journal.json`), **tests** (`*.test.*`, `*.spec.*`, `__tests__/ _tests_/ test(s)/ e2e/ __mocks__/ fixtures/`), **docs** (`*.md`, `*.mdx`, `docs/`, README/CHANGELOG/LICENSE), **code** o resto.

### Eventos (sem escopo de turno)

```json
{"type":"code.pr","data":{"workspaceId","repoName","number":1207,"title","url","status":"open|draft|merged|closed","base":"develop","head":"feat/x","additions","deletions","files":17,
 "categories":{"code":{"files","added","removed"},"tests":{…},"generated":{…},"docs":{…}},"checks":[{"name","workflow","status","startedAt","completedAt","durationMs","url"}],
 "ci":"none|pending|success|failure","review":"approved|changes_requested|review_required|null","mergedAt","closedAt","updatedAt","fetchedAt"}}
{"type":"code.ci","data":{"workspaceId","number","prUrl","outcome":"failure","check":{…},"failed":[{"name","url"}],"log":"…até 4 kB…"}}
{"type":"code.ci","data":{"workspaceId","number","prUrl","outcome":"success","checks":6}}
{"type":"code.review","data":{"workspaceId","number","prUrl","state":"changes_requested","author","body","comments":[{"path","line","body"}]}}
{"type":"code.review","data":{"workspaceId","number","prUrl","state":"approved"}}
{"type":"code.workspace","data":{"action":"removed","by":"user|auto",…workspace,"pr":{"number","status","url"}|null}}
```
- `code.pr` só quando algo muda (ignora `fetchedAt`). `code.ci failure` quando aparece check falho novo (nome + URL do job; re-run tem URL nova); `success` quando vem de `pending` ou `failure`. Reinício do servidor não repete: o estado anterior fica salvo.
- Log resumido: `gh run view --job <id> --log-failed`, sem ANSI/timestamp, sem `✓`, corta no "Post job cleanup", começa no bloco "Failed Tests"/`FAIL`/`error` (senão as últimas 45 linhas), `##[error]` vira "Erro: ".
- Review com mudanças: `gh pr view --json reviews` (o último CHANGES_REQUESTED) + `gh api repos/{owner}/{repo}/pulls/<n>/comments` (até 8 comentários de linha, sem respostas).

### Rotas (`?sessionId=` opcional)

- `GET /bots/:id/code/pr` (`?refresh=1` relê no GitHub) → `{pr}`.
- `POST /bots/:id/code/finish` → fecha o repositório e roda `git worktree remove` (nunca `--force`). `409` com mudança não commitada ("Tem mudança não commitada na worktree…"), commit que não foi para o GitHub ("Tem 1 commit que não foi para o GitHub.") ou bot trabalhando. A branch fica. Registro `status: removed`.
- `POST /bots/:id/code/pr/reopen` → `gh pr reopen` (só PR fechado; o clique da pessoa é o pedido, o app confirma).
- Fechamento automático: PR mergeado há `CODE_PR_AUTOCLOSE_HOURS` (24) sem mudança pendente e sem commit fora do GitHub → `finish` com `by:"auto"`.

### App

- Pílula: depois de "16 · +128 −37" vem `#1207` com ponto de CI (verde passou, amarelo rodando, vermelho falhou). Mergeado: cápsula roxa "Mergeado ✓ #1207" (`Theme.merged`). Fechado: "Fechado #1207" em vermelho.
- Popover: linha do PR (ícone por status, título curto, ponto de CI, `#n`) logo abaixo da branch. Hover (450 ms) ou clique abre o cartão: status com cor e ícone, título, `base ← head`, "N arquivos +a −r" e Código/Testes/Gerado/Docs com ±, lista de checks (ícone, nome, duração, clique abre o log), review (Aprovado / Mudanças pedidas / Aguardando review), "Abrir no GitHub ↗". Mergeado: "Fechar o repositório" em roxo. Fechado: "Reabrir" e "Fechar o repositório". O "Fechar o repositório" do fim do popover vira `finish` (com confirmação) quando o PR está mergeado ou fechado; erro do servidor aparece em vermelho no popover. Abrir o popover relê o PR.
- Conversa: "CI falhou · Tests (1/3) · Ver log ↗ · Pedir para corrigir" (o botão manda "O CI do PR #n falhou em X. Corrige." + log resumido em bloco de código; vira "Pedido enviado"); "CI passou ✓"; "Review pediu mudanças · autor" com até 4 linhas do resumo e "Pedir para corrigir"; "Review aprovado ✓"; "PR #1207 mergeado · repositório fechado".
- Notificação do macOS em `code.ci failure` ao vivo ("CI falhou · PR #n", corpo "bot · check"), na preferência "Turnos com erro", só quando a conversa não está na tela.

### Verificado 19/11

- Parser contra o PR real #1207 (só leitura: `gh pr view`, `gh run view --log-failed`): 16 arquivos = Código 8 (+100 −32), Testes 7 (+25 −4), Docs 1 (+3 −1); checks Lint 33 s, Typecheck 2 min 15 s, Tests (1/3) falhou em 10 min 6 s; log resumido começa em "Failed Tests 1" com o `AssertionError` de `settle-delivery-without-review.test.ts:399`. Em produção o PR foi achado sozinho pela branch da worktree.
- Instância separada (:2130, dados descartáveis, `gh` falso, repo descartável com remoto bare local): aberto+CI rodando → falhou (`code.ci` com log) → passou (`CI passou`) → mudanças pedidas (resumo + comentário de linha) → fechado → reabrir → mergeado → `finish` recusou arquivo sujo e commit não enviado, removeu a worktree limpa (branch ficou) → fechamento automático com o prazo encurtado: worktree suja ficou, limpa saiu (`by:"auto"`).
- Turno real (Sonnet): `git push` pediu card, mensagem enviada com o card aberto → card "withdrawn", uma resposta só, no `turn_0`, sem turno novo.

## v30 (19/11): fila de turnos, processos controlados e resumo de mudanças em lote

### Mudanças em lote
- Quando uma varredura acha mais de `CODE_LIVE_BULK_LIMIT` (25) arquivos mudados, sai um só `code.bulk` no lugar dos `code.edit`: `{"callId":"…","workspaceId":"…","files":616,"added":14109,"removed":31960,"paths":["…12 primeiros"],"source":"tool","key":"turn_4:bulk:toolu_…"}`. O app mostra uma linha "616 arquivos mudaram de uma vez" com atalho para o visualizador.

## v34 (19/11): repositórios liberados, sem configuração

Nada de variável para repositório. O compose monta o HOME do host no mesmo caminho dentro do container (worktrees guardam caminho absoluto) e passa `HOST_HOME`; o limite de segurança é a lista de repositórios liberados, guardada no SQLite (tabela `code_repos`: `path`, `name`, `reason`, `added_by`, `added_at`). Saíram `CODE_REPO_ROOTS`, `CODE_WORKTREES_DIR` e `PROJECTS_DIR`.

### `workspace_add`
- Ferramenta de todo bot: `workspace_add {path, reason}`. `path` absoluto ou `~/…` (HOME do host). Precisa ter uma pasta `.git`; caminho protegido é negado.
- Sempre card humano (`call.requested` → card → `call.started` com `clearedBy.interactionId`). Não passa pelo Jev, ignora o modo de permissão (inclusive Acesso total) e numa rotina é negado ("Ninguém está aqui para aprovar…"). Repositório já liberado responde sem card.
- Aprovado: grava na lista e responde "Liberado: <nome> (<caminho>). Abra com workspace_open usando "<nome>"." O prompt pede ao bot para gravar com `memory_write` o que o repositório é (o que faz, stack, quando usar); isso é memória da runelay, não configuração.

### O que checa a lista
- `workspace_open`, menção `@repo` e `GET /code/repos` só enxergam repositórios liberados. Fora da lista: "<caminho> não está na lista de repositórios liberados. Peça para liberar com workspace_add(path, reason)." Lista vazia: "Nenhum repositório liberado ainda…".
- Portão do modo código (Read, Glob, Grep, Edit, Write e Bash): caminho dentro do HOME (do host ou do container) e fora de repositório liberado, da worktree da tarefa, da pasta de worktrees ou de `/tmp` é negado sem card ("… fica fora dos repositórios liberados…"). No Bash vale para `cd` (inclusive `cd` sem argumento), argumentos que começam com `/`, `~` ou `..` e alvos de escrita. Os dados do servidor (`/data`, `~/.local/share/runelay-bots`, backups, `/run/runelay-bots`) e as credenciais (`.claude`, `.claude.json`, `.codex`, `.config/gh`, `.supabase`, `.ssh`, `.config/runelay-bots`) ficam sempre protegidos.
- `send_file` aceita a pasta de dados, os repositórios liberados, a pasta de worktrees, worktrees já registradas, `/home/runelaybot` e `/tmp`.

### Migração
- No boot, `seedAllowedRepos()` grava na lista (sem duplicar) todo repositório que já tem worktree em `code_workspaces`, então nada para. Log: `allowed repos: <n>`.
- Worktrees antigas continuam onde estão (o caminho absoluto existe dentro do container pelo HOME montado).

### Consulta em produção
- Saíram `prod_query`, `capabilities.prodQuery`, `CONTY_API_DIR` e `request_capability {name:"prodQuery"}` (agora só `browser`). Campo `prodQuery` vindo do app é ignorado.
- Consulta em banco vai pelo conector (ex.: Supabase) com `connector_call`. Ferramenta com `sql`/`query` no nome e argumento `query`/`sql`/`statement`: uma única instrução `SELECT`/`WITH`/`EXPLAIN SELECT` sem efeito colateral é leitura e roda direto; qualquer outra coisa é "outbound". Escrita que toca banco (`sql`, `query`, `migration`, `postgres`, `supabase.`, `database` no nome) sempre pede card, em qualquer modo menos Somente leitura (que nega). Qual projeto é produção fica na memória.

### Instalação
`git clone` + `docker compose up -d`. Sem `.env`: dados em `~/.local/share/runelay-bots`, backups em `~/.local/share/runelay-bots-backups`, segredos gerados em `<dados>/secrets` (desde a v43, sem `.env.local`), chave do cofre em `<dados>/vault.key` (copiada de `~/.config/runelay-bots/vault.key` se existir, senão criada com modo 600 quando ainda não há segredo), HOME do desktop virtual no volume `desktop-home`. A imagem roda como `app` 1000:1000; o entrypoint lê o dono do HOME montado (ou de `/data`), ajusta o uid/gid do `app` se for outro, faz `chown` só do HOME interno e baixa o privilégio com `setpriv`. Garage roda como 1000:1000 e o `storage-secrets` faz `chown` só da pasta dele; o `storage-init` grava as chaves do Garage em `<dados>/secrets` (v43).

