# Grok Bot por dentro: o que aprender para o runelay bots

Pesquisa de 19/11/2026, só leitura, no Mac (macOS 26). Grok Bot 1.2.3, CLI `grok` 1.0.77.
Fontes: o bundle (`app.asar`, extraído numa pasta temporária e apagado depois), `~/.grok`, `~/.grokbot`, `~/Library/Application Support/Grok Bot`, os processos e conexões, e a documentação da CLI que vem instalada em `~/.grok/docs/user-guide/`.
Não copiei código. Não guardei nenhum segredo nem conteúdo de conversa: nesta página aparecem só nomes de campos.

> **Achado de segurança no Mac:** `~/.grok/config.toml` guarda em texto puro o bearer do runelay (`mcp_servers.runelay.headers.Authorization = "Bearer rnl_***"`). Vale trocar por variável de ambiente ou keychain e rotacionar a chave.

---

## 0. Resumo em 6 linhas

1. **São dois produtos.** O *Grok Bot* (app Electron) roda o agente **na nuvem**, numa VM por usuário (a "SandBox"). O Mac é só mais um "computador do usuário" que a nuvem chama por um canal de saída. A *CLI `grok`* (binário Rust) é um harness local completo e fala **ACP** (Agent Client Protocol).
2. Os dois foram feitos pela **Anysphere (Cursor)**: o bundle id é `com.anysphere.sand`, os pacotes são `@anysphere/*` e as RPCs são `aiserver.v1.*`. O executor local é o mesmo do agente do Cursor.
3. Para o **modo código**, o que vale copiar está na CLI e no executor: worktree por sessão/subagente num registro SQLite, diff calculado pelo git contra uma base, aprovação em pipeline (hook → regras → grants lembrados → read-only automático → modo), comandos parseados com tree-sitter e **fail-closed**, e sandbox de kernel por perfil.
4. O **undo** deles só volta a conversa. `/rewind` **não restaura arquivos**, e a documentação diz isso com todas as letras. O código fica sob controle do git e do worktree.
5. **Voz:** WebSocket direto para `wss://api.x.ai/` no protocolo realtime, PCM 24 kHz. O segredo é efêmero e cunhado pelo servidor. VAD do servidor, AEC do navegador. Na interrupção, cancela a resposta e trunca o item no ponto que já tocou. A voz é um orquestrador leve que **delega** ao agente principal (`send_task`).
6. **Multiagente:** subagentes com tipo e capacidade (read-only, read-write, execute, all), isolamento opcional por worktree, profundidade 1 por padrão e mensagens entre agentes com 3 modos de entrega (`steer`, `queue`, `interject`). Nas salas, os turnos são pedidos pelo servidor com prazo.

---

## 1. Arquitetura

### Como o Grok Bot faz
- **App Electron.** Tem `Electron Framework.framework`, os helpers (GPU, Renderer, Plugin) e `Resources/app.asar` (58 MB). O `package.json` diz `name: "sand"`, `author: "SpaceXAI"`, `main: dist/electron-main/main.cjs`.
- **O que está dentro do asar** (`dist/`):
  - `electron-main/` (main-core, main-app, proto, local-meeting-recorder, menubar-tray)
  - `electron-preload/` (preloads separados por superfície: `preload-vnc`, `preload-webview`, `preload-desktop-mount-panel`, `preload-desktop-mount-capture-overlay`, `preload-spotlight-element-pick-overlay`, `preload-avatar-source`)
  - `local-exec-daemon/` e `node-agent-coordinator/`
  - `renderer/` (React, cerca de 700 chunks)
  - módulos nativos em `app.asar.unpacked` (`tree-sitter-bash`, `sand-window-capture`, `cursor-proclist`, `sand-webauthn-signer`, `sand-meeting-recorder`, 1Password)
- **Processos vivos:** o principal; GPU, renderer e rede; 2 utilitários `node.mojom.NodeService`, que são o daemon de execução local e o coordenador; serviço de áudio; serviço de vídeo; e o crashpad.
- **Nenhuma porta escutando.** `lsof -i` só mostra conexões **de saída** para 443 na AWS: o processo principal e os dois NodeService abrem conexões para a nuvem. Não existe servidor local que outro processo possa chamar.
- **Agente na nuvem.** As RPCs `aiserver.v1.SandBoxService` (`EnsureSandBox`, `RecreateSandBox`, `AdminHibernateSandBox`, `AdminSnapshotSandBoxStore`, `GetSandBoxRunState`…) e `aiserver.v1.GrokBotService` (cerca de 450 métodos) mostram que cada usuário tem uma VM ("box") com armazenamento em snapshot e hibernação. O app é cliente: manda mensagem (`SendGrokBotUserMessage`), observa o transcript (`WatchGrokBotTranscripts`, server-streaming), interrompe (`InterruptGrokBotAgentRun`) e volta a conversa (`RollBackGrokBotConversation`).
- **O Mac como "user computer".** A nuvem faz pedidos ao Mac por um canal que **o Mac abre**:
  - `WatchGrokBotUserComputerRequests` (stream)
  - `PollGrokBotUserComputerRequests`
  - `SubmitGrokBotUserComputerResponses`

  No daemon, isso é **SSE + POST**, com os eventos `local-exec-sse-connect`, `-sse-stall`, `-sse-reconnect`, `-response-post` e `-heartbeat`. O daemon se apresenta com `GrokBotUserComputerHello` (`label`, `local_root`, `terminals_folder`, `standing`, `supervised`, `capabilities`).
