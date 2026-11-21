# Caixas por bot: edição self-hosted, Fase A

Change em andamento (21/11/2026).

## Escopo

Este repositório é a edição **self-hosted**: uma pessoa baixa, roda um comando e tem os bots no próprio servidor (Bun + Postgres + Redis + Garage em Docker, caixa por bot em container, observabilidade opcional). Nada aqui depende de outra edição.

A caixa é escolhida por configuração: `BOTS_SANDBOX=off|docker`. `off` é o comportamento de hoje; o instalador liga `docker`.

## Proposta

Hoje todo turno, Bash, navegador, desktop e dev server roda dentro de um container só (`runelay-bots`, 6 GB, `${HOME}` montado inteiro). Um bot pesado derruba os outros, o swap da VPS enche e o código de bot divide disco com as credenciais.

A Fase A separa **quem decide** de **onde roda**:

- O servidor vira painel de controle: fila, aprovações, MCP, memória. Ele continua podendo rodar turnos no próprio processo (ambiente `local`, o comportamento de hoje).
- Um **runner** (`packages/runner`) roda em qualquer máquina, conecta de saída em `/runner/connect` com token de dispositivo e anuncia o que tem.
- O runner roda cada turno numa **caixa**: um container por bot, com teto de memória e CPU, runtime `runsc` (gVisor) quando existe, `runc` quando não.
- Com `BOTS_SANDBOX=docker`, o servidor manda cada turno para o runner da própria máquina (D4).
- `/metrics` no formato Prometheus e um perfil de observabilidade no compose (cAdvisor, Prometheus, Grafana).

Fora da Fase A: snapshot, Firecracker, navegador compartilhado, mover navegador, desktop e dev server para as caixas, e leitura de uso (tokens) de turnos remotos.

## Design

### D1. Ambiente

Um ambiente é uma conexão de runner viva, ou o `local` embutido. No self-hosted há um runner só, na própria máquina.

- O registro fica em memória no servidor, alimentado pelo hub de `/runner/connect`, que já existe (`mac-runner.service.ts`).
- O hub passa a aceitar runners que não são o Mac. A diferença está nas `capabilities` do `hello`, não no caminho nem no token.
- O Mac continua igual. Ele não anuncia `boxes`, então nunca recebe turno.

### D2. Contrato do runner (frames novos, v59)

Tipos em `packages/protocol/src/runner.ts`, exportados por `packages/protocol/src/index.ts`.

```ts
export type BoxRuntime = "runsc" | "runc";

export interface EnvironmentCapacity {
  cpus: number;
  memTotalMb: number;
  memFreeMb: number;
  boxesRunning: number;
  boxesPaused: number;
  maxBoxes: number;
}

export interface EnvironmentHello {
  type: "hello";
  capabilities: string[];
  runner?: {
    version: string;
    name: string;
    kvm: boolean;
    runtime: BoxRuntime;
    providers: Provider[];
    workspaceRoots: string[];
    capacity: EnvironmentCapacity;
  };
}

export interface CapacityFrame {
  type: "capacity";
  capacity: EnvironmentCapacity;
}

export type BoxState = "running" | "paused" | "stopped";

export interface BoxStatus {
  botId: string;
  state: BoxState;
  memMb: number;
  startedAt: string;
  lastUsedAt: string;
}

export interface BoxesFrame {
  type: "boxes";
  boxes: BoxStatus[];
}

export interface HookRequestFrame {
  type: "hook.request";
  id: string;
  turnId: string;
  phase: "before" | "after";
  tool: string;
  input: Record<string, unknown>;
  toolUseId: string;
  response?: unknown;
  failed?: boolean;
}

export interface HookResponseFrame {
  type: "hook.response";
  id: string;
  gate?: NativeToolGate;
}

export interface RemoteTurnStart {
  type: "request";
  id: string;
  op: "turn.start";
  turnId: string;
  botId: string;
  request: TurnRequest;
  box: BoxSpec;
  hooks: boolean;
}

export interface BoxSpec {
  memMb: number;
  cpus: number;
  mounts: Array<{ host: string; box: string; readOnly: boolean }>;
}
```

