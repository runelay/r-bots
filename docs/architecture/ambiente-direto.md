# Ambiente direto: o bot trabalha como o dono

Proposta (22/11/2026). Substitui as caixas de [ambientes.md](ambientes.md).

## Problema

O r/bots é self-hosted e tem um dono só. Mesmo assim, todo turno de código passa por quatro camadas pensadas para isolar gente de fora: a caixa `rbbox-*`, o usuário `runelaytool` com `rb-sandbox-exec`, as roots do runner e as montagens de login. A caixa precisa replicar à mão o que a máquina já tem, e cada camada quebrou alguma coisa na v0.1.15:

- push e PR (`/usr/bin/gh` no `.gitconfig`, #37);
- `git` na caixa (sem o `.git` principal), `gh`/`supabase`/`wrangler` sem login, a trava de testes e o `/tmp` dividido entre dois usuários (#39);
- caminho relativo do `test_playwright` (#41).

Quando uma ferramenta falha, o modelo improvisa (conector, Mac, `md5sum`) em vez de parar. O dono quer usar o r/bots como usa o T3 Code: o agente na máquina, como ele, com as ferramentas dele.

## Proposta

- Os bots rodam **direto na máquina, como o dono**: o mesmo usuário, o mesmo home, os mesmos `git`, `gh`, `supabase`, `wrangler`, Node e Docker do host.
- Dois lugares de execução, escolhidos no menu do servidor que o app já tem: **VPS** (padrão) e **Este Mac** (Xcode, simulador, iPhone). Bots, conversas e memória ficam sempre no servidor da VPS; o Mac não roda servidor nem Postgres/Redis, só o runner dentro do app.
- De qualquer lugar, o bot continua alcançando o Mac pelas ferramentas de aparelho que já existem (`shell_run`, computador, simulador, Maestro).
- A caixa sai: primeiro desligada, depois apagada.

O que não muda: worktree por tarefa, `workspace_deliver`, cards da lista dura (deploy, escrita em prod, dinheiro, mensagem para fora) e o Jev.

## Design

### D1. Onde roda

| Alvo | Onde roda | Usuário | Para quê |
|---|---|---|---|
| VPS | runner de host na VPS (`rbots-runner.service`) | o dono | o dia a dia |
| Este Mac | runner filho do app do Mac | o dono no Mac | iOS/macOS, simulador, iPhone |

O runner conecta no servidor em `/runner/connect` e anuncia `host` (no Mac, com `environment: "mac"`). Sem o runner da VPS no ar, o turno roda no container do servidor com uma linha de aviso no chat.

### D2. Escolha no menu do servidor

"VPS" e "Este Mac" aparecem como itens do próprio menu de servidor do app ("Principal ●"), com ponto de status; não há um segundo menu. A escolha fica no servidor (`environment` em `/preferences`, lista em `GET /environments`) e vale a partir do próximo turno. No Mac, "Rodar agentes neste Mac" (Ajustes › Bots) liga o runner.

### D3. Runner de host

O mesmo `packages/runner`, com um provider `host` no lugar do Docker:

- `exec` roda o `box-agent` direto, como o usuário do processo, com o `cwd` da worktree. Nada de `docker exec`, montagem, roots ou `specKey`.
- Na VPS, sobe como serviço `systemd --user` (`rbots-runner.service`), instalado pelo `install.sh` e pelo `rbots update`. O container `runner` sai do compose.
- No Mac, o app sobe o mesmo runner como processo filho (`RBOTS_ENVIRONMENT=mac`), com o token do dispositivo do app. Ver Etapa 3.
- Os CLIs vêm do PATH do host (`claude`, `codex`), com reserva em `<dados>/clis`.

### D4. O que continua escondido

Mesmo rodando como o dono, o turno não enxerga o cofre do r/bots. Cada comando do modelo roda em `bwrap` **sem trocar de usuário**, com `--tmpfs` sobre:

- `<dados>` (`~/.local/share/runelay-bots`: `vault.key`, banco, uploads de todos os bots) e `~/.local/share/runelay-bots-backups`;
- `~/.config/runelay-bots`.

O resto do home fica à vista, incluindo `~/.ssh`, `~/.claude*` e `~/.codex`, como no T3. Isso segura erro do modelo, não ataque: o processo é do dono. Sem `bwrap` no host, o comando roda sem esconder e o boot avisa uma vez.

### D5. Limites e avisos

- **Recurso:** cada turno roda em `systemd-run --user --scope -p MemoryMax=<BOX_MEM_MB>M -p CPUQuota=<BOX_CPUS*100>%`. Os comandos pesados mantêm `nice`, `timeout` e a fila de testes (`heavy-commands.service.ts`), agora com o lock no host.
- **Runner fora do ar:** o turno roda no container do servidor e o chat mostra uma linha avisando.
- **Ferramenta falhou:** o prompt de sistema passa a mandar o modelo parar e dizer, em uma linha, qual ferramenta falhou e o erro, em vez de buscar outro caminho.

### D6. Riscos

- **O modelo vê o home inteiro.** É o que o dono pediu. A lista dura de cards continua valendo.
- **Dois bots na mesma worktree.** Já é evitado pela worktree por tarefa. Não depende da caixa.
- **Bot pesado derruba a VPS.** Coberto pelo scope do systemd (D5), como a caixa fazia.
- **Host sem systemd de usuário** (container, WSL antigo): o runner roda sem scope e avisa no boot.

## Etapas

1. **Runner de host na VPS** (PR #45). A caixa continua no código, desligada (`BOTS_SANDBOX=off`).
2. **Remover a caixa** depois do deploy da etapa 1 e de um bot abrir PR de ponta a ponta: `docker.ts`, `box-spec.service.ts`, `rbbox-init`, `rb-sandbox-exec`, o usuário `runelaytool`, `BOTS_TOOL_SANDBOX`, as roots e o serviço `runner` do compose.
3. **Este Mac.** O app do Mac vira executor; os dados continuam no servidor. Detalhes em "Etapa 3 · Este Mac".

## Etapa 3 · Este Mac

Não existe servidor nativo no Mac: bots, conversas e memória ficam no servidor da VPS, e o Mac só precisa do `claude` logado. Com "Rodar agentes neste Mac" ligado, o app sobe `bun runner/main.js` com `RBOTS_PROVIDER=host`, `RBOTS_ENVIRONMENT=mac` e o token do dispositivo do app; o runner conecta em `/runner/connect` com `x-rbots-role: runner` (chave `<dispositivo>:runner`, sem derrubar a conexão do app) e anuncia `host` com `environment: "mac"`. No menu do servidor o dono escolhe VPS ou Este Mac (`PATCH /preferences {environment}`, lista em `GET /environments`); vale a partir do próximo turno. Mac escolhido e fora do ar: o turno não roda e o chat diz "Este Mac está desconectado; abra o app no Mac ou troque para VPS.", sem cair para a VPS. No Mac não há scope do systemd nem `bwrap`, o turno roda com o `HOME` do usuário e o login do próprio `claude` (`RBOTS_CLAUDE_BIN`, o `PATH`, `~/.local/bin/claude` ou `~/.claude/local/claude`); a pasta de conta da VPS é ignorada e a sessão do Claude no Mac é separada da VPS (chave `#mac`).

Regra da worktree: a worktree da tarefa vive na VPS e o GitHub é o único caminho entre as máquinas, sem commit novo na branch. Antes de um turno no Mac, o servidor tira um retrato do que está pendente (índice temporário com `git add -A`, `commit-tree` com pai no `HEAD`) e manda para a ref escondida `refs/rbots/sync/<branch>` no `origin` com `--no-verify`. O runner clona o repositório em `$RBOTS_WORKSPACES_DIR/<repo>` com as credenciais do Mac, busca a ref, cria ou reaproveita a worktree em `.worktrees/<repo>/<branch>` no pai do retrato e aplica os arquivos dele (inclusive os não rastreados e as remoções), deixando tudo como mudança pendente. Ao fim do turno (ou quando o servidor pede, antes de um `workspace_deliver` no meio do turno), o runner tira o retrato da worktree do Mac do mesmo jeito e empurra para a mesma ref; o servidor busca e aplica na worktree da VPS: se o `HEAD` do Mac descende do da VPS, a branch avança até ele, senão fica o da VPS; os arquivos ficam iguais aos do Mac. `workspace_deliver` roda sempre na VPS, depois de aplicar o último retrato, e depois de um push ou PR apaga a ref escondida no `origin` e no repositório local. Repositório sem remoto no GitHub ou worktree fora de uma branch não vai para o Mac: o turno para com o motivo. Caminhos nos hooks são traduzidos pelo runner (Mac ↔ VPS) para o portão do servidor continuar valendo.

## Tarefas da Etapa 1

### Trilha 1 · contrato
- [ ] 1.1 `packages/protocol`: capacidade `host` no `hello`.

### Trilha 2 · runner de host
- [ ] 2.1 `packages/runner`: provider `host` (exec direto, sem montagens), escolhido por `RBOTS_PROVIDER=host`.
- [ ] 2.2 `bwrap` sem troca de usuário com a lista de D4; aviso único sem `bwrap`.
- [ ] 2.3 `systemd-run --user --scope` por turno com os limites de D5; reserva sem scope.
- [ ] 2.4 `install.sh` e `rbots update`: instalar e reiniciar `rbots-runner.service`; tirar o `runner` do compose.

### Trilha 3 · servidor
- [ ] 3.1 `decidePlacement` escolhe o runner `host` da própria máquina.
- [ ] 3.2 Runner fora do ar: o turno roda no container do servidor com aviso no chat, nunca em silêncio.
- [ ] 3.3 Prompt: parar e relatar quando uma ferramenta falhar; tirar as frases sobre sandbox e caixa.

### Trilha 5 · validação
- [ ] 5.1 Teste de fumaça no CI: um turno real no runner de host roda `git status`, `gh auth status`, um teste com a trava e um push numa branch descartável.
- [ ] 5.2 Na VPS: bot abre PR de ponta a ponta sem card nem improviso.