- **A CLI `grok` é outro produto.** Fica em `~/.grok/bin/grok` e `~/.grok/bin/agent`, que apontam para `downloads/grok-1.0.77-macos-aarch64` (Mach-O arm64). Fala **ACP** por stdio, por WebSocket ou num servidor `grok agent serve --bind … --secret …`, e grava log estruturado em `~/.grok/logs/unified.jsonl` (campos `ts, lvl, src, pid, sid, ctx, msg, ver`). O app **não** usa a CLI: o harness do app é o `@anysphere/grok-bot-harness` mais o `local-exec`. Os dois compartilham as ideias.

### Evidência
- `Info.plist` (`CFBundleIdentifier = com.anysphere.sand`, esquemas de URL `grokbot://` e `sand://`)
- `package.json` do asar
- `ps`
- `lsof -p 2906` e o mesmo nos NodeService
- os protos `GrokBotUserComputer*` em `local-exec-daemon/main.cjs`
- `~/.grokbot/local-exec-daemon.json` (`pid, startedAt, servingAt, inflightCount, filesKeyId, generation`) e `local-exec-supervisor.json` (`pid, at`)
- `~/.grok/docs/user-guide/15-agent-mode.md`

### O que o runelay bots deveria adotar
- **Canal de saída do Mac para o servidor**, não um servidor local. Hoje o v12 usa runner → `http://127.0.0.1:4791` com token em arquivo, e precisa do app aberto e de uma porta escutando. O desenho deles é melhor: o Mac abre o stream (SSE ou WebSocket), se apresenta com `hello` + `capabilities` + `generation`, recebe *frames* de pedido e responde por POST. Assim não tem porta exposta, a reconexão é simples e o servidor sabe quem está online (`ReportGrokBotClientPresence`, `last_seen_at_ms`).
- **Daemon supervisionado e versionado.** Os arquivos `local-exec-daemon.json` e `local-exec-supervisor.json` têm `generation` e `inflightCount`, e existe um `update-lease`. Isso permite trocar o executor sem matar o que está rodando.
- **Gates como arquivos marcadores.** O app escreve `local-computer-use-gate.json {isOn}`, `mac-device-tools-gate.json` e `mac-mail-tools-gate.json`, e o daemon lê antes de agir. O interruptor da UI vale mesmo se o daemon estiver em outro processo.

---

## 2. Harness de código

### 2.1 Isolamento (worktrees, pastas, sandbox)

**Como faz**
- **Worktrees num registro SQLite.** `~/.grok/worktrees.db` tem a tabela `worktrees`, com as colunas:
  - `id`, `path`, `source_repo`, `repo_name`
  - `kind` (padrão `session`), `creation_mode` (padrão `linked`)
  - `git_ref`, `head_commit`, `session_id`, `creator_pid`
  - `created_at`, `last_accessed_at`, `status` (padrão `alive`), `metadata`

  A tabela `meta` tem `schema_version`, `last_auto_gc_at` e `last_age_cursor`, ou seja, há **coleta automática por idade**. Também existe `grove/pin_gc_orphans.json` (pin contra o GC).
- **Ciclo de vida do worktree** pelas extensões ACP `x.ai/git/worktree/*`:
  - `create` (parte do HEAD)
  - `apply` (traz as mudanças para o checkout principal)
  - `remove`
- **"Grove"** redireciona pastas ignoradas pesadas (`node_modules`, `target`) para fora da árvore projetada (`grok worktree redirect add <wt> target bind`). Assim o worktree não reinstala tudo.
- **Subagente com `isolation: worktree`.** O resultado traz o caminho do worktree, e o pai decide quando fazer `apply`.
- **Sandbox de kernel por perfil** (Seatbelt no macOS, Landlock/bwrap no Linux): `off`, `workspace`, `read-only`, `strict`, `devbox`, mais perfis próprios com `extends`, `read_only`, `read_write`, `deny` (glob) e `restrict_network`.
  - Vale para **o processo inteiro**, é irreversível e fica **gravado com a sessão** (`summary.json.sandbox_profile`). Retomar com outro perfil é recusado.
  - Hoje está tudo em `off` nas 18 sessões do Mac.