- `capabilities` de um runner de caixas: `["turns", "boxes", "mcp-proxy", "hooks"]`.
- O runner manda `capacity` a cada 15 s, junto do ping, e `boxes` quando alguma caixa muda de estado.
- O turno usa o fluxo que já existe: `turn.start` → `turn.event`* → `turn.end`, e `turn.cancel` (`mac-runner.service.ts:497-543`). O `request` do `turn.start` leva o `TurnRequest` com a URL do MCP só como caminho (`throughProxy`).
- Hooks nativos do Claude: quando `hooks: true`, o runner chama `hook.request` para cada `before` e `after`, e o servidor responde com `hook.response`, rodando os mesmos `NativeToolHooks` de hoje (`engine.service.ts:1149`). Hook sem resposta em 30 s nega a ferramenta.
- O Bash continua passando por `rb-sandbox-exec` como hoje (`hooks.service.ts:399`): a imagem da caixa tem os mesmos usuários (`runelaytool`, grupo `rbwork`) e o mesmo script, então o hook do servidor não muda.
- **Caminhos idênticos:** a caixa monta cada caminho no mesmo lugar em que o servidor o enxerga (`/data/work/<workKey>`, `/home/app/.claude`, o worktree). O `TurnRequest` vai sem tradução. O servidor traduz só o lado do host: `/data` → `BOTS_HOST_DATA_DIR` (padrão `${HOST_HOME}/.local/share/runelay-bots`) e `/home/app` → `HOST_HOME`.

### D3. Caixa (runner)

```ts
export interface SandboxProvider {
  readonly runtime: BoxRuntime;
  ensure(botId: string, spec: BoxSpec): Promise<BoxStatus>;
  exec(botId: string, argv: string[], opts: { cwd: string; env: Record<string, string>; signal: AbortSignal }): ExecHandle;
  pause(botId: string): Promise<void>;
  resume(botId: string): Promise<void>;
  stop(botId: string): Promise<void>;
  list(): Promise<BoxStatus[]>;
}

export interface ExecHandle {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}
```

- **Backend `docker`:** API do Docker Engine pelo socket unix, com `fetch(url, { unix })` do Bun (nada de dockerode). Um container por bot, `rbbox-<botId>`, a partir da imagem única `ghcr.io/runelay/r-bots:<versão>` (a mesma do servidor e do runner, desde 21/11), com `Entrypoint: rbbox-init`, `WorkingDir: /data` e healthcheck desligado.
  - Runtime `runsc` se `docker info` listar; senão `runc`, com aviso no `hello`.
  - Limites `--memory`, `--memory-swap` igual à memória, `--cpus`, `--pids-limit 1024`, `--cap-drop ALL`, `no-new-privileges`, rede `bridge`, sem montar o Docker socket nem `${HOME}`.
- **Montagens:** só o que vem em `BoxSpec.mounts`, ou seja, o diretório da conta do provider (somente leitura, exceto a pasta de sessões), o `workDir` do turno e, no modo código, o worktree. Os caminhos de host precisam estar em `workspaceRoots`.
- **Dentro da caixa:** um `box-agent` (Bun, `packages/runner/src/box-agent.ts`) recebe o `TurnRequest` e chama o `runTurn` de `@runelay-bots/providers` ali dentro. Ele fala com o runner por NDJSON no stdin/stdout do `docker exec`:
  - sai: `{type:"event"}`, `{type:"hook.request"}`, `{type:"mcp.request"}`, `{type:"end"}`;
  - entra: `{type:"start", request, hooks}`, `{type:"hook.response"}`, `{type:"mcp.response"}`, `{type:"cancel"}`.
  O MCP do CLI aponta para um proxy HTTP do box-agent em `127.0.0.1` dentro da caixa. O CLI roda como `app` e as ferramentas como `runelaytool`, via `rb-sandbox-exec`, igual à imagem do servidor; assim o Bash do bot não lê a credencial montada.
- **Estados:**
  - `running` → `paused` depois de `BOX_PAUSE_AFTER_MS` (padrão 120 000) sem turno (`docker pause`, volta em milissegundos);
  - `paused` → `stopped` depois de `BOX_STOP_AFTER_MS` (padrão 1 800 000) (`docker stop`; o container fica, volta em segundos);
  - turno novo faz `resume` ou `start`.
- **Porteiro de memória:** antes de `ensure`, se `memFreeMb - spec.memMb < BOX_MEM_RESERVE_MB` (padrão 1024), o runner para a caixa pausada mais antiga. Se nenhuma sobrar, recusa com `box.capacity`, e o servidor recoloca o turno.
- **Cache compartilhado:** volume `rbbox-cache` montado em `/cache` (store do pnpm e do bun, objetos git), leitura e escrita pelo usuário `tool`.

### D4. Escolha da caixa (substitui o agendador)

`place(input: PlacementInput): Placement` em `apps/server/src/modules/environments/services/scheduler.service.ts`, só com:

