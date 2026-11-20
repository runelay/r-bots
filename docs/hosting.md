# Caminho para o produto hospedado

Hoje o runelay bots é uma instalação de uma pessoa: um servidor, um dono, as assinaturas de IA logadas na máquina e o Mac dela como executor. Este documento lista o que muda para virar um serviço hospedado com várias pessoas, na ordem em que vale fazer.

## O que já ajuda

- **Postgres e Redis** separados do processo: o estado durável (conversas, blocos, contas) fica no Postgres e o trabalho em andamento (turnos, rotinas, exportações, novas tentativas) fica na fila do Redis. Dá para subir mais de um processo de servidor contra o mesmo banco e a mesma fila.
- **Outbox** (`job_outbox`): quem grava no banco e precisa disparar um job faz as duas coisas na mesma transação (`enqueueInTx`). O relay publica no Redis depois. Nada se perde entre o commit e a fila.
- **Fila com estado visível**: `GET /status`, `GET /jobs?status=failed` e `POST /jobs/:id/retry`. É a base para um painel de operação.
- **Blobs no S3** (Garage hoje, qualquer S3 amanhã).

## 1. Multiusuário

- Toda linha de domínio (bots, conversas, blocos, uploads, cofre, uso) ganha `owner_id` (ou `workspace_id`) e todo repository filtra por ele. Nada de filtro no cliente.
- Auth já tem contas, sessões, passkey e chaves de API; falta o conceito de workspace com papéis (dono, membro) e convites por workspace.
- Jobs carregam `workspaceId` no payload; `GET /jobs` filtra por ele no servidor. A fila de turnos ganha limite por workspace além do global (um usuário não ocupa todas as vagas).
- Segredos de integração (ElevenLabs, runelay, Jev) passam de "do servidor" para "do workspace", cifrados com uma chave por workspace (envelope: KEK do serviço, DEK por workspace).

## 2. Isolamento do que executa código

Hoje os bots rodam Bash, navegador, desktop virtual e worktrees no mesmo container, como um usuário de sistema. Num serviço com várias pessoas isso vira um sandbox por usuário:

- **Código e terminal**: uma microVM ou container efêmero por conversa (Firecracker, gVisor ou equivalente), com o repositório clonado dentro, CPU, memória e disco limitados, sem rede para dentro e com saída filtrada.
- **Navegador e desktop**: o Chromium e o Xvfb saem do container principal e vão para o sandbox do usuário; o servidor só fala com eles pelo CDP e pelo stream de vídeo.
- **Uso do computador da pessoa**: continua no app do Mac dela, que já roda como executor local com token próprio. No hospedado, o túnel do runner fica autenticado por conta e por dispositivo.
- **Processos**: o marcador `RUNELAY_TURN` e a varredura de órfãos deixam de ser necessários quando cada turno tem o seu sandbox; o limite passa a ser do orquestrador do sandbox.

## 3. Contas de IA por usuário

- Hoje os turnos rodam nas assinaturas logadas na máquina (Claude Code, Codex). No hospedado, cada pessoa conecta a própria conta: OAuth do provedor quando houver, ou chave de API própria guardada no cofre do workspace.
- O executor recebe a credencial só durante o turno, dentro do sandbox, e nunca a grava no disco do servidor.
- Os limites (`limits.service`) e o failover entre contas passam a ser por workspace.

## 4. Cobrança

- Medição já existe em `usage` (tokens por turno, por conta). Falta somar por workspace e por período e expor no app.
- Dois modelos possíveis, sem precisar escolher agora: assinatura do serviço com a pessoa trazendo a própria conta de IA, ou créditos de IA vendidos pelo serviço (aí o turno usa a conta do serviço e o uso vira cobrança).
- Minutos de sandbox (código, navegador, desktop) entram na conta como recurso medido, com limite por plano.
- Cobrança e limites viram jobs: fechamento de período como rotina repetível, aviso de limite como job disparado pelo outbox na mesma transação que grava o uso.

## 5. Operação