- **Configs de hooks protegidos contra escrita** mesmo dentro do workspace: `.claude/settings*.json`, `.cursor/hooks.json`, `.grok/hooks/`, `~/.grok/config.toml`, `bundled/`. Isso fecha a escalada em que o agente se dá permissão escrevendo a própria config.
- **No executor do app:**
  - a política vem em camadas `perUser` / `perRepo` / `teamAdmin`, do tipo `workspace_readwrite` | `workspace_readonly` | `insecure_none`
  - tem uma lista de caminhos sensíveis negados (`.git/hooks/**`, `.git/config`, `.git/worktrees/*/gitdir`, `.cursor/**/permissions.json`…)
  - `resolveLinkedWorktreeSandboxGrants` libera o `.git` comum quando o cwd é um worktree ligado

**Evidência:** o schema de `worktrees.db`; `18-sandbox.md`; `16-subagents.md` § Isolation; `17-sessions.md` § Worktree Sessions; as strings `workspace_readwrite` e `insecure_none` e os padrões `.git/worktrees/*/commondir` em `local-exec-daemon/main.cjs`.

**Adotar.** O v19 (`apps/server/src/modules/code/services/workspace.service.ts`) já faz `git worktree add -b <branch> <path> <commit>` em `CODE_WORKTREES_DIR` e guarda `baseCommit`. Falta:
- **Registro persistente dos worktrees** (sessão, bot, base, status, último acesso) e **GC por idade**, com pin. Hoje um worktree órfão fica para sempre.
- **Operação explícita de `apply`/entregar** (merge, cherry-pick ou PR) separada de `close`.
- **Não reinstalar dependências a cada worktree.** Seguir a ideia do Grove: reaproveitar `node_modules` ou o cache. Atenção: a regra da casa proíbe symlink de `node_modules`, então o caminho é cache de pacotes ou `pnpm store`, não link.
- **Lista de caminhos protegidos** que o agente nunca escreve: `.git/hooks`, `.git/config`, `.claude/`, `.grok/`, `CLAUDE.md` de hooks, `.env*`. Checar no executor, não no prompt.
- **Perfil de isolamento gravado na sessão e imutável** durante ela.

### 2.2 Edições e diffs

**Como faz**
- O executor tem um protocolo tipado `ExecServerMessage` → `ExecClientMessage` com casos:
  - arquivos e busca: `shell_args`, `shell_stream_args`, `background_shell_spawn_args`, `write_args`, `delete_args`, `read_args`, `grep_args`, `ls_args`, `diagnostics_args`, `fetch_args`
  - computador e tela: `computer_use_args`, `record_screen_args`
  - subagentes e hooks: `subagent_args`, `subagent_await_args`, `execute_hook_args`
  - classificação e pré-checagem: `smart_mode_classifier_args`, `shell_allowlist_precheck_args`, `mcp_allowlist_precheck_args`, `web_fetch_allowlist_precheck_args`
  - git: `git_diff_request`
- **A escrita é o arquivo inteiro:** `WriteArgs {path, file_text|file_bytes, tool_call_id, return_file_content_after_write, plan_mode, confine_to_workspace}`. O patch é montado no servidor, e o cliente só aplica.
- **O resultado é tipado:** `WriteResult` = `success {path, lines_created, file_size, file_content_after_write?}` | `permission_denied` | `no_space` | `error` | `rejected`. O mesmo vale para `DeleteResult` (`file_not_found`, `not_file`, `file_busy`…).
- **O diff vem do git, sob demanda:** `GetDiffRequest {cwd, ref, base_ref, merge_base, target_paths, unified_context_lines, max_untracked_files, committed_only, compute_patch_id, max_response_bytes, max_files_with_contents, max_content_bytes, output_format}`. Não existe "snapshot antes/depois" guardado por edição: a verdade é o git contra uma base.
- **A sessão da CLI guarda** (`17-sessions.md`):
  - `updates.jsonl`: o stream de updates ACP, com conversa e tool calls
  - `chat_history.jsonl`, `system_prompt.txt`, `prompt_context.json`, `tool_definitions.json`
  - `plan.json`, `rewind_points.jsonl`, `signals.json`
  - `compaction_checkpoints/`
  - `subagents/<id>/meta.json`

  Tem também um índice FTS em `sessions/session_search.sqlite` (`session_docs` com `title`, `content`, `content_hash`).
