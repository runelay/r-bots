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