- Postgres gerenciado com backup e réplica; Redis gerenciado com AOF; S3 de verdade.
- Vários servidores atrás de um balanceador. A fila já distribui; o que ainda é estado em memória (streams de conversa, cards de aprovação abertos, chamadas de voz) precisa de afinidade por conversa ou de pub/sub no Redis.
- Observabilidade por workspace: falhos da fila, turnos por minuto, custo de IA.

## Banco externo (Neon)

O servidor fala com qualquer Postgres 15+ que tenha `unaccent` e `pg_trgm` (o Neon tem as duas). Trocar o banco local pelo Neon é só configurar a URL; nada no código muda.

- `DATABASE_URL`: quando existe, substitui o banco local do compose. Use a URL do pooler do Neon (`…-pooler….neon.tech/…?sslmode=require`).
- `DATABASE_URL_UNPOOLED`: URL direta, sem pooler. Migrations e o import do SQLite usam esta; sem ela, caem no `DATABASE_URL`.
- TLS: `sslmode` da URL vale. `require` liga TLS sem checar o certificado (igual ao libpq); `verify-ca`/`verify-full` checam.
- Pooler em modo transação (PgBouncer do Neon): o servidor não usa `SET`, advisory lock de sessão, `LISTEN/NOTIFY` nem tabela temporária; as travas são `pg_advisory_xact_lock`, presas à transação. Prepared statements desligam sozinhos quando o host tem `-pooler` ou a URL traz `pgbouncer=true`/`prepare=false`; `DATABASE_PREPARE=on|off` força.
- `DATABASE_POOL_MAX`: conexões por processo (padrão 10; 2 para migrations e import).
- Extensões: a migration roda `CREATE EXTENSION IF NOT EXISTS unaccent` e `pg_trgm`, e cria a configuração de busca `rb_search`.
- Backup: com banco local o servidor faz `pg_dump` diário (formato custom, compactado, 7 dias em `BOTS_BACKUP_DIR/db/<dia>/runelay-bots.dump`). Com banco externo o dump desliga e o log diz que o backup é do provedor (no Neon: histórico e branches de restauração).
- Compose: o serviço `postgres` continua no `depends_on` do server. Com Neon ele sobe e fica ocioso; para não subir, remova-o com um `compose.override.yaml` que tire o `depends_on`.
- Migrar os dados de um banco para o outro: `pg_dump --format=custom` do local e `pg_restore --no-owner -d "$DATABASE_URL_UNPOOLED"` no Neon, com o server parado.

## Segurança do deploy (v44)

O que o `compose.yaml` faz agora:

