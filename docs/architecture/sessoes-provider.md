# Sessões de provider: harness modular

Change proposta (21/11/2026), a partir da pesquisa no T3 Code (`pingdotgg/t3code`, `orchestration-v2`) e no Orca (`stablyai/orca`, `agent-session-wire`).

## Proposta

Hoje cada turno abre um processo novo do CLI e recarrega a conversa com `resume` (`packages/providers/src/claude.ts:205`). Isso custa tempo em todo turno, deixa a mensagem no meio do turno funcionar só no chat e espalha `if (provider === ...)` pelo engine.

A change cria três peças com fronteira clara:

1. **Adapter por provider:** um contrato único, `ProviderAdapter` → `ProviderSession`, com **capacidades declaradas**. O engine decide pelas capacidades, nunca pelo nome do provider (invariante do T3).
2. **Sessão viva por conversa:** o Claude mantém um `query()` aberto e recebe cada turno e cada mensagem no meio do turno por uma fila de entrada (T3 `ClaudeAdapterV2.ts:1539`). Os outros providers entram por um adapter de turno único que embrulha o `runTurn` de hoje, sem mudar comportamento.
3. **Gerente de sessões no servidor:** reaproveita a sessão aberta, fecha depois de 30 min parada, limita quantas ficam abertas e força a parada 15 s depois de um "parar" que não respondeu.

Também entra a **entrega idempotente**: cada mensagem é processada uma vez só, por id, sem varrer o log.

Ficam para a Fase B: Codex pelo `app-server`, continuar turno depois de restart, desfazer que volta a conversa da IA, limite de replay na reconexão e editar mensagem na fila. Sessão viva dentro da caixa remota fica para quando as caixas estiverem validadas; até lá, turno remoto usa o adapter de turno único.

## Design

### S1. Contrato (`packages/protocol/src/session.ts`)

```ts
export interface ProviderCapabilities {
  persistentSession: boolean;
  steering: boolean;
  interrupt: boolean;
  streamingText: boolean;
}

export interface SessionOpenOptions {
  sessionKey: string;
  provider: Provider;
  model: string;
  effort: string | null;
  systemPrompt: string;
  resume: string | null;
  fork?: boolean;
  mcp: McpTarget | null;
  workKey: string;
  code?: { cwd: string; readOnly?: boolean } | null;
  configDir?: string | null;
  nativeShell?: boolean;
  hooks?: NativeToolHooks;
}

export interface TurnInput {
  turnId: string;
  prompt: string;
  images?: Array<{ path: string; mime: string; label: string }>;
}

export interface TurnResult {
  ok: boolean;
  providerSessionId: string | null;
  message?: string;
}

export type ProviderEmit = (event: ProviderEvent) => void;

export interface ProviderSession {
  readonly key: string;
  readonly fingerprint: string;
  readonly capabilities: ProviderCapabilities;
  providerSessionId(): string | null;
  runTurn(input: TurnInput, emit: ProviderEmit, signal: AbortSignal): Promise<TurnResult>;
  steer(message: LiveMessage): boolean;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface ProviderAdapter {
  readonly provider: Provider;
  readonly capabilities: ProviderCapabilities;
  open(options: SessionOpenOptions, dataDir: string): Promise<ProviderSession>;
}
```

- `fingerprint` é o hash do que exige sessão nova se mudar: provider, modelo, esforço, conta (`configDir`), `code.cwd`, `readOnly`, `nativeShell` e o system prompt estável.
- `runTurn` de uma sessão só aceita um turno por vez. Um segundo turno antes do fim é erro de programação.

### S2. Adapters (`packages/providers/src/adapters/`)

- `registry.ts`: `adapterFor(provider): ProviderAdapter`, um mapa fixo. Provider novo = um arquivo e uma linha no mapa.
- `one-shot.ts`: `oneShotAdapter(provider)` embrulha o `runTurn` atual de `index.ts`. Capacidades: `persistentSession: false`, `steering` igual a hoje (só claude via `LiveInbox`), `interrupt: true` (aborta o processo).
- `claude-session.ts`: `claudeSessionAdapter`.
  - Um `query()` por sessão, com prompt em streaming alimentado por uma fila assíncrona própria (`input-queue.ts`, sem dependência nova).
  - `runTurn` empurra o `TurnInput` na fila e termina no `result` daquele turno.
  - `steer` empurra uma mensagem extra durante o turno.
  - `interrupt` chama o `interrupt()` do `query`.
  - `close` encerra a fila e o processo.
  - Hooks e MCP como hoje em `claude.ts`.
- `claude.ts`, `codex.ts`, `cursor.ts`, `grok.ts` e `runTurn` continuam exportados. O `box-agent` do runner segue usando `runTurn`.

### S3. Gerente de sessões (`apps/server/src/modules/engine/services/provider-sessions.service.ts`)

