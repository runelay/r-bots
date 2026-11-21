# Docker: convenções do repo

Vale para `compose.yaml`, `deploy/` e `infra/docker/`. Mudou uma regra daqui, mude esta página no mesmo PR.

## Stack

| Serviço | Perfil | Rede | O que é |
|---|---|---|---|
| `server` | padrão | host | servidor Bun, em `127.0.0.1:${GATEWAY_PORT:-2000}` |
| `postgres`, `redis`, `storage` (Garage) | padrão | bridge, porta só em `127.0.0.1` | dados |
| `data-secrets`, `storage-secrets`, `storage-init` | padrão | bridge | jobs de uma vez: geram senhas e configuram o Garage |
| `runner` | `sandbox` | host | roda as caixas dos bots pelo socket do Docker |
| `cadvisor`, `prometheus`, `grafana` | `observability` | host/bridge, só `127.0.0.1` | métricas |

- `server` e `runner` usam a **mesma imagem** (`x-image`). A caixa também, mas não é serviço do compose: o runner cria um container por bot com `RBOX_IMAGE` (padrão: a imagem do runner) e puxa pela API do Docker se faltar.
- Zero variável obrigatória: tudo tem padrão em `${VAR:-padrão}`. Os scripts passam `--env-file .env.local` (e `.env` antes, se existir).
- Nome do projeto fixo (`name: runelay-bots`). Sem `container_name`: os containers se chamam `runelay-bots-<serviço>-1`. Scripts e docs falam com eles por `docker compose exec <serviço>` ou pelo label `com.docker.compose.project`, nunca pelo nome do container. Uma segunda instância (teste) sobe com `-p outro-nome` e um override de portas e dados.

## Imagem única

Uma imagem só, `ghcr.io/runelay/r-bots:<versão>`, construída pelo `Dockerfile` da raiz (desde 21/11; antes eram `r-bots-server`, `r-bots-runner` e `r-bots-box`). O papel sai do comando:

| Papel | Como roda |
|---|---|
| servidor | padrão da imagem: `ENTRYPOINT runelay-entrypoint`, `CMD ./runelay-bots-server` (wrapper que roda `bun /app/apps/server/dist/index.js`) |
| runner | compose: `entrypoint: ["/usr/local/bin/rbots-runner"]` (wrapper de `bun /opt/rbots/runner/main.js`), `user: 1000:1000`, `group_add` do gid do socket, healthcheck `rbots-runner health` |
| caixa | o runner cria com `Entrypoint: ["/usr/local/bin/rbbox-init"]`, `Cmd: []`, `WorkingDir: /data` e healthcheck `NONE` (`packages/runner/src/docker.ts`) |

- `x-image: &image ${RBOTS_IMAGE:-${BOTS_IMAGE:-ghcr.io/runelay/r-bots:${RBOTS_VERSION:-dev}}}`. Só o `server` tem `build:`; o runner reaproveita a imagem, então `docker compose build` constrói uma vez. `BOTS_IMAGE` antigo ainda vale; `BOTS_RUNNER_IMAGE` saiu.
- `RBOX_IMAGE` padrão = a mesma imagem. Sem a variável, o runner usa `ghcr.io/runelay/r-bots:${RBOTS_VERSION}` (o `RBOTS_VERSION` vem do `ENV` da imagem).
- `claude-agent` fica em `/opt/rbots/claude-agent` (`CLAUDE_CODE_EXECUTABLE` e o link `/usr/local/bin/claude`), o mesmo para servidor e caixa. `box-agent.js` em `/opt/rbots`, `rbbox-init` e `rbots-runner` em `/usr/local/bin`.
- Servidor e runner são bundles JS (`bun build --target=bun --bytecode --minify`, CommonJS com o `.jsc` ao lado) rodando no Bun da imagem, não binários `--compile`: o runtime do Bun não vai junto em cada release. As migrations saem como arquivos em `dist/` e o bundle aponta para elas por caminho absoluto (`--public-path=/app/apps/server/dist/`); o `anydoc.node` fica fora do bundle (`--external`) e é lido por `NAPI_RS_NATIVE_LIBRARY_PATH`, na camada do Agent SDK. Bytecode em CommonJS não aceita `await` no topo do arquivo de entrada (por isso o `main.ts` do runner usa uma função `main`).
- Chrome for Testing e o venv do recorte de imagem não vêm na imagem: o servidor baixa sob demanda (`modules/tools`, `ensureTool`) em `/opt/rbots-tools` (`RBOTS_TOOLS_DIR`), que o compose monta de `~/.local/share/runelay-bots-tools` no host (o `install.sh` cria a pasta; o entrypoint passa para o `app` se o Docker a criou como root). Pastas 0755 e arquivos legíveis por todos, para o `runelaybot` do desktop e o `runelaytool` do sandbox usarem; nada sensível mora lá. A caixa monta a mesma pasta só leitura no mesmo caminho (`box-spec.service.ts`; o caminho do host está em `RBOTS_WORKSPACE_ROOTS` do runner). Ficam na imagem as bibliotecas do Chrome, as fontes, `python3`, as políticas em `/etc/opt/chrome_for_testing/policies/managed` e, no arm64, o `chromium` do apt.
- `~/.agent-browser/browsers/chrome-<versão>` do `app` e do `runelaytool` (imagem) e do `runelaybot` (entrypoint) aponta para `/opt/rbots-tools/chrome/current`, então o `agent-browser` rodado por bot no modo código acha o Chrome assim que ele é baixado, sem reiniciar; antes disso o link fica pendurado e o `agent-browser` diz que não há navegador. No arm64 aponta para `/opt/rbots/chromium` (o `chromium` do apt).
- A limpeza de imagens do runner (`boxImagesKept`) agora olha o repositório `ghcr.io/runelay/r-bots` inteiro: apaga só tags que nenhum container usa, guardando as 2 mais novas além da atual.

