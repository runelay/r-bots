# infra/docker

Para quem já tem uma máquina com Docker. Sobe a stack do `compose.yaml` da raiz com as caixas dos bots ligadas, sem `sudo`, sem editar arquivo e sem reiniciar o Docker.

## Antes

- Docker Engine e Docker Compose v2 ou mais novo (`docker compose version`).
- Seu usuário falando com o Docker sem `sudo`. Se não falar, o instalador para e explica: `sudo usermod -aG docker $USER`, sair e entrar de novo na sessão.
- `curl` e `tar` (modo release, o padrão) ou `git` (modo código, com `RBOTS_FROM_SOURCE=1`).

## Uso

Em qualquer pasta:

```sh
curl -fsSL https://raw.githubusercontent.com/runelay/r-bots/main/install.sh | sh
```

Com opções:

```sh
curl -fsSL https://raw.githubusercontent.com/runelay/r-bots/main/install.sh | sh -s -- --observability
bash infra/docker/install.sh --harden          # dentro do checkout
```

### Modo release (padrão)

Fora de um checkout, o `install.sh` da raiz baixa a versão pronta do GitHub Releases, sem build na máquina:

1. consulta a última release do canal (`RBOTS_CHANNEL=stable`, o padrão, ou `beta`, que inclui pre-releases) ou a versão de `RBOTS_VERSION`;
2. baixa `r-bots-<versão>.tar.gz` e `SHA256SUMS` e confere o tarball (`sha256sum` ou `shasum -a 256`);
3. monta a pasta abaixo e chama `current/infra/docker/install.sh`, que roda `docker compose pull` e `up -d` com as imagens do GHCR (`ghcr.io/runelay/r-bots-server`, `-runner` e `-box`) e grava `RBOTS_VERSION` no `.env.local`.

```
~/.local/share/runelay-bots-app/      (RBOTS_DIR)
  .env.local                          persistente, vale para todas as versões
  releases/<versão>/                  tarball extraído
  releases/<versão>/.env.local -> ../../.env.local
  current -> releases/<versão>
```

Os dados continuam em `~/.local/share/runelay-bots`. O projeto do compose se chama sempre `runelay-bots`, então trocar de versão ou de pasta não cria outra stack.

Rodar o instalador de novo com uma versão já instalada só repete o `install.sh` dela; para trocar de versão, use `rbots update`.

```sh
curl -fsSL https://raw.githubusercontent.com/runelay/r-bots/main/install.sh | RBOTS_CHANNEL=beta sh
curl -fsSL https://raw.githubusercontent.com/runelay/r-bots/main/install.sh | RBOTS_VERSION=0.3.2 sh
```

### Repo privado

Enquanto o repo for privado, o instalador e o `rbots` precisam de um token do GitHub. Eles usam `RBOTS_GITHUB_TOKEN` ou, se faltar, o `gh auth token` de quem está logado no `gh`. Com token, a consulta e o download vão pela API do GitHub e as imagens são baixadas depois de um `docker login ghcr.io`. As imagens privadas pedem o escopo `read:packages`:

```sh
gh auth refresh -h github.com -s read:packages
curl -fsSL -H "Authorization: Bearer $(gh auth token)" \
  https://raw.githubusercontent.com/runelay/r-bots/main/install.sh | sh
```

Sem token e com o repo privado, o GitHub responde 404 e o instalador diz como passar o token. Para o servidor também consultar versões novas, ponha `RBOTS_GITHUB_TOKEN=...` no `.env.local`; o `rbots` lê de lá também. Com o repo público, nada disso é preciso.

### Modo código

Dentro de um checkout, o `install.sh` da raiz chama direto o script do checkout, que constrói as imagens na máquina (`up -d --build`). `RBOTS_FROM_SOURCE=1` força o modo de antes: clona o repo com `--depth 1` em `RBOTS_DIR` (ou faz `git pull --ff-only` se já existe). Uma pasta `RBOTS_DIR` que já é um clone continua no modo código; para passar às releases, instale com `RBOTS_DIR` apontando para outra pasta.

### O que o `infra/docker/install.sh` faz

1. confere Docker, Compose v2 ou mais novo e se o usuário fala com o Docker sem `sudo`;
2. cria as pastas de dados em `~/.local/share/runelay-bots` (com `runner/` em 0700);
3. grava no `.env.local`, só se a linha faltar: `BOTS_SANDBOX=docker`, `DOCKER_GID` (o gid do socket `/var/run/docker.sock`) e, em máquina com menos de 8 GB, `BOTS_MEM_LIMIT=3g` e `BOTS_MAX_TURNS=2`. No modo release grava também `RBOTS_VERSION` (trocando a linha) e `RBOTS_CHANNEL`, se veio no ambiente;
4. no modo release, `docker compose --profile sandbox pull` e `up -d`; num checkout, `docker compose --profile sandbox up -d --build`;
5. espera o `/health` por até 180 s e imprime o endereço, o runtime das caixas, o próximo passo (abrir o app e criar o dono) e o comando do `tailscale serve`, se o `tailscale` existir;
6. linka `rbots` em `~/.local/bin` quando essa pasta existe e está no `PATH` (no modo release, pelo link `current`, então o atalho acompanha as versões).

Rodar de novo é seguro: não duplica linha, não reinstala runtime e só recria o que mudou.