```ts
export interface SessionManagerConfig {
  idleMs: number;
  maxOpen: number;
  interruptGraceMs: number;
}

export function acquireSession(options: SessionOpenOptions): Promise<ProviderSession>;
export function releaseSession(key: string): void;
export function interruptSession(key: string): Promise<"interrupted" | "forced" | "idle">;
export function closeSession(key: string): Promise<void>;
export function closeAllSessions(): Promise<void>;
export function openSessions(): Array<{ key: string; provider: Provider; idleForMs: number }>;
```

- **Reuso:** `acquireSession` devolve a sessão aberta da chave se o `fingerprint` bate; se não bate, fecha a antiga e abre outra.
- **Ociosidade:** fecha depois de `PROVIDER_SESSION_IDLE_MS` (padrão 1 800 000) sem turno.
- **Limite:** `PROVIDER_SESSIONS_MAX` (padrão 6). Ao passar, fecha a ociosa mais antiga. Se todas estão em turno, abre mesmo assim e loga, porque os slots de turno (`BOTS_MAX_TURNS`) já limitam o que roda.
- **Parar:** `interruptSession` chama `interrupt()` e espera `PROVIDER_INTERRUPT_GRACE_MS` (padrão 15 000). Se o turno não terminou, `close()` força e devolve `"forced"`.
- **Ciclo do servidor:** `closeAllSessions` no desligamento. Conta trocada pelo failover fecha a sessão da conta antiga.
- O engine (`executeProvider`, `engine.service.ts`) chama `acquireSession` só quando `BOTS_PROVIDER_SESSIONS=on` (padrão `off`), o turno é local e o adapter tem `persistentSession`. Em qualquer outro caso, o caminho de hoje fica intacto.
- O `steer` do engine (`engine.service.ts:648`) passa a usar `session.steer` quando há sessão viva com `steering`.
- A métrica `rbots_provider_sessions_open` entra no `/metrics`.

### S4. Entrega idempotente

- Tabela `turn_deliveries(delivery_id text primary key, session_id text not null, turn_id text, created_at timestamptz not null default now())` no schema Drizzle. Migration só gerada com `db:generate`, nunca aplicada aqui.
- `deliveryHandled` (`turn-queue.service.ts:98`) vira uma consulta pela chave. A gravação acontece na mesma transação em que o turno é registrado.
- Com isso, o job de turno pode usar `attempts: 2` sem risco de rodar a mesma mensagem duas vezes.

### S5. Versão e atualização dos CLIs (self-hosted)

Inspirado em `packages/provider-core/src/server/maintenance.ts` e `apps/server/src/provider/providerMaintenanceRunner.ts` do T3. O T3 descobre como o CLI foi instalado (npm, bun, pnpm, mise, instalador nativo), consulta a última versão (npm dist-tag ou canal do instalador, com cache), roda o comando de atualização com trava por local de instalação, prazo de 30 min e progresso.

Aqui não existe "como foi instalado": os CLIs vêm na imagem. Para a pessoa atualizar com um clique, sem rebuild e sem reiniciar nada, o servidor mantém **CLIs gerenciados** numa pasta de dados que o servidor e as caixas enxergam no mesmo caminho.

- **Pasta:** `/data/clis` no servidor (`<dados>/clis` no host). A caixa monta a mesma pasta, só leitura, em `/data/clis` (caminho idêntico, como o resto em D2 de `ambientes.md`).
  ```
  /data/clis/<provider>/<versão>/             npm install -g --prefix (cria bin/)
  /data/clis/<provider>/current -> <versão>    link relativo
  /data/clis/<provider>/previous -> <versão>   para voltar
  ```
- **Quem entra:** Claude (`@anthropic-ai/claude-code`, binário nativo do pacote) e Codex (`@openai/codex`). Cursor e Grok mostram só a versão da imagem.
- **Resolução do binário** (`packages/providers`, função `managedBinary(provider)`): se `current/bin/<bin>` existe, ele ganha; senão, o da imagem como hoje. No Claude isso vira o `pathToClaudeCodeExecutable` (antes do `CLAUDE_CODE_EXECUTABLE`); no Codex, o `findBinary`. Vale no servidor e no `box-agent`, porque os dois leem `RBOTS_CLIS_DIR` (padrão `/data/clis`).
- **Versão instalada:** o nome da pasta para onde `current` aponta; sem `current`, `<bin> --version` da imagem, uma vez por boot. A da caixa é a mesma pasta, então não precisa de campo novo no `hello`.
- **Última versão:** dist-tag `latest` do registro npm (`https://registry.npmjs.org/-/package/<pkg>/dist-tags`), 4 s de prazo, cache de 6 h por pacote, comparação semver simples. `BOTS_UPDATE_CHECKS=off` desliga a consulta.
- **Atualizar** (`POST /providers/:provider/update`, só dono, `{version?}`; padrão é a última):
  1. trava por provider (segundo pedido devolve 409);
  2. `npm install -g --prefix <versão>.tmp --no-audit --no-fund <pkg>@<versão>` com prazo de 10 min (sem `-g` o binário cai em `node_modules/.bin`, não em `bin/`); versão que já tem pasta só é conferida;
  3. confere que `bin --version` roda e devolve a versão pedida; se falhar, apaga o `.tmp` e guarda o erro;
  4. renomeia para `<versão>` e troca `current` de forma atômica (link novo + `rename`);
  5. aponta `previous` para a versão que saiu e apaga as outras.
  Sem `version` e sem última conhecida (consulta desligada ou registro fora): 400. Cache de falha da consulta: 10 min.
  Turno rodando continua com o binário velho (arquivo aberto); o próximo turno pega o novo. Nada reinicia.