### Ordem das camadas

O que muda pouco fica embaixo; código do r/bots fica por último, em camadas pequenas:

1. `apt` (pacotes do sistema, cliente do Postgres), usuários e pastas (`/data`, `/cache`, `/etc/rb-sandbox`, `/opt/rbots`);
2. CLIs por npm (codex, agent-browser, pnpm, wrangler) e os opcionais (`INSTALL_CURSOR`, `GROK_NPM_PACKAGE` + `GROK_VERSION`);
3. binários de terceiros conferidos por sha256 (gh, supabase) e o Bun;
4. políticas do Chrome e os links do `agent-browser` para `/opt/rbots-tools`;
5. `claude-agent` e o `anydoc.node` do Agent SDK (mudam quando o `bun.lock` muda);
6. scripts (`runelay-entrypoint`, `rb-sandbox-exec`, `rbbox-init`), `bin/` do servidor, `box-agent.js`, o runner (wrapper e bundle) e, por último, o bundle do servidor com o wrapper `runelay-bots-server`.

Os passos de build (`deps`, `sdk`, `server-build`, `runner-build`, `box-agent-build`) só copiam o que usam, então mexer só no servidor não reconstrói o runner nem o box-agent.

Medido em 21/11 (amd64), com o carimbo de tempo fixo do release: 3,65 GB descomprimida e 941 MB em zstd (23 camadas); antes de tirar o Chrome e o recorte e de trocar os binários por bundles, 5,3 GB e 1,47 GB (24 camadas). Um release que só muda código do servidor baixa **uma camada, 15 MB em zstd** (o bundle com o bytecode e o sourcemap; com o binário compilado eram 70 MB, quase tudo o runtime do Bun embutido). Mexer no runner soma a camada dele (88 KB; eram 49 MB). Sem o carimbo fixo, toda camada refeita leva a hora do build e muda de digest mesmo com o mesmo conteúdo.

### Release: zstd e carimbo fixo

- Camadas em **zstd** (`compression=zstd,force-compression=true,oci-mediatypes=true`). Precisa de Docker 23 ou mais novo no cliente (testado com o 29.9 e o store do containerd).
- `SOURCE_DATE_EPOCH=0` e `rewrite-timestamp=true`: arquivos e pastas com o mesmo carimbo, então camada com o mesmo conteúdo tem o mesmo digest de um release para o outro e não desce de novo. O `created` da imagem fica em 1970; a versão está na label `org.opencontainers.image.version`.

## Imagens e pinagem

- Imagem própria: `ghcr.io/runelay/r-bots:${RBOTS_VERSION:-dev}`, com `build:` no compose (o release tira o `build:` e troca o `dev` pela versão, `scripts/release/render-compose.ts`).
- Imagem de terceiro: sempre `tag@sha256:<digest do índice multi-arch>`, com override por variável (`BOTS_POSTGRES_IMAGE`, `BOTS_GRAFANA_IMAGE`...). Nada de `latest` nem tag sem digest.
- A imagem do Bun dos jobs fica numa âncora só (`x-bun-image`).

Atualizar um digest:

```sh
docker buildx imagetools inspect grafana/grafana:11.5.0 --format '{{json .Manifest.Digest}}'
```