- **No app, o transcript local é só uma réplica** (`sand-client-persistence/*.blob`, `transcript.replicas.<uuid>`, `{entries[{kind,id,seq,timestampMs,requestId,…}], acceptedSequenceHint, epochHint}`). A fonte é o servidor (`CommitGrokBotTranscriptEntries`). Os `kind` vistos:
  - `message` (`role`, `content`, `isStreaming`, `clientNonce`, `fromAgent`)
  - `send-message/*` (`text`, `attachment`, `widget`, `user-form`, `email-draft`, `connector`, `auto-review-approval`, `scm-connect`)
  - `event` (`automation-changed`, `name-changed`)
  - `notice`, `user-attachment`, `voice-call`
- **O código vai para PR** (`EnsureGrokBotPullRequestChat`, `send-message/scm-connect {intent, provider, repo}`).

**Evidência:** os protos `WriteArgs`, `WriteResult`, `WriteSuccess`, `DeleteResult` e `GetDiffRequest` em `local-exec-daemon/main.cjs`; o formato dos blobs de réplica.

**Adotar**
- **O v19 já está no caminho certo:** diff = `git diff -M <baseCommit>`, mais os não rastreados com `--no-index /dev/null`. Manter o git como fonte da verdade, sem banco de snapshots.
- **O `sweepEdits` (antes/depois por turno) serve para a timeline do chat,** não para o undo. Limitar como eles fazem: `max_files_with_contents`, `max_content_bytes` e `max_untracked_files` na chamada de diff, para um `npm install` acidental não explodir o evento.
- **Resultado de ferramenta com união tipada** (`success | rejected | permission_denied | error`), nunca string livre. A UI decide o selo por `kind`.
- **Gravar a sessão de código em arquivos separados por papel:** stream de eventos, histórico enviado ao modelo, prompt renderizado e definições de ferramenta. Isso facilita depurar "por que o bot fez X".

### 2.3 Comandos, dev servers e aprovação

**Como faz**
- **O comando é parseado com tree-sitter-bash** (`parsingResult.executableCommands[].fullText`, `simple_commands`, `has_input_redirect`, `has_output_redirect`). As regras casam **com cada segmento**. Se o parse falha ou não tem comando executável, o comando é bloqueado (**fail-closed**). A mensagem ao modelo diz que ele não pode pedir aprovação daquilo e deve seguir com a tarefa.
- **`ShellArgs`** traz `timeout`, `hard_timeout`, `timeout_behavior` (vira background quando estoura), `is_background`, `requested_sandbox_policy`, `classifier_result`, `smart_mode_approval`, `hook_approval_requirement`, `admin_command_denylist` e `file_output_threshold_bytes`. A saída grande vai para arquivo em `terminals_folder`.
- **`ShellStream`** é um stream de eventos `start | stdout | stderr | exit | backgrounded | rejected | permission_denied | sandbox_unsupported | hook_context`.
- **Dev server = comando em background.** `run_terminal_command` com `block_until_ms: 0` devolve um `task_id`; a saída é lida com `get_command_or_subagent_output`, há aviso no chat quando termina, e existe uma ferramenta `monitor` (script que observa log/arquivo) e `ForceBackgroundShell` para mandar ao fundo um comando que já está rodando.
- **Ordem da autorização** (`22-permissions-and-safety.md`):
  1. Hook `PreToolUse` (só pode negar)
  2. Regras `deny` > `ask` > `allow`
  3. Grants lembrados, por repositório
  4. Leitura automática (ferramentas read-only e uma lista fixa de comandos read-only, mais `mkdir`/`touch` simples)
  5. Política do modo: `default` (pergunta), `acceptEdits`, `auto` (classificador), `dontAsk`, `bypassPermissions` (always-approve)

  Comandos da "lista perigosa" perguntam de novo mesmo com grant lembrado.
- **"Auto-review" = classificador de IA** (`smart_mode_classifier_args {target, conversation_context}`). No app, o usuário dá instruções em linguagem natural (`settings.json.autoReviewInstructions {allowInstructions[], blockInstructions[], isEnabled}`). A aprovação vira um card no chat (`send-message/auto-review-approval {approval {requestId, surface, summary, summaryCopy{kind, params{serverDisplayName, action}}, reason, status, command}}`), resolvido por `ResolveGrokBotAutoReviewApproval {resolution, approved_command, apply_to_group, group_request_ids}`, que permite aprovar **um grupo de pedidos de uma vez**.
- **Cada frame de execução no Mac diz por que está autorizado:** `approval_id`, `authorized_by_standing`, `authorized_by_approval`. O daemon guarda `local-tool-approvals.json`, `approval-uses.json`, `spent-sends.json` e `retirements.json`, e tem `RetireApproval` para revogar. É aprovação **de uso contado**, não um "sim" eterno.