- **Imagens fixadas por digest** (`postgres:17-bookworm@sha256:…`, `redis:7.4-alpine@sha256:…`, `dxflrs/garage:v2.5.0@sha256:…`, `oven/bun:1.4.4-alpine@sha256:…`). A tag fica para leitura; as variáveis `BOTS_*_IMAGE` continuam trocando a imagem.
- **`no-new-privileges`** em Postgres, Redis, Garage e nos contêineres de bootstrap (`data-secrets`, `storage-secrets`, `storage-init`). O server não ganha essa opção porque usa `sudo`/`setpriv` para o desktop (`runelaybot`) e para o sandbox das ferramentas (`runelaytool`).
- **Server com `cap_drop: ALL`** e só `CHOWN`, `SETUID`, `SETGID`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `KILL`, `AUDIT_WRITE` de volta.
- **Raiz só leitura** em Postgres, Redis e Garage, com `tmpfs` em `/tmp` (e `/var/run/postgresql` no Postgres). Os dados continuam nos volumes.
- **Home do host não é mais montada inteira.** Entram só `BOTS_REPOS_DIR` (padrão `$HOME/projects`, no mesmo caminho) e `$HOME/.local/share/runelay-bots-worktrees`. `~/.gitconfig` vai só leitura. `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.config/gh` e `~/.supabase` continuam montados com escrita porque as assinaturas e os CLIs precisam renovar login; quem controla o server (ou um Bash que escape do sandbox) lê esses tokens. Trate a VPS como guardiã dessas contas.
- **Postgres com papel sem superusuário (opcional).** Instalação nova: `deploy/postgres/initdb/10-app-role.sh` cria `runelay_app` (sem superusuário, dono do banco e do schema `public`) com a senha de `<dados>/secrets/postgres-app.password`, que o `data-secrets` gera. O server só usa esse papel quando `POSTGRES_APP_USER` está definido.
- **Redis com usuário de ACL (opcional).** Com `BOTS_REDIS_APP_USER` definido, `deploy/redis/start.sh` desliga o usuário `default` e cria o usuário da aplicação com a senha de `redis.password`, chaves `~runelay-bots:*` e `+@all -@dangerous +info +client|setname +client|getname +client|setinfo +client|id +config|get` (o que o BullMQ usa: scripts Lua, `INFO`, `CLIENT SETNAME`). Sem a variável, continua o `requirepass` de antes.
- **Garage**: a chave S3 do server tem só leitura e escrita no bucket (`owner` é retirado com `DenyBucketKey`), a busca da chave é pelo nome exato (`ListKeys`) e os parâmetros vão com `encodeURIComponent`.
- **Backups**: diretório 0700 e arquivos 0600 (o `pg_dump` roda com `umask 077`). Com `BOTS_BACKUP_AGE_RECIPIENT=age1…` o dump sai cifrado com `age -r` (`runelay-bots.dump.age`); se a variável existir e o `age` não estiver instalado, o backup falha com erro no log em vez de gravar sem cifra. O backup nunca leva `vault.key`, `<dados>/secrets/` nem `auth.secret` (só o dump do banco e os blobs).
- **Chave do cofre** pode morar fora de `<dados>`: `VAULT_KEY_FILE` ou `/run/secrets/vault.key`, com `<dados>/vault.key` como reserva. O server não sobe se o arquivo for legível pelo grupo ou por outros.
- **`runner.token`** muda a cada boot. Ninguém além do operador usa o arquivo.

### Migração (o que o operador faz)

Nada disso foi aplicado em produção. Antes de qualquer passo: `curl -s -H "Authorization: Bearer $(cat ~/.local/share/runelay-bots/runner.token)" 127.0.0.1:2000/status` e só siga sem bot trabalhando.

1. **Repositórios fora de `~/projects`.** Se o modo código usa repositório em outro lugar da home, defina antes do próximo `up`: `echo "BOTS_REPOS_DIR=$HOME" >> .env` (volta ao comportamento antigo) ou aponte para a pasta certa.
2. **Permissão da chave do cofre.** `chmod 600 ~/.local/share/runelay-bots/vault.key` (e no arquivo de `VAULT_KEY_FILE`, se usar). Opcional, tirar a chave do diretório de dados: copie para fora (`install -m 600 -o 1000 -g 1000 …/vault.key /etc/runelay-bots/vault.key`), monte em `/run/secrets/vault.key:ro` com um `compose.override.yaml` e só então apague a cópia de `<dados>`.
3. **Subir com o compose novo.** `docker compose up -d --build`. Se o server não subir por causa das capabilities (log do entrypoint ou do sandbox), volte com um `compose.override.yaml` contendo `services: {server: {cap_drop: [], cap_add: []}}` e avise.
4. **Postgres sem superusuário (banco existente, uma vez).** Com o server parado:
   ```sh
   docker compose stop server
   docker compose run --rm data-secrets
   docker exec -i runelay-bots-postgres psql -U runelay_bots -d runelay_bots \
     -v app_password="$(cat ~/.local/share/runelay-bots/secrets/postgres-app.password)" \
     < deploy/postgres/operator/switch-to-app-role.sql
   echo "POSTGRES_APP_USER=runelay_app" >> .env
   docker compose up -d server
   ```
   Para voltar: tire `POSTGRES_APP_USER` do `.env` e recrie o server (o superusuário continua existindo).
5. **Redis com ACL.** `echo "BOTS_REDIS_APP_USER=runelay_app" >> .env && docker compose up -d redis server`. Para voltar: tire a variável e recrie os dois.
6. **Garage.** `docker compose up -d storage-init` reaplica as permissões da chave (tira `owner`).
7. **Backup cifrado.** O `age` já vem na imagem do server. Gere o par (`age-keygen -o ~/backup-age.key`, guardado fora da VPS) e defina `BOTS_BACKUP_AGE_RECIPIENT=<chave pública>` no `.env`. Restaurar: `age -d -i ~/backup-age.key runelay-bots.dump.age > runelay-bots.dump`.