Troque tag e digest juntos no `compose.yaml`, rode `docker compose --profile sandbox --profile observability config -q` e suba só o serviço (`docker compose up -d grafana`).

## Blocos comuns (`x-*`)

- `x-logging`: `json-file`, 10 MB × 3 (o servidor sobrescreve para 20 MB × 5).
- `x-hardened`: `no-new-privileges` e `cap_drop: [ALL]`.
- `x-long-running`: `restart: unless-stopped` + logging.
- `x-job`: jobs de uma vez (`restart: "no"`, imagem do Bun, `read_only`, `/tmp` em tmpfs, 256 MB, 0,5 CPU, 64 pids).

Merge com `<<:` é raso: um serviço que declara `cap_add`, `environment` ou `logging` troca a chave inteira (para `environment`, use `<<: *job-env` dentro dela).

## Segurança

- Todo serviço longo: `cap_drop: [ALL]` e só o que precisa de volta. Jobs que fazem `chown`/`chmod` nos dados recebem `CHOWN`, `DAC_OVERRIDE` e `FOWNER`.
- `no-new-privileges` em tudo, **menos o `server`**: ele usa `sudo` (setuid) para trocar para `runelaytool`/`runelaybot`, e o entrypoint ajusta `/etc/passwd` e `/etc/rb-sandbox` antes do `setpriv`. Por isso o server também não é `read_only`; as capabilities dele são a lista mínima do entrypoint.
- `read_only` + `tmpfs` onde a imagem deixa: postgres, redis, garage, runner, jobs, cadvisor, prometheus, grafana.
- Serviço com dados roda como `1000:1000` (o dono de `~/.local/share/runelay-bots`).
- Portas só em `127.0.0.1`. O acesso de fora é o `tailscale serve`.
- O socket do Docker só no `runner`, nunca no `server`.
- `cadvisor` precisa de `privileged` para ler cgroups e `/dev/kmsg`; fica no perfil opcional.

## Limites

Todo serviço longo tem `mem_limit` = `memswap_limit` (sem swap), `cpus`, `pids_limit`, `healthcheck` e `stop_grace_period` (60 s no Postgres, 30 s nos demais). `init: true` onde o processo principal cria filhos (server, runner, grafana). Os limites de memória têm variável (`BOTS_MEM_LIMIT`, `BOTS_POSTGRES_MEM_LIMIT`...); o instalador baixa os do servidor em máquina com menos de 8 GB.

## Volumes

- Dados em `${HOME}/.local/share/runelay-bots` (bind, não volume nomeado), para backup e inspeção diretos. Backups em `${HOME}/.local/share/runelay-bots-backups`.
- `${HOME}` montado no mesmo caminho no server, para os caminhos do host valerem lá dentro.
- Runner: só `~/.local/share/runelay-bots/runner` (só leitura) e o socket do Docker. Sem `~/.docker`: a credencial do registry vem de `RBOTS_REGISTRY_USER`/`RBOTS_REGISTRY_TOKEN`, que o instalador e o `rbots update` gravam no `.env.local` quando o repo é privado.
- Bind de caminho que não existe vira pasta do root: o instalador cria antes tudo o que o compose monta (`~/.claude.json`, `runner/`, `runner.token` só depois do `/health`).

## Perfis

- Padrão: server e dados. `docker compose up -d` sem perfil roda os turnos dentro do server.
- `sandbox`: runner. É o que o instalador sobe.
- `observability`: cAdvisor, Prometheus e Grafana (~1 GB). Sobe depois do `/health`.
- `up -d --remove-orphans` com só `sandbox` não derruba o perfil `observability`; para derrubar: `docker compose --profile observability rm -sf cadvisor prometheus grafana`.

## Validar

```sh
docker build -t ghcr.io/runelay/r-bots:dev .
docker compose config -q
docker compose --profile sandbox --profile observability config -q
docker compose --env-file .env.local --profile sandbox up -d --remove-orphans
docker compose ps
bash -n infra/docker/*.sh infra/docker/rbots && uvx --from shellcheck-py shellcheck infra/docker/install.sh infra/docker/rbots
```

No CI, `.github/workflows/docker.yml` roda em PR e na `main` que mexem em Dockerfile, compose, `deploy/`, `packages/`, `apps/server/` ou `.github/`: actionlint, hadolint em todo `*Dockerfile` (`.github/hadolint.yaml`, falha a partir de warning), `docker compose config -q` com e sem perfis, e o build do `Dockerfile` só para cache (`type=cacheonly`, escopo `r-bots`, o mesmo do release).