**Evidência:** `ShellArgs`, `ShellResult`, `ShellStream`, `BackgroundShellSpawnArgs`, `SmartModeClassifierArgs` e as mensagens fail-closed em `local-exec-daemon/main.cjs`; `GrokBotUserComputerExec`; `20-background-tasks.md`; `22-permissions-and-safety.md`; as chaves de `~/.grokbot/settings.json`.

**Adotar**
- **Trocar a allowlist por regex do v12** (`npm|pnpm|…|git status|diff|add|commit`, mais "contém sudo/rm -rf") por **parse de shell com tree-sitter-bash e checagem por segmento**. Hoje `git status; curl … | sh` passa na regex se casar o começo. Parse falhou = bloqueia.
- **Pipeline de aprovação explícito e na mesma ordem para todo tool.** O Jev (v5) entra no lugar do "auto-review": depois das regras duras e antes do card humano, nunca antes do `deny`.
- **Grants por repositório e por prefixo de comando**, com "sempre permitir `pnpm test` neste repo". Lista perigosa sempre pergunta. Aprovação com id, contador de uso e revogação.
- **Aprovação em grupo:** um card "Rodar estes 3 comandos?" quando o modelo pede vários em sequência.
- **Dev server como tarefa de primeira classe:** `background: true` devolve `taskId`, a saída vai para arquivo e o evento `code.task.exited` aparece no chat. Comando que passa do tempo vai para o background em vez de morrer.
- **Proteção de configuração** (§2.1) é o que impede o bot de se autoaprovar escrevendo `.claude/settings.json`.

### 2.4 Checkpoint e undo

**Como faz**
- **CLI:** `/rewind` (= `/undo`, ou Esc Esc) lista um ponto por prompt do usuário (`rewind_points.jsonl`) e trunca a conversa. **Não mexe nos arquivos.** A compactação guarda o estado em `compaction_checkpoints/`.
- **App:** `RollBackGrokBotConversation {agent_id, session_id}` e `StartFreshGrokBotConversation`. A VM tem snapshot e restauração do armazenamento, mas só por admin (`AdminSnapshotSandBoxStore` / `AdminRestoreSandBoxStoreSnapshot`).
- **Na prática,** o undo de código é o git: o worktree descartável, mais o PR.

**Adotar.** Aqui o runelay bots pode ser **melhor** que o Grok:
- **Checkpoint por turno = commit oculto no worktree** (`git stash create` ou `git commit-tree` numa ref `refs/runelay/<sessão>/<turno>`), gravado em `checkpoints.jsonl {turnId, ref, files}`. "Voltar a este ponto" faz `git read-tree`/`checkout` dessa ref **e** trunca a conversa. Barato, sem banco, e sobrevive a reinício.
- **`revertFile` (já existe) continua sendo o undo por arquivo,** e o "voltar turno" é o undo do conjunto.
- **Deixar claro na UI** o que volta (conversa, arquivos ou os dois). O Grok acerta ao avisar que só volta a conversa.

---

## 3. Chamada de voz

**Como faz**
- **Transporte:** WebSocket **direto do renderer** para `wss://api.x.ai/` (a única origem permitida é `DIALABLE_ORIGIN`). O protocolo é o realtime no estilo OpenAI:
  - `session.update`, `input_audio_buffer.append`, `input_audio_buffer.speech_started`/`speech_stopped`
  - `response.create`, `response.cancel`, `response.output_audio.delta`, `response.output_audio_transcript.delta`
  - `conversation.item.truncate`, `conversation.item.input_audio_transcription.*`
  - `response.function_call_arguments.done`
- **Áudio:** `audio/pcm`, 24 kHz mono, blocos de 2048. Transcrição `grok-transcribe`.
- **Credencial:** `MintSandVoiceCallSecret`. O servidor cunha um segredo **efêmero**, e a chave real nunca chega ao cliente.
- **Eco:** `getUserMedia({echoCancellation, noiseSuppression, autoGainControl})` (o AEC do Chromium) mais um `speakerTap`, que serve de referência do que está tocando. Há telemetria de falha de captura (`input_format_empty`, `voice_processing_off`, `tap_refused`).
- **Turnos:** a VAD é **do servidor** (`speech_started`). O cliente guarda `playbackCursor` e `speakingSpans`. Na **interrupção** ele:
  1. para o áudio agendado
  2. manda `response.cancel`
  3. manda `conversation.item.truncate` no ponto que já tinha tocado, para o modelo "esquecer" o que não foi ouvido
- **Entrega de resultados** (`VoiceCallResponseGate`):
  - cada resultado do agente que precisa ser falado vira uma "dívida" (`owed`)
  - ele é pago quando o modelo de voz responde
  - ou é descartado com motivo: `dropped_caller_barged_in`, `dropped_answered_live`, `dropped_superseded`, `dropped_caller_holds`, `dropped_line_dead`, `dropped_call_closed`
  - os tipos são `outcome | greeting | steer | bare`