1. `BOTS_SANDBOX=off` (padrão) → `{kind:"local"}`.
2. `BOTS_SANDBOX=docker` → o runner conectado do dono que anuncia `boxes` e tem um `workspaceRoots` que contém o caminho de host do `codeCwd` (quando existe); havendo mais de um, o de mais `memFreeMb`. Sem nenhum, `local`, com aviso no log.

Sem regra por bot, sem afinidade, sem transbordo.

```ts
export interface EnvironmentInfo {
  id: string;
  name: string;
  kind: "local" | "runner";
  connected: boolean;
  capabilities: string[];
  runtime: BoxRuntime | null;
  capacity: EnvironmentCapacity | null;
  boxes: BoxStatus[];
}
```

`listEnvironments(): EnvironmentInfo[]` (em `environments.service.ts`) alimenta `GET /environments` e o `/metrics`.

### D4b. Runner local do self-hosted

- O runner roda como serviço `runner` do `compose.yaml`, no perfil `sandbox`, com o socket do Docker montado só nele. O container do servidor continua sem socket.
- Token: com `BOTS_SANDBOX=docker`, o servidor garante no boot uma chave de dispositivo `local-runner` do dono e grava em `<data>/runner/box-runner.token` (pasta 0700, arquivo 0600). O runner monta só essa pasta e lê o arquivo por `RBOTS_DEVICE_TOKEN_FILE`, esperando ele aparecer. Sem dono ainda (primeiro acesso), não grava e tenta de novo quando o dono existir.
- O runner usa a mesma imagem do servidor (`Dockerfile` da raiz), com `entrypoint: rbots-runner` no compose; o compose constrói uma vez só (21/11). A caixa também é essa imagem e não é serviço do compose: o runner cria e, se faltar, puxa `RBOX_IMAGE` (padrão: a própria imagem) pela API do Docker, com `RBOTS_REGISTRY_USER`/`RBOTS_REGISTRY_TOKEN` quando o registry pede login (os scripts gravam no `.env.local` com o repo privado). Ver `docker.md`.

### D6. Infra em código

- `compose.yaml` na raiz é a fonte da stack: servidor, Postgres, Redis, Garage, runner e observabilidade. Convenções em `docker.md`.
- `install.sh` na raiz e `infra/docker/install.sh`: ver D7.
- `infra/hetzner/`: OpenTofu que cria a VPS, o firewall (SSH e Tailscale) e, no `cloud-init`, instala Docker e Tailscale, clona o repo e chama o mesmo `infra/docker/install.sh`.
- Estado do OpenTofu num bucket S3 compatível (R2), por `-backend-config`; nada de credencial no repo.
- `.github/workflows/infra.yml`: em PR que toca `infra/**`, `fmt -check`, `init -backend=false` e `validate`; `plan` só com segredos; nunca `apply` automático.

### D7. Baixar e rodar (uma pessoa, uma máquina)

Meta: de uma máquina com Docker até o bot respondendo em um comando, sem `sudo`, sem editar arquivo e sem derrubar o que já roda na máquina.

```sh
curl -fsSL https://raw.githubusercontent.com/runelay/r-bots/main/install.sh | sh
```

- **`install.sh` na raiz:** se não está dentro de um checkout, clona com `git clone --depth 1` em `${RBOTS_DIR:-$HOME/.local/share/runelay-bots-app}` (ou atualiza com `git pull --ff-only` se já existe) e chama `infra/docker/install.sh`. Funciona com `sh` (POSIX), porque `curl | sh` não garante bash.
- **`infra/docker/install.sh`, padrão leve:**
  1. confere Docker, Compose v2 e se o usuário fala com o Docker sem `sudo` (senão explica `usermod -aG docker` e para);
  2. lê o gid do socket (`stat -c %g /var/run/docker.sock`), não o do grupo `docker`, e grava `DOCKER_GID` e `BOTS_SANDBOX=docker` no `.env.local` se faltarem;
  3. cria as pastas de dados (como hoje);
  4. `docker compose --profile sandbox up -d --build`;
  5. espera `/health` até 180 s e imprime: endereço (`http://127.0.0.1:2000`), runtime das caixas (do `GET /environments` ou do log do runner), o próximo passo (abrir o app e criar o dono) e o `tailscale serve` se o `tailscale` existir.
- **Opcionais por flag**, nunca por padrão:
  - `--harden`: instala Kata (com `/dev/kvm`) ou gVisor (sem), mexe em `/etc/docker/daemon.json` e reinicia o Docker. Pede `sudo` e avisa antes que o reinício derruba os containers da máquina, com confirmação (`--yes` pula). Sem `--harden` as caixas rodam com `runc` endurecido (cap-drop ALL, no-new-privileges, pids, memória), e o runner avisa no log.
  - `--observability`: sobe o perfil `observability` (cAdvisor, Prometheus, Grafana, ~1 GB). Fora do padrão para não comer a memória de uma máquina pequena.
