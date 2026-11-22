# Ambiente direto: o bot trabalha como o dono

Proposta (22/11/2026). Substitui as caixas de [ambientes.md](ambientes.md).

## Problema

O r/bots é self-hosted e tem um dono só. Mesmo assim, todo turno de código passa por quatro camadas pensadas para isolar gente de fora: a caixa `rbbox-*`, o usuário `runelaytool` com `rb-sandbox-exec`, as roots do runner e as montagens de login. A caixa precisa replicar à mão o que a máquina já tem, e cada camada quebrou alguma coisa na v0.1.15:

- push e PR (`/usr/bin/gh` no `.gitconfig`, #37);
- `git` na caixa (sem o `.git` principal), `gh`/`supabase`/`wrangler` sem login, a trava de testes e o `/tmp` dividido entre dois usuários (#39);
- caminho relativo do `test_playwright` (#41).

Quando uma ferramenta falha, o modelo improvisa (conector, Mac, `md5sum`) em vez de parar. O dono quer usar o r/bots como usa o T3 Code: o agente na máquina, como ele, com as ferramentas dele.

## Proposta

- O turno roda **direto na máquina, como o dono**: o mesmo usuário, o mesmo home, os mesmos `git`, `gh`, `supabase`, `wrangler`, Node e Docker do host.
- Dois ambientes: **VPS** (padrão) e **Mac** (iOS e macOS: Xcode, simulador, aparelho).
- O ambiente é escolhido no **seletor do topo do app**, o mesmo que hoje mostra o servidor ("Principal ●"). O ponto verde passa a dizer que o ambiente escolhido está no ar.
- A caixa sai: primeiro desligada, depois apagada.

O que não muda: worktree por tarefa, `workspace_deliver`, cards da lista dura (deploy, escrita em prod, dinheiro, mensagem para fora) e o Jev.

## Design

### D1. Ambientes

| Ambiente | Onde roda | Usuário | Para quê |
|---|---|---|---|
| VPS | runner de host na VPS | o dono (`$USER`) | todo o resto; padrão |
| Mac | runner do app Mac | o dono no Mac | build iOS/macOS, simulador, iPhone |

Um ambiente é um runner conectado em `/runner/connect` que anuncia a capacidade `host` no `hello`. O `local` (turno dentro do container do servidor) fica só como reserva enquanto o runner de host não sobe, com aviso no chat (D5).

### D2. Seletor no topo

O menu do perfil de servidor ("Principal") ganha uma seção **Onde roda** com os ambientes do servidor ativo, cada um com o ponto de status.

- A escolha é do dono, para todos os bots, e fica no servidor (`settings.environment`), não no aparelho. Mac e iPhone mostram a mesma.
- Vale a partir do próximo turno. O turno em andamento termina onde começou.
- Trocar entre ambientes da mesma máquina mantém a sessão do Claude, porque a pasta da conta é a mesma. Entre VPS e Mac entra o resumo de handoff que já existe.
- Sem escolha por bot nem por conversa nesta versão. Se fizer falta, entra depois.

### D3. Runner de host

O mesmo `packages/runner`, com um provider `host` no lugar do Docker:

- `exec` roda o `box-agent` direto, como o usuário do processo, com o `cwd` da worktree. Nada de `docker exec`, montagem, roots ou `specKey`.
- Na VPS, sobe como serviço `systemd --user` (`rbots-runner.service`), instalado pelo `install.sh` e pelo `rbots update`. O container `runner` sai do compose.
- No Mac, o app já conecta como runner (`mac-runner.service.ts`). Ele passa a anunciar `host` e atender `turn.start` quando houver checkout no Mac (Etapa 3).
- Os CLIs vêm do PATH do host (`claude`, `codex`), com reserva em `<dados>/clis`.

### D4. O que continua escondido

Mesmo rodando como o dono, o turno não enxerga o cofre do r/bots. Cada comando do modelo roda em `bwrap` **sem trocar de usuário**, com `--tmpfs` sobre:

- `<dados>` (`~/.local/share/runelay-bots`: `vault.key`, banco, uploads de todos os bots) e `~/.local/share/runelay-bots-backups`;
- `~/.config/runelay-bots`.

O resto do home fica à vista, incluindo `~/.ssh`, `~/.claude*` e `~/.codex`, como no T3. Isso segura erro do modelo, não ataque: o processo é do dono. Sem `bwrap` no host, o comando roda sem esconder e o boot avisa uma vez.

### D5. Limites e avisos

- **Recurso:** cada turno roda em `systemd-run --user --scope -p MemoryMax=<BOX_MEM_MB>M -p CPUQuota=<BOX_CPUS*100>%`. Os comandos pesados mantêm `nice`, `timeout` e a fila de testes (`heavy-commands.service.ts`), agora com o lock no host.
- **Ambiente fora do ar:** o turno não cai em outro lugar em silêncio. O chat mostra "O Mac está desconectado" com um botão para rodar na VPS.
- **Ferramenta falhou:** o prompt de sistema passa a mandar o modelo parar e dizer, em uma linha, qual ferramenta falhou e o erro, em vez de buscar outro caminho.

### D6. Riscos

- **O modelo vê o home inteiro.** É o que o dono pediu. A lista dura de cards continua valendo.
- **Dois bots na mesma worktree.** Já é evitado pela worktree por tarefa. Não depende da caixa.
- **Bot pesado derruba a VPS.** Coberto pelo scope do systemd (D5), como a caixa fazia.
- **Host sem systemd de usuário** (container, WSL antigo): o runner roda sem scope e avisa no boot.

## Etapas

1. **VPS direto como padrão.** Runner de host, seletor no topo com VPS, `bwrap` sem troca de usuário, scope do systemd e aviso de ambiente fora do ar. A caixa continua no código, desligada (`BOTS_SANDBOX=off`). Release normal.
2. **Remover a caixa** depois de alguns dias sem precisar dela: `docker.ts`, `box-spec.service.ts`, `rbbox-init`, `rb-sandbox-exec`, o usuário `runelaytool`, `BOTS_TOOL_SANDBOX`, as roots e o serviço `runner` do compose.
3. **Mac como ambiente.** O runner do app Mac atende turnos e o seletor mostra Mac. O checkout no Mac sai da mesma branch por git. Nada de copiar arquivo com `sed`.

## Tarefas da Etapa 1

### Trilha 1 · contrato
- [ ] 1.1 `packages/protocol`: capacidade `host` no `hello`; `settings.environment` (`vps` | `mac`).

### Trilha 2 · runner de host
- [ ] 2.1 `packages/runner`: provider `host` (exec direto, sem montagens), escolhido por `RBOTS_PROVIDER=host`.
- [ ] 2.2 `bwrap` sem troca de usuário com a lista de D4; aviso único sem `bwrap`.
- [ ] 2.3 `systemd-run --user --scope` por turno com os limites de D5; reserva sem scope.
- [ ] 2.4 `install.sh` e `rbots update`: instalar e reiniciar `rbots-runner.service`; tirar o `runner` do compose.

### Trilha 3 · servidor
- [ ] 3.1 `decidePlacement` lê `settings.environment` e só escolhe runner `host` daquele ambiente.
- [ ] 3.2 Ambiente fora do ar vira mensagem no chat com o botão de rodar na VPS, nunca fallback mudo.
- [ ] 3.3 Prompt: parar e relatar quando uma ferramenta falhar; tirar as frases sobre sandbox e caixa.

### Trilha 4 · apps
- [ ] 4.1 Mac: seção "Onde roda" no menu do perfil, ponto de status do ambiente escolhido.
- [ ] 4.2 iPhone: o mesmo menu.

### Trilha 5 · validação
- [ ] 5.1 Teste de fumaça no CI: um turno real no runner de host roda `git status`, `gh auth status`, um teste com a trava e um push numa branch descartável.
- [ ] 5.2 Na VPS: bot abre PR de ponta a ponta sem card nem improviso.
