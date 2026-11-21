# Releases: instalar e atualizar pelo GitHub

Change em andamento (21/11/2026). Edição self-hosted.

## Proposta

Hoje instalar é clonar o repo e atualizar é `git pull` + build na máquina: minutos de build, memória alta numa VPS pequena e ferramentas de build obrigatórias. A change publica cada versão como **GitHub Release** com imagens prontas no GHCR. Instalar e atualizar viram baixar, conferir e `docker compose pull && up -d`, em segundos.

O checkout continua funcionando para quem desenvolve: `compose.yaml` mantém o `build:` e o `rbots update` dentro de um checkout faz `git pull` + build como hoje.

## Design

### R1. Versão

- `package.json` da raiz ganha `"version": "0.1.0"`. Ela é a versão do produto.
- Release = tag `v<versão>`. O workflow falha se a tag não bate com o `package.json`.
- Tag com sufixo (`v0.2.0-beta.1`) vira pre-release (canal `beta`); sem sufixo, canal `stable`.
- A imagem recebe `--build-arg RBOTS_VERSION=<versão>`, que vira `ENV RBOTS_VERSION` (servidor, runner e caixa leem dali). Build local sem o arg fica `dev`.

### R2. Imagem

Uma imagem só desde 21/11 (antes eram três: `r-bots-server`, `r-bots-runner`, `r-bots-box`):

| Imagem | Dockerfile |
|---|---|
| `ghcr.io/runelay/r-bots` | `Dockerfile` (raiz) |

- O papel sai do comando: servidor (padrão), runner (`entrypoint: rbots-runner` no compose) e caixa (o runner cria com `rbbox-init`). Ver `docker.md` › Imagem única.
- Tags: `<versão>` sempre; `<major>.<minor>` e `latest` só no canal stable.
- Camadas em zstd, carimbo de tempo fixo (`SOURCE_DATE_EPOCH=0`, `rewrite-timestamp=true`) para camada igual manter o digest entre releases. Cliente com Docker 23 ou mais novo.
- Só `linux/amd64` nesta fase. arm64 fica para depois.
- Cache de build do Actions (`type=gha`, escopo `r-bots`).

`compose.yaml`:

```yaml
x-image: &image ${RBOTS_IMAGE:-${BOTS_IMAGE:-ghcr.io/runelay/r-bots:${RBOTS_VERSION:-dev}}}
server:   image: *image      # com build: Dockerfile
runner:   image: *image      # sem build, entrypoint rbots-runner
```

e o `RBOX_IMAGE` do runner usa `${RBOX_IMAGE:-<a mesma imagem>}`. O servidor recebe `RBOTS_VERSION`, `RBOTS_CHANNEL` e `RBOTS_GITHUB_TOKEN` no `environment:` com padrão vazio.

### R3. Workflow `.github/workflows/release.yml`

Disparo: push de tag `v*`. Permissões por job: `packages: write` e `id-token: write` no build, `contents: write` na publicação.

1. Confere tag × `package.json` e roda o teste do `render-compose`.
2. Build e push da imagem (R2) por digest, com SBOM e proveniência (`mode=max`). Trivy: relatório de HIGH/CRITICAL no resumo e falha com CRITICAL que tem correção. Confere que toda camada é zstd e escreve no resumo o número de camadas e o tamanho comprimido. Depois aplica as tags (`<versão>`, e `<major>.<minor>` e `latest` no stable) e confere que todas apontam para o digest.
3. **cosign só com o repo público** (`if: github.event.repository.private == false`): a assinatura keyless grava o nome do repo e do workflow no Rekor, que é público. Vale para a imagem e para o `SHA256SUMS`. Com o repo privado, as notas dizem que não há assinatura e mostram só o `sha256sum -c`.
4. Monta `r-bots-<versão>.tar.gz` com:
   - `compose.yaml` renderizado por `scripts/release/render-compose.ts`: tira todo `build:` e troca o padrão `${RBOTS_VERSION:-dev}` por `${RBOTS_VERSION:-<versão>}`;
   - `deploy/` inteiro (secrets, postgres, redis, garage, observability);
   - `infra/docker/install.sh` e `infra/docker/rbots`;
   - `VERSION` com a versão.
5. Anexa à release: o tarball, o `install.sh` da raiz, `images.txt` (uma linha, `ghcr.io/runelay/r-bots@<digest>`), `SHA256SUMS` e, com o repo público, `SHA256SUMS.sigstore.json`. Notas com a imagem, o digest e as tags, mais as geradas pelo GitHub. Pre-release quando a tag tem sufixo.

### R4. Layout na máquina

```
${RBOTS_DIR:-~/.local/share/runelay-bots-app}/
  .env.local                     persistente, sobrevive às versões
  releases/<versão>/             tarball extraído
  releases/<versão>/.env.local -> ../../.env.local
  current -> releases/<versão>
```

- Guarda as 3 últimas versões; apaga as mais velhas.
- Dados continuam em `~/.local/share/runelay-bots` (não muda).
- O nome do projeto compose é fixo (`name: runelay-bots`), então trocar de pasta não cria outra stack.

### R5. Acesso enquanto o repo for privado

- Token por `RBOTS_GITHUB_TOKEN` ou, se faltar, `gh auth token` quando o `gh` está logado.
- Com token: API com `Authorization: Bearer`, download do asset pela URL da API com `Accept: application/octet-stream` e `docker login ghcr.io` antes do `pull`.
- O runner não monta mais `~/.docker`: com o repo privado (o script pergunta à API, `"private": true`), o token vai para o `.env.local` persistente como `RBOTS_REGISTRY_USER`/`RBOTS_REGISTRY_TOKEN` (arquivo em 0600). Repo público: as linhas saem.
- Sem token e com 404: mensagem dizendo que o repo é privado e como passar o token.
- Com o repo público, nada disso é preciso.