- **`--env-file`:** o Compose não lê `.env.local` para preencher `${...}` e o bloco `environment:` ganha do `env_file`, então os scripts chamam `docker compose --env-file .env.local` (com `.env` antes, se existir). Sem isso `BOTS_MAX_TURNS`, `BOTS_MEM_LIMIT` e `DOCKER_GID` seriam ignorados.
- **Ordem com `--observability`:** o perfil sobe só depois do `/health`, para o Docker não criar `runner.token` como pasta ao montar no Prometheus.
- **Idempotente:** rodar de novo não duplica linha no `.env.local`, não reinstala runtime e só recria o que mudou.
- **`rbots` (atalho):** `infra/docker/rbots`, linkado em `~/.local/bin/rbots` pelo instalador quando a pasta está no `PATH`. Comandos:
  - `rbots status`: `docker compose ps` + turnos rodando (`/status`) + caixas (`/metrics`, que aceita o token do runner; `GET /environments` é só do dono) + runtime pelo log do runner;
  - `rbots logs [serviço]`;
  - `rbots update`: recusa se há turno rodando (a não ser com `--force`), `git pull --ff-only`, `docker compose up -d --build` com os mesmos perfis que estão de pé;
  - `rbots stop` / `rbots start`.
- **Memória numa máquina pequena:** os limites do compose viram padrão proporcional à RAM. O instalador lê `MemTotal` e, abaixo de 8 GB, grava `BOTS_MEM_LIMIT=3g` e `BOTS_MAX_TURNS=2` no `.env.local` (só se faltarem).

### D5. Observabilidade

- `GET /metrics`, no formato de texto do Prometheus, protegido pelo token do runner, como o `/status`. Métricas:
  - `rbots_turns_running`, `rbots_turns_queued`;
  - `rbots_environment_mem_free_mb{env}`, `rbots_environment_boxes{env,state}`;
  - `rbots_box_mem_mb{env,bot}`;
  - `rbots_turn_duration_seconds` (histograma por provider).
- O compose ganha o perfil `observability`, com cAdvisor (memória por container, caixas inclusive), Prometheus (raspa o cAdvisor e `/metrics`) e Grafana com um painel provisionado: memória por caixa, caixas por estado, memória livre por ambiente, turnos.
- O Grafana escuta só em `127.0.0.1` e entra pelo `tailscale serve`, como o resto.

### Riscos

- **Uso de tokens:** `usage-scan.service.ts` lê transcripts locais, e turno remoto não aparece no uso até a Fase B.
- **`--resume` do Claude:** depende dos arquivos de sessão no diretório da conta. A conta montada na caixa resolve no mesmo host; entre hosts diferentes vale o handoff que já existe.
- **gVisor deixa I/O de arquivo mais lento:** `npm install` e build ficam mais lentos dentro da caixa. É medido na validação.

## Fases seguintes

- **B:** navegador compartilhado no runner (um Chrome, um contexto por bot), dev server e prévia dentro da caixa pelo `/runner/tunnel`, uso de tokens reportado pelo runner.
- **C:** backend `firecracker` com snapshot para quem hospedar em máquina com KVM.

## Tarefas (trilhas disjuntas)

### Trilha 1 · contrato (Fase 4a, sozinha e antes das outras)

Arquivos: `packages/protocol/src/runner.ts` (novo), `packages/protocol/src/index.ts` (export).

- [ ] 1.1 Escrever os tipos de D2, D3 (`SandboxProvider`, `ExecHandle`) e D4 (`PlacementInput`, `Placement`, `EnvironmentInfo`) exatamente como acima. Só tipos, nenhuma lógica.

### Trilha 2 · servidor: ambientes, agendador e turno remoto

Arquivos: `apps/server/src/modules/environments/**` (novo), `apps/server/src/modules/accounts/services/mac-runner.service.ts`, `apps/server/src/modules/accounts/services/accounts.service.ts`, `apps/server/src/modules/engine/services/engine.service.ts` (só o repasse dos hooks do turno para o caminho remoto), `apps/server/src/config/env.ts`, testes ao lado.