- **A voz é orquestradora.** As ferramentas do modelo de voz são `send_task` (delega ao agente principal), `recall_text_messages`, `end_the_call`, `transfer_the_call` e `stay_silent`. Os "nudges" são o agente principal pedindo para a voz falar algo. As métricas incluem `send_task_duration_ms_*`, `thinking_notes_received_count`, `results_landed_count`, `stay_silent_count`, `barge_in_overlap_ms_*`, `interruptions` e `reconnects`.
- **O registro no transcript** é `voice-call {call{callId, realtimeConversationId, durationMs, ending, turnCount, nudgeCount, answeredNudgeCount}, conversation{turns, nudges, events, toolCalls, overheard}}`. "Overheard" é a fala ouvida que não virou turno.
- **Rede:** a reconexão tem backoff (`maxConnectingAttempts:3`, `maxSilentPathRedials:3`, `dialTimeoutMs:15000`, fator 1.2).

**Evidência:** `renderer/assets/index.eager-app-*.js` (classe do socket realtime, `DIALABLE_ORIGIN`, constantes de 24 kHz, `VoiceCallResponseGate`, nomes das ferramentas); `main-core.cjs` (a mesma máquina de estados e a telemetria); `MintSandVoiceCallSecret` no proto; o formato de `voice-call` nos blobs.

**Adotar** (comparando com o v13, ElevenLabs Scribe + TTS e turnos no app):
- **Interrupção com truncamento.** Hoje o v13 chama `interrupt` e fecha o contexto de TTS, mas o histórico do bot continua com a frase inteira. Mandar ao servidor **quanto foi ouvido** (ms ou caracteres) e cortar o texto da mensagem nesse ponto.
- **Fila de "dívidas" de fala com motivo de descarte.** Resultado que chega enquanto a pessoa fala espera, e resultado que ficou velho é descartado com motivo. Isso evita o bot "despejar" um resultado antigo depois de uma interrupção.
- **Voz como camada fina que delega** (`send_task`) em vez de rodar o turno pesado no caminho da fala. O agente principal manda "notas de pensamento" que a voz pode verbalizar curto.
- **AEC do sistema primeiro.** No Mac nativo, isso é `AVAudioEngine` com voice processing ligado no input node. O half-duplex e o filtro por sobreposição de texto do v13 ficam como reforço, não como mecanismo principal. A telemetria `voice_processing_off`/`tap_refused` deles bate com o problema "input ligado no mixer zera o tap" que já vimos.
- **Segredo efêmero cunhado pelo servidor** (o v13 já faz `tokens`). Manter.

---

## 4. Uso do computador e navegador

**Como faz**
- **Duas coisas diferentes:**
  - **"Computer" da nuvem:** a VM do agente tem desktop virtual e navegador, e o app mostra isso por **VNC** (`preload-vnc.cjs`). Os diagnósticos do app testam `computer-dns`, `computer-tls`, `computer-health`, `computer-events` e `computer-screen-websocket`. Há "lease" de desktop (`desktop_lease_actor_id`) e `mark_monitor_busy`, para a pessoa e o bot não brigarem pelo mouse.
  - **O Mac do usuário:** um helper nativo separado, `Contents/Helpers/Grok Bot Computer Use.app` (`co.anysphere.grok-bot-computer-use`, executável `CUGrokBotService`, `LSUIElement`). **As permissões do sistema (Acessibilidade, Gravação de Tela, Automação, Contatos, Calendário, Lembretes, Localização) ficam no helper**, cada uma com texto de uso explicando para o usuário.
- **Ferramentas locais.** As de computador são `computer_screenshot`, `computer_open`, `computer_apps`, `computer_app_state` e `computer_check_permissions`. As de apps do Mac são `mac_read_mail`/`mac_draft_mail`/`mac_send_mail`, `mac_read_notes`/`mac_write_notes`, `mac_read_obsidian`/`mac_write_obsidian`, e Mensagens com consentimento próprio (`MessagesConsentResult`). Ler e escrever ficam **separados**, e enviar é outra permissão (`macMailSendEnabled`, `messagesSendEnabled`).
- **`ComputerUseArgs`** traz `actions[]` (lote de ações), `screenshot_settle_ms`, `omit_inline_screenshot`, `full_resolution_screenshot` e `capture_name_prefix`.
- **Pedido de permissão local:**
  - `LocalToolCall` → `LocalToolPermissionPending {reason}`
  - o usuário resolve no app (`ResolveGrokBotLocalToolPermission`)
  - vem `LocalToolAccepted` → `LocalToolResult`

  Os "standing grants" (permissão permanente) têm teto (`local-tool-permission-ceiling`).