### R6. `install.sh` da raiz

- Dentro de um checkout: como hoje (chama `infra/docker/install.sh`).
- Fora: **modo release** por padrão. Consulta `/repos/<repo>/releases/latest` (ou a lista, com `RBOTS_CHANNEL=beta`, pegando a mais nova incluindo pre-release), ou a tag de `RBOTS_VERSION`; baixa tarball e `SHA256SUMS`; confere (`sha256sum -c`, ou `shasum -a 256`); monta R4; chama `current/infra/docker/install.sh`.
- `RBOTS_FROM_SOURCE=1` mantém o modo clone de hoje.
- Repo por `RBOTS_RELEASE_REPO`, padrão `runelay/r-bots`.
- `infra/docker/install.sh` em modo release roda `docker compose pull` + `up -d` sem build (num checkout, `docker compose build` + `up -d`), e grava `RBOTS_VERSION=<versão>` no `.env.local` persistente (substituindo a linha, não somando).

### R7. `rbots update`

Modo detectado: `current` existe → release; `.git` existe → checkout (comportamento de hoje).

```
rbots update [--check] [--to v0.3.2] [--channel stable|beta] [--force] [--no-backup] [--yes]
rbots version
```

Modo release:

1. Descobre a versão alvo (última do canal, ou `--to`). `--check` só imprime atual × disponível e sai.
2. Mesma versão: "já está na última" e sai.
3. Recusa com turno rodando, a não ser com `--force`.
4. Backup: `docker compose exec -T -u app server ./runelay-bots-server backup` (como root, deixaria arquivos que o `app` não lê). Falhou, aborta (a não ser com `--no-backup`).
5. Baixa, confere, extrai em `releases/<alvo>`, liga o `.env.local`.
6. `pull` da imagem nova com o compose novo (a stack ainda roda a versão velha); só descem as camadas que mudaram.
7. Troca `current`, grava `RBOTS_VERSION` e roda `up -d` com os mesmos perfis de pé.
8. Espera `/health` até 180 s. Falhou: volta `current` e `RBOTS_VERSION`, `up -d` de novo e avisa que o banco pode ter migrado, com o caminho do backup do passo 4.
9. Versão alvo mais velha que a atual: avisa que migrations não voltam e pede `--yes`.

`rbots version` mostra a versão instalada (do `VERSION` de `current`, ou `dev` no checkout) e a última do canal.

### R8. Servidor

- `./runelay-bots-server backup`: roda `runBackup` (`backup.service.ts`) e sai com 0/1, sem subir o servidor. Imprime o caminho do snapshot.
- `GET /server/version` (dono):
  ```ts
  { current: string; channel: "stable" | "beta"; latest: string | null;
    updateAvailable: boolean; releaseUrl: string | null; publishedAt: string | null;
    notes: string | null; updateCommand: "rbots update" }
  ```
  - `current` = `RBOTS_VERSION` ou `dev`. Em `dev`, `updateAvailable` é sempre `false`.
  - Consulta o GitHub (R5 para token) a cada 6 h, prazo 4 s, cache de falha 10 min. `BOTS_UPDATE_CHECKS=off` desliga, como nos CLIs.
  - `notes` é o corpo da release cortado em 4 000 caracteres.
- O servidor não se atualiza sozinho: ele não tem o socket do Docker nem os arquivos do compose, e isso continua assim. O app mostra a versão nova e o comando.

### R9. App do Mac: Ajustes › Versões

Uma seção nova nos Ajustes:

- **r/bots:** versão atual; com versão nova, "0.4.0 disponível", link para as notas e o comando `rbots update` com botão de copiar.
- **CLIs dos bots** (rotas de S5 em `sessoes-provider.md`): uma linha por provider com versão instalada, origem e, quando há, "→ <última> · Atualizar". Durante a atualização, a linha mostra progresso e o app consulta `GET /providers/versions` a cada 2 s até `updating` virar `false`. Erro aparece na linha. "Voltar" quando há `previous`.
- Só aparece para o dono.

## Tarefas (trilhas disjuntas)

### Trilha 1 · release no CI

Arquivos: `.github/workflows/release.yml` (novo), `scripts/release/**` (novo), `package.json` da raiz (só `version`), `Dockerfile` da raiz (só `ARG`/`ENV RBOTS_VERSION`).

- [ ] 1.1 Workflow R3, render do compose e teste do render.

### Trilha 2 · compose, instalador e `rbots`

Arquivos: `compose.yaml`, `install.sh`, `infra/docker/**`, `README.md` (Quick start).

- [ ] 2.1 R2 no compose, R4–R7 nos scripts, README.

### Trilha 3 · servidor

Arquivos: `apps/server/src/index.ts` (subcomando `backup`), `apps/server/src/modules/server-version/**` (novo), `apps/server/src/app.ts`, `apps/server/src/modules/auth/services/policy.service.ts`, `apps/server/src/config/env.ts`, testes ao lado.

- [ ] 3.1 Subcomando `backup`, `GET /server/version`.

### Trilha 4 · app do Mac

Arquivos: `apps/mac/Sources/RunelayBots/Features/Settings/**`, `apps/mac/Sources/RunelayBots/Networking/**` (só chamadas novas), `apps/mac/Sources/RunelayBots/Models/**` (só modelos novos), testes do app se houver padrão.

- [ ] 4.1 Seção R9.