- [ ] 2.1 Hub: guardar `runner`, `capacity` e `boxes` por conexão; aceitar os frames `capacity`, `boxes` e `hook.request`; `connectionFor` continua escolhendo o Mac para as ops do Mac.
- [ ] 2.2 `environments.service.ts`: `listEnvironments()` (inclui `local`), `onEnvironmentsChange`.
- [ ] 2.3 `scheduler.service.ts`: `place()` como em D4, com `BOTS_PLACEMENT=local|auto` (padrão `local`).
- [ ] 2.4 `runRemoteTurn`: generalizar `runMacTurn` por `environmentId`, com `box` e `hooks`; `runOnAccount` chama `place`.
- [ ] 2.5 Hooks por RPC: `hook.request` → `NativeToolHooks` do turno → `hook.response`.
- [ ] 2.6 `GET /environments` (dono) com `listEnvironments()`.

### Trilha 3 · runner e caixa

Arquivos: `packages/runner/**` (novo: `package.json`, `src/`, `box/Dockerfile`, `bunfig.toml`, testes), `package.json` da raiz (só workspaces, se precisar).

- [ ] 3.1 Conexão: WebSocket de saída em `/runner/connect` com `RBOTS_URL` e `RBOTS_DEVICE_TOKEN`, `hello` com capacidade lida de `/proc/meminfo` e `os.cpus()`, `capacity` a cada 15 s, reconexão com backoff de 1 a 15 s, e parada em 4001/401/403.
- [ ] 3.2 `DockerSandboxProvider`: Docker Engine API por socket unix, estados e porteiro de memória de D3.
- [ ] 3.3 `turn.start`: `ensure` → roda o CLI do provider dentro da caixa → `turn.event`/`turn.end`; `turn.cancel` mata o exec.
- [ ] 3.4 Proxy MCP local na caixa: HTTP em `127.0.0.1` repassado como `mcp.request`/`mcp.response`.
- [ ] 3.5 Hooks: cliente de `hook.request` com prazo de 30 s, negando no prazo.
- [ ] 3.6 `box/Dockerfile` e `box-agent.ts`: base `node:24-bookworm-slim` + Bun, CLIs claude, codex, cursor-agent e grok, git, ripgrep, `rb-sandbox-exec` e usuários `app`/`runelaytool` como a imagem do servidor, sem Chrome.

### Trilha 4 · observabilidade

Arquivos: `apps/server/src/modules/status/**`, `apps/server/src/app.ts` (só a rota `/metrics`), `deploy/observability/**` (novo), `compose.yaml` (só o perfil `observability`).

- [ ] 4.1 `GET /metrics` com as métricas de D5, lendo de `turnStats` e do registro de ambientes. Ambiente sem registro mostra só `local`.
- [ ] 4.2 `deploy/observability/`: `prometheus.yml`, provisionamento do Grafana (fonte de dados e painel JSON), serviços `cadvisor`, `prometheus` e `grafana` no perfil `observability`, tudo em `127.0.0.1`.

### Depois das trilhas

### Trilha 5 · integração (depois das trilhas 2–4)

Arquivos: `apps/server/src/modules/environments/**`, `apps/server/src/modules/accounts/services/accounts.service.ts`, `apps/server/src/config/env.ts`, `apps/server/src/app.ts`, `apps/server/src/modules/auth/services/policy.service.ts`, `apps/server/src/modules/engine/services/engine.service.ts`, `apps/server/src/index.ts`, `deploy/secrets/bootstrap.ts`, testes ao lado.

- [ ] 5.1 Trocar `BOTS_PLACEMENT` por `BOTS_SANDBOX` e reduzir o `place()` a D4 (sai regra por bot e afinidade).
- [ ] 5.2 `GET /environments` no `app.ts`; em `policy.service.ts`, `environments` só dono e `GET /metrics` liberado ao token interno como o `/status`.
- [ ] 5.3 `setEnvironmentSource(listEnvironments)` no boot e `observeTurnDuration` no `executeProvider`.
- [ ] 5.4 `bootstrap.ts`: `grafana-admin.password` e as pastas `observability/prometheus` e `observability/grafana`.
- [ ] 5.5 Token do runner local (D4b).

### Trilha 6 · infra em código e runner no compose

Arquivos: `infra/**`, `.github/workflows/infra.yml`, `packages/runner/Dockerfile`, `compose.yaml` (só serviços novos no perfil `sandbox`).

- [ ] 6.1 `infra/docker` e `infra/hetzner` como em D6, com README curto de uso.
- [ ] 6.2 Workflow `infra.yml`.
- [ ] 6.3 `packages/runner/Dockerfile` e serviços `runner` e `box-image` no perfil `sandbox` (D4b).

- [ ] Protocolo: seção `## v59 (21/11): ambientes e caixas` em `docs/protocol/accounts.md`, com `### Verificado` capturado de uma instância de teste na :2100, e a linha na tabela do `README.md`.