- **Presença na tela ("ilha").** Não encontrei "aura" no bundle. O que existe é o **"desktop mount"**: um painel flutuante do bot no desktop (`preload-desktop-mount-panel`, RPC `desktop-mount.mount {agentId, name, markSvgDataUrl, shape, ink, userBubble}`, `unmount`, `offerChoices`). Ele mostra o "selo" do bot, a fala dele e **botões de escolha** ali mesmo. Também existem um overlay de captura e um seletor de elemento na tela (`spotlight-element-pick-overlay`), para o usuário **apontar** o que quer.
- **Credenciais:** o bot pede por formulário seguro (`send-message/user-form {formRequest{secureValues, reason:auth, domains, fields[], vaultKind, saveAvailable}}`). O valor vai para o cofre, com prazo (`secureValuesExpiresAtMs`), e nunca para o transcript. Há integração com 1Password.

**Evidência:** `Info.plist` do helper; as strings `computer_*`/`mac_*` e `local-tool-*` no daemon; os protos `GrokBotUserComputerLocalTool*` e `ComputerUseArgs`; `desktop-mount` em `main-app.cjs`; os gates em `~/.grokbot/*.json`; o formato de `user-form` nos blobs.

**Adotar** (comparando com o v11/v12/v15):
- **Permissões do macOS num helper dedicado e assinado** (LSUIElement), com textos de uso claros, separado do app de chat. Reinstalar ou atualizar o app não derruba a concessão de Acessibilidade e Gravação de Tela.
- **Ler, escrever e enviar como capacidades separadas** por app (Mail, Mensagens, Notas). Hoje o v12 usa regra de texto no AppleScript ("menciona send/deliver"). Ferramentas próprias por app, com o "enviar" gateado à parte, são mais seguras do que analisar AppleScript.
- **Ações em lote** com `settle_ms` e captura opcional, para menos idas e voltas.
- **Lease de controle.** O `user_took_over` do v12 já é isso. Formalizar como lease (quem segura o mouse, até quando) e mostrar na ilha.
- **Ilha = painel com escolhas,** não só aura. Pôr os botões de aprovação do v15 (com `previewImage`) **na própria ilha**, para a pessoa aprovar sem trocar de janela, e o "apontar na tela" para a pessoa mostrar o elemento.
- **Formulário seguro para segredo** (senha/token) em vez de pedir no chat.

---

## 5. Multiagente

**Como faz**
- **Subagentes na CLI** (`16-subagents.md`):
  - o modelo chama `spawn_subagent {subagent_type, prompt, run_in_background (padrão true), isolation: none|worktree, cwd, resume_from}`
  - os tipos embutidos são `general-purpose`, `explore` e `plan`
  - **personas** em TOML (`implementer`, `reviewer`, `test-writer`, `security-auditor`, `design-doc-writer`…) mudam as instruções e os contratos de entrada e saída
  - **modos de capacidade:** `read-only`, `read-write` (sem shell), `execute` (shell sem edição) e `all`
- **Profundidade padrão = 1:** só a sessão raiz cria subagentes.
- **Mensagens entre agentes:** `send_subagent_message {delivery: steer|queue|interject}`. Há cotas (4 em voo por par e 32 por tentativa) e o status do envio (`sending`, `not delivered: <motivo>`, `unconfirmed`).
- **Resultado e espera:** `get_command_or_subagent_output {task_ids[≤20]}`, `SubagentAwaitArgs {agent_id, timeout_ms}`, `ForceBackgroundSubagent`, e `fork_agent_id`/`resume_agent_id` para bifurcar ou retomar.
- **No app (nuvem):**
  - salas de grupo com **turno pedido pelo servidor**: `RequestGrokBotRoomMemberTurn {room, member_agent_id, peers, new_messages, is_winding_down, deadline_ms}`, e o membro responde com `DeliverGrokBotRoomMemberTurnResult {outcome, messages, posts}`
  - `ListGrokBotSubagents`, tarefas e todos por agente, automações e rotinas
  - "factories" (`RunGrokBotFactory`) para criar bots em série
- **Workflows** em script (`bundled/workflows/*.rhai`, sendo migrados).

**Evidência:** `~/.grok/bundled/{agents,personas,roles,workflows}`; `16-subagents.md`; os protos `SubagentArgs`, `SubagentAwaitArgs`, `RequestGrokBotRoomMemberTurnRequest` e `DeliverGrokBotRoomMemberTurnResultRequest`.