- **Voltar:** `POST /providers/:provider/rollback` troca `current` e `previous`. Sem `previous`, ou com atualização em andamento: 409. Não volta para a versão da imagem.
- O Claude gerenciado é o binário nativo do pacote (`bin/claude`, ELF). O Agent SDK só chama por node caminhos `.js/.mjs/.ts`; qualquer outro ele executa direto. Instalar Claude mais antigo que o do SDK pode quebrar o MCP.
- `probe()` e a voz ainda usam o binário da imagem.
- **Ler:** `GET /providers/versions` (dono) devolve por provider `{ provider, installed, source: "managed" | "image", latest, updateAvailable, updating, lastError, previous }`.
- O atualizador automático dos CLIs continua desligado (`DISABLE_AUTOUPDATER=1`) no servidor e nas caixas: quem atualiza é essa rota.
- O app (tela de Ajustes) que mostra "Claude Code 2.1.328 → 2.1.340 · Atualizar" fica para depois destas rotas.

## Tarefas (trilhas disjuntas)

### Trilha 1 · contrato (sozinha e antes)

Arquivos: `packages/protocol/src/session.ts` (novo), `packages/protocol/src/index.ts` (export).

- [ ] 1.1 Os tipos de S1 exatamente como acima. Só tipos.

### Trilha 2 · adapters

Arquivos: `packages/providers/src/adapters/**` (novo), `packages/providers/src/index.ts` (só exports), testes ao lado.

- [ ] 2.1 `registry.ts`, `one-shot.ts`, `input-queue.ts`.
- [ ] 2.2 `claude-session.ts` com fila de entrada, `runTurn` por turno, `steer`, `interrupt`, `close`.

### Trilha 3 · gerente de sessões e engine

Arquivos: `apps/server/src/modules/engine/services/provider-sessions.service.ts` (novo), `apps/server/src/modules/engine/services/engine.service.ts`, `apps/server/src/config/env.ts`, `apps/server/src/index.ts` (só desligamento), `apps/server/src/modules/status/services/metrics.service.ts` (só a métrica nova), testes ao lado.

- [ ] 3.1 Gerente de S3.
- [ ] 3.2 Ligar no `executeProvider` e no `steer`, atrás de `BOTS_PROVIDER_SESSIONS`.
- [ ] 3.3 `interruptSession` no cancelamento de turno.

### Trilha 4 · entrega idempotente

Arquivos: `apps/server/src/db/schema/**` (só a tabela nova), `apps/server/src/db/migrations/**` (só o arquivo gerado), `apps/server/src/modules/engine/services/turn-queue.service.ts`, `apps/server/src/modules/conversations/repositories/**` (se for onde o turno é gravado), testes ao lado.

- [ ] 4.1 Tabela, migration gerada, `deliveryHandled` por chave, `attempts: 2`.

### Trilha 5 · CLIs gerenciados (S5, independe das trilhas 1–4)

Arquivos: `packages/providers/src/managed.ts` (novo), `packages/providers/src/claude.ts` e `codex.ts` (só a resolução do binário), `apps/server/src/modules/providers/**` (novo: rotas, serviço, testes), `apps/server/src/app.ts` (só registrar as rotas), `apps/server/src/modules/auth/services/policy.service.ts` (rotas só dono), `apps/server/src/config/env.ts` (`BOTS_UPDATE_CHECKS`, `RBOTS_CLIS_DIR`), `apps/server/src/modules/environments/services/box-spec.service.ts` (montagem só leitura de `<dados>/clis`).

- [x] 5.1 `managedBinary` e uso no Claude e no Codex.
- [x] 5.2 Serviço de versões: instalada, última (cache e prazo), comparação.
- [x] 5.3 Atualizar e voltar com trava, `.tmp`, verificação, troca atômica e limpeza.
- [x] 5.4 Rotas e política; montagem na caixa.