O runner espera sozinho o token que o servidor grava em `~/.local/share/runelay-bots/runner/box-runner.token` no primeiro acesso do dono; não precisa subir nada à mão depois.

## Opções

| Opção | O que faz |
|---|---|
| `--harden` | instala o runtime da caixa e reinicia o Docker. Com `/dev/kvm`: Kata Containers (`KATA_VERSION`, tarball estático em `/opt/kata`, runtime `kata`). Sem: gVisor (`GVISOR_RELEASE`, apt oficial, runtime `runsc`). Pede `sudo`, mexe em `/etc/docker/daemon.json`, usa `apt-get` para o que faltar e pergunta antes, porque reiniciar o Docker derruba os containers da máquina |
| `--yes` | não pergunta antes de reiniciar o Docker |
| `--observability` | sobe também o perfil `observability` (cAdvisor, Prometheus e Grafana em `127.0.0.1:3300`, cerca de 1 GB) |
| `--help` | ajuda |

Sem `--harden`, as caixas rodam com `runc` endurecido (cap-drop ALL, no-new-privileges, limites de pids e memória) e o runner avisa no log.

## rbots

```sh
rbots status            # containers, turnos rodando, runtime e caixas
rbots logs [serviço]    # logs ao vivo, de tudo ou de um serviço (server, runner, postgres...)
rbots update            # atualiza (veja abaixo)
rbots version           # versão instalada e a última do canal
rbots stop              # para sem apagar nada
rbots start             # liga de novo
```

O `rbots` descobre sozinho o modo: com `current` ao lado da versão, é release; num checkout, é código.

```
rbots update [--check] [--to v0.3.2] [--channel stable|beta] [--force] [--no-backup] [--yes]
```

No modo release:

1. descobre a versão alvo: a última do canal ou a de `--to`. `--check` só mostra a instalada e a disponível;
2. já na mesma versão, avisa e sai;
3. recusa com turno rodando (lê o `/status` com o token de `~/.local/share/runelay-bots/runner.token`), a não ser com `--force`;
4. faz backup do banco com `docker compose exec -T server ./runelay-bots-server backup`. Se falhar, para sem mudar nada (`--no-backup` pula);
5. baixa, confere e extrai em `releases/<alvo>`;
6. baixa as imagens novas com o compose novo, com a stack ainda na versão velha;
7. troca o `current`, grava `RBOTS_VERSION` (e `RBOTS_CHANNEL`, com `--channel`) e roda `up -d` com os mesmos perfis que estão de pé;
8. espera o `/health` por até 180 s. Se não vier, volta o `current` e o `RBOTS_VERSION`, sobe a versão anterior e avisa que o banco pode ter migrado, com o caminho do backup;
9. guarda as 3 últimas versões em `releases/` e apaga as mais velhas.

Voltar para uma versão mais velha pede `--yes`, porque as migrations do banco não voltam.

Num checkout, `rbots update` faz como antes: `git pull --ff-only` e `up -d --build` com os perfis que estão de pé, recusando com turno rodando a não ser com `--force`. `--to` e `--channel` valem só no modo release.

Sem o link em `~/.local/bin`, rode `current/infra/docker/rbots` (release) ou `infra/docker/rbots` (checkout).

## Sem o instalador

`docker compose up -d` na raiz continua funcionando, sem caixas: os turnos rodam dentro do container do servidor.

## Variáveis

| Variável | Padrão | Para quê |
|---|---|---|
| `RBOTS_DIR` | `~/.local/share/runelay-bots-app` | onde o `install.sh` da raiz monta as releases (ou clona, no modo código) |
| `RBOTS_CHANNEL` | `stable` | canal das versões: `stable` ou `beta` (inclui pre-releases). Fica no `.env.local` |
| `RBOTS_VERSION` | última do canal | no instalador, a versão a instalar (`0.3.2` ou `v0.3.2`); no `.env.local`, a versão das imagens, gravada pelos scripts |
| `RBOTS_GITHUB_TOKEN` | `gh auth token` | token para o repo e as imagens privadas (escopo `read:packages` nas imagens) |
| `RBOTS_RELEASE_REPO` | `runelay/r-bots` | repo das releases |
| `RBOTS_FROM_SOURCE` | vazio | `1` instala clonando o repo, como antes das releases |
| `RBOTS_REPO` | `https://github.com/runelay/r-bots.git` | de onde clonar no modo código |
| `BOTS_IMAGE`, `BOTS_RUNNER_IMAGE`, `RBOX_IMAGE` | `ghcr.io/runelay/r-bots-*:${RBOTS_VERSION}` | troca a imagem do servidor, do runner ou da caixa |
| `RBOTS_INSTALL_SANDBOX_RUNTIME` | vazio | `1` equivale a `--harden --yes` (compatibilidade; o `cloud-init` da Hetzner passa as flags direto) |
| `KATA_VERSION` | `3.18.0` | versão do Kata |
| `GVISOR_RELEASE` | `20261102` | release do gVisor (data `aaaammdd`) |
| `RBOTS_APP_USER` | usuário atual | quando roda como root, o usuário dono dos dados e da stack |
| `RBOTS_RUNTIME` | vazio | no `.env.local`, força `kata`, `runsc` ou `runc` no runner |