**Adotar** (comparando com o v9, grupos, e o `delegate`):
- **No modo código, subagente com capacidade declarada e worktree próprio** quando escreve (o implementador), e sem worktree quando só lê (explorar/revisar). O pai faz `apply` do worktree do filho, nunca o filho direto no principal.
- **Três modos de entrega de mensagem** (`steer`, `queue`, `interject`) para o usuário ou o pai falarem com um bot no meio do turno. Hoje o envio no meio do turno não tem semântica definida no protocolo.
- **Turno de grupo com prazo e `is_winding_down`.** Cada membro recebe só as mensagens novas, mais a lista de pares e um deadline. Evita conversa infinita entre bots e dá um fim limpo.
- **Profundidade 1 por padrão e cotas de mensagem** entre agentes.

---

## 6. Comparação direta com o v19 (modo código, `apps/server/src/modules/code/services/workspace.service.ts`)

O PROTOCOL.md (hoje em docs/protocol/) ainda não tinha a seção v19. O que existe está no código:

| Tema | runelay v19 hoje | Grok | Lacuna |
|---|---|---|---|
| Isolamento | 1 worktree por sessão, branch nova, `baseCommit` | worktree por sessão **e** por subagente, num registro SQLite com GC | registro, GC, worktree por subagente |
| Dependências | `startInstall` a cada worktree (evento `code.install`) | Grove redireciona `node_modules`/`target` | cache compartilhado sem symlink |
| Diff | `git diff -M baseCommit` mais os não rastreados | `GetDiffRequest` com base/merge-base e limites de tamanho | limites (`max_*`) |
| Edição visível | `sweepEdits` antes/depois por turno | write com o arquivo inteiro e resultado tipado | resultado tipado |
| Undo | `revertFile` por arquivo | `/rewind` só da conversa; git/PR | **checkpoint por turno com ref git** (dá para superar) |
| Comandos | allowlist por regex (v12) | tree-sitter, por segmento, fail-closed | parse real |
| Aprovação | Jev + regras + card (v5/v15) | hook → regras → grants → read-only → modo/classificador; aprovação em grupo; uso contado | ordem fixa, grants por repo, grupo |
| Dev server | — | background com `task_id`, saída em arquivo, `monitor` | tarefa em background de primeira classe |
| Entrega | `closeWorkspace` | `apply` do worktree / PR | apply/PR explícito |
| Proteção | — | config de hooks e `.git` protegidos contra escrita | lista de caminhos protegidos |

---

## Recomendações para o modo código (em ordem de impacto)

1. **Parse de shell com tree-sitter-bash, checagem por segmento e fail-closed.** Substitui a allowlist por regex: hoje `git status && curl … | sh` e afins escapam. É o maior buraco de segurança do modo código.
2. **Pipeline de aprovação único e ordenado para todo tool:** regras duras (`deny`) → caminhos protegidos → grants lembrados por repo/prefixo → read-only automático → Jev → card humano. Com aprovação **em grupo** ("rodar estes 3?"), id e contador de uso por aprovação, e a lista perigosa sempre perguntando.
3. **Checkpoint por turno como ref git oculta** (`refs/runelay/<sessão>/<turno>`), com "voltar a este ponto" restaurando **arquivos e conversa**, e dizendo na UI o que volta. Com isso o runelay fica melhor que o Grok, que só volta a conversa.
4. **Proteger contra escrita** `.git/hooks`, `.git/config`, `.claude/**`, `.grok/**`, `.cursor/**`, `.env*` e a config dos próprios bots, checando no executor. Fecha a autoescalada.
5. **Registro de worktrees** (sessão, bot, repo, base, status, último acesso) e **GC por idade** com pin; e **`apply`/PR explícito** separado de `close`.
6. **Dev server e comando longo como tarefa em background:** `taskId`, saída em arquivo, evento ao terminar, `monitor` de log, e estouro de tempo indo para o background em vez de matar.
7. **Subagente com capacidade declarada** (`read-only | read-write | execute | all`) e worktree próprio quando escreve. Profundidade 1 por padrão, e o pai faz o merge.
8. **Mensagem no meio do turno com `steer | queue | interject`.** Hoje o usuário não tem como corrigir o rumo sem cancelar.
9. **Resultados de ferramenta como união tipada** (`success | rejected | permission_denied | timeout | error`) e diffs com limites (`maxFiles`, `maxBytes`, `maxUntracked`).
10. **Perfil de isolamento gravado na sessão e imutável** (no VPS: rodar o shell do bot com bwrap/Landlock no perfil `workspace`: lê tudo, escreve no worktree e no tmp, nega `~/.ssh` e `**/.env`).
11. **Canal de saída do Mac para o servidor** (SSE/WS mais `hello` com capacidades, presença e geração) no lugar do executor HTTP em `127.0.0.1:4791`, com gates do app como arquivo marcador. Isso vale para o v12 e para um futuro modo código rodando no Mac.
12. **Sessão gravada por papel** (eventos, histórico enviado ao modelo, prompt renderizado, ferramentas) e busca FTS nas sessões, para depurar e para a memória.