### Firewall do host

O server fica em `network_mode: host` porque o `tailscale serve` fala com `127.0.0.1:2000`; isso não muda. Postgres, Redis e Garage publicam só em `127.0.0.1`. Ainda assim, feche a entrada da VPS para tudo que não for a tailnet (e SSH, se precisar fora dela). Com `ufw`:

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow in on tailscale0
sudo ufw allow 22/tcp   # só se precisar de SSH fora da tailnet
sudo ufw enable
```

Com `nftables`, o equivalente é uma cadeia `input` com `policy drop` aceitando `iif lo`, `ct state established,related`, `iifname "tailscale0"` e, se preciso, `tcp dport 22`. Confira depois com `sudo ss -ltnp` que nada escuta em `0.0.0.0` sem necessidade.

## Checklist pós-deploy de segurança

Junta os passos de operador espalhados acima e em `docs/protocol/code.md`, `auth.md`, `uploads.md` e `integrations.md` (seções v44). Siga na ordem, sempre conferindo `GET /status` antes de parar ou recriar o server.

### 1. Variáveis que precisam estar certas

| Variável | Onde | O que faz |
|---|---|---|
| `BOTS_TOOL_SANDBOX` | imagem (`uid`) | Comandos do modelo rodam como `runelaytool` (uid 1502). No boot o log traz uma linha `sandbox de ferramentas: uid (…)`; se vier `ERRO: BOTS_TOOL_SANDBOX=uid…`, nenhum comando de bot roda até corrigir. |
| `BOTS_ALLOWED_HOSTS` | `.env.local` | Hosts extras aceitos no `Host` (lista por vírgula, `host:porta` ou origem completa). Sem ela, só loopback, `*.ts.net` via `tailscale serve` e origens já lembradas; o resto leva `421`. |
| `BOTS_PREVIEW_ORIGIN` | `.env.local` | Origem separada da prévia do modo código (cookie de uso único). |
| `BOTS_REPOS_DIR` | `.env` (compose) | Pasta de repositórios montada no container (padrão `$HOME/projects`). |
| `POSTGRES_APP_USER` | `.env` | Papel do Postgres sem superusuário (passo 4 da migração). |
| `BOTS_REDIS_APP_USER` | `.env` | Usuário de ACL do Redis (passo 5 da migração). |
| `BOTS_BACKUP_AGE_RECIPIENT` | `.env` | Chave pública `age1…`; o dump sai cifrado ou o backup falha. |
| `BOTS_UPLOAD_QUOTA_MB` | `.env.local` | Cota de anexos por bot (padrão 5000); estourar dá `413`. |
| `VAULT_KEY_FILE` | `.env.local` | Caminho da chave do cofre fora de `<dados>` (ou `/run/secrets/vault.key`). |
| `RUNELAY_ALLOW_LOOPBACK` | `.env.local` | `1` só quando o runelay roda na mesma máquina; sem ela, loopback é recusado na validação. |

### 2. Host

- [ ] Credenciais do HOME fechadas: `chmod 700 ~/.claude ~/.codex ~/.config/gh ~/.supabase ~/.ssh` e `chmod 600 ~/.claude/.credentials.json ~/.codex/auth.json ~/.config/gh/hosts.yml ~/.claude.json`.
- [ ] Travessia para o sandbox, só execução: `setfacl -m u:1502:x ~ ~/.local ~/.local/share ~/<pasta dos repositórios>`. Tudo que for legível por "outros" nesse caminho fica legível para o modelo.
- [ ] Chave do cofre `chmod 600` (e o arquivo de `VAULT_KEY_FILE`, se usar).
- [ ] Firewall: entrada só pela tailnet (seção "Firewall do host"); `sudo ss -ltnp` sem nada em `0.0.0.0` à toa.
- [ ] `BOTS_ALLOWED_HOSTS` só com os nomes que o app usa de fato.

### 3. Banco, fila, armazenamento e backup

- [ ] Postgres com `POSTGRES_APP_USER=runelay_app` (passo 4 da migração).
- [ ] Redis com `BOTS_REDIS_APP_USER` (passo 5).
- [ ] `docker compose up -d storage-init` para tirar `owner` da chave do Garage (passo 6).
- [ ] `BOTS_BACKUP_AGE_RECIPIENT` definido e um backup de teste aberto com `age -d` fora da VPS (passo 7).

### 4. Trocar todo segredo de `<dados>`

O build anterior deixava o Bash dos bots ler `<dados>` inteiro. Trate como vazado tudo que estava lá e troque com o server parado (`docker compose stop server`), na ordem abaixo.

1. **`auth.secret`**: `rm <dados>/auth.secret`. O server gera outro no boot e **todo mundo sai** (app, navegador e chaves de dispositivo precisam entrar de novo). Se usar `BETTER_AUTH_SECRET`, troque a variável.
2. **`vault.key`** (ordem segura, porque o server não gera chave nova enquanto houver segredos e as cópias antigas não abrem com a nova):
   1. Com o server ainda no ar, no app (Cofre), desligue a "cópia no servidor" de cada segredo. Os valores continuam no Keychain do Mac.
   2. `docker compose stop server`.
   3. Tire a chave antiga de `<dados>` sem apagar: `mv <dados>/vault.key ~/vault.key.antiga` (guarde fora da VPS até conferir).
   4. Gere a nova: `(umask 077; openssl rand -hex 32 > <dados>/vault.key) && chown 1000:1000 <dados>/vault.key` (ou no caminho de `VAULT_KEY_FILE`).
   5. `rm <dados>/integrations.key` (o server gera outra).
   6. `docker compose up -d server` e confira no log que não aparece `server_copy_broken`.
   7. No app, religue a cópia no servidor dos segredos que precisam dela e cadastre de novo as chaves em Configurações › Integrações (já com as chaves novas do item 5).
   8. Só então apague `~/vault.key.antiga`.
3. **Postgres**: gere senhas novas e aplique no banco antes de trocar os arquivos:
   ```sh
   new=$(openssl rand -hex 32); app=$(openssl rand -hex 32)
   docker exec -i runelay-bots-postgres psql -U runelay_bots -d runelay_bots \
     -c "ALTER ROLE runelay_bots PASSWORD '$new'" -c "ALTER ROLE runelay_app PASSWORD '$app'"
   printf %s "$new" > <dados>/secrets/postgres.password
   printf %s "$app" > <dados>/secrets/postgres-app.password
   ```
   (sem `runelay_app` criado, pule a segunda senha). Depois `docker compose up -d data-secrets` só confere dono e modo 0600.
4. **Redis**: `rm <dados>/secrets/redis.password && docker compose run --rm data-secrets && docker compose up -d --force-recreate redis`.
5. **Garage**: apague a chave S3 antiga (`docker exec runelay-bots-storage /garage key delete --yes runelay-bots-server`), apague `<dados>/storage/secrets/admin_token` e `rpc_secret` e rode `docker compose up -d --force-recreate storage-secrets storage storage-init`; o `storage-init` cria a chave nova e grava `<dados>/secrets/s3.secret-access-key`.
6. **Chaves de fora**: revogue e gere de novo a chave do runelay, a da ElevenLabs e a do Jev nos painéis de cada serviço, e cadastre em Configurações › Integrações.
7. **Contas logadas** (se houver suspeita de exposição de `~/.claude`, `~/.codex` ou `~/.config/gh`): revogue o token do `gh` em GitHub › Settings › Applications e rode `gh auth login`; saia e entre de novo no Claude (`claude /logout`, depois login) e no Codex (`codex logout`, `codex login`).
8. `docker compose up -d` e confira `GET /status`, o login no app e a linha do sandbox no log.

`runner.token` já muda a cada boot e `setup.token` só vale até o primeiro dono; nenhum dos dois precisa de passo extra.
