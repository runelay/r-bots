# Ambiente direto: o bot trabalha como o dono

Proposta (22/11/2026). Substitui as caixas de [ambientes.md](ambientes.md).

## Problema

O r/bots é self-hosted e tem um dono só. Mesmo assim, todo turno de código passa por quatro camadas pensadas para isolar gente de fora: a caixa `rbbox-*`, o usuário `runelaytool` com `rb-sandbox-exec`, as roots do runner e as montagens de login. A caixa precisa replicar à mão o que a máquina já tem, e cada camada quebrou alguma coisa na v0.1.15:

- push e PR (`/usr/bin/gh` no `.gitconfig`, #37);
- `git` na caixa (sem o `.git` principal), `gh`/`supabase`/`wrangler` sem login, a trava de testes e o `/tmp` dividido entre dois usuários (#39);
- caminho relativo do `test_playwright` (#41).

Quando uma ferramenta falha, o modelo improvisa (conector, Mac, `md5sum`) em vez de parar. O dono quer usar o r/bots como usa o T3 Code: o agente na máquina, como ele, com as ferramentas dele.

## Proposta

- **O servidor é o ambiente.** "Principal" é o servidor na VPS, e os bots dele rodam na VPS. "Pessoal" é um servidor no Mac do dono, e os bots dele rodam no Mac (Xcode, simulador, iPhone). Trocar de ambiente é trocar de servidor no menu de perfis que o app já tem. Não existe outro seletor.
- Cada servidor roda os turnos **direto na própria máquina, como o dono**: o mesmo usuário, o mesmo home, os mesmos `git`, `gh`, `supabase`, `wrangler`, Node e Docker do host.
- De qualquer servidor, o bot continua alcançando o Mac pelas ferramentas de aparelho que já existem (`shell_run`, computador, simulador, Maestro), como os ambientes ligados do T3.
- A caixa sai: primeiro desligada, depois apagada.

O que não muda: worktree por tarefa, `workspace_deliver`, cards da lista dura (deploy, escrita em prod, dinheiro, mensagem para fora) e o Jev.

## Design

### D1. Ambiente = servidor

| Servidor | Onde roda | Usuário | Para quê |
|---|---|---|---|
| Principal | VPS, runner de host | o dono | o dia a dia |
| Pessoal | Mac, servidor nativo com runner de host | o dono no Mac | iOS/macOS, simulador, iPhone |

Cada servidor tem os próprios bots e conversas. O runner de host conecta no servidor da mesma máquina em `/runner/connect` e anuncia `host`. Sem ele no ar, o turno roda no container do servidor com uma linha de aviso no chat.

### D2. Sem seletor novo

O menu de perfis do app ("Principal ●") já troca de servidor. O ponto verde continua dizendo se o servidor responde. Nada de preferência de ambiente nem de `/environments`.

### D3. Runner de host

O mesmo `packages/runner`, com um provider `host` no lugar do Docker:

- `exec` roda o `box-agent` direto, como o usuário do processo, com o `cwd` da worktree. Nada de `docker exec`, montagem, roots ou `specKey`.
- Na VPS, sobe como serviço `systemd --user` (`rbots-runner.service`), instalado pelo `install.sh` e pelo `rbots update`. O container `runner` sai do compose.
- No Mac (Etapa 3), o servidor Pessoal sobe o mesmo runner como agente do launchd, sem systemd nem `bwrap`.
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

1. **Runner de host na VPS** (PR #45). A caixa continua no código, desligada.
2. **Remover a caixa** depois do deploy da etapa 1 e de um bot abrir PR de ponta a ponta: `docker.ts`, `box-spec.service.ts`, `rbbox-init`, `rb-sandbox-exec`, o usuário `runelaytool`, `BOTS_TOOL_SANDBOX`, as roots e o serviço `runner` do compose.
3. **Servidor Pessoal no Mac**: instalação nativa (Homebrew `postgresql@17` e `redis`, blobs em disco, servidor e runner como agentes do launchd em `127.0.0.1`), login do `claude` no Mac e o perfil "Pessoal" no app.

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
