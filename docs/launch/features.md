# r/bots: inventário de recursos

Lista do que existe hoje na `main`, agrupada por área, para o vídeo de lançamento, a página do produto e a conversa com quem chega no projeto. Cada linha diz o que a pessoa vê e onde o código mora.

**Status**

- ✅ **pronto**: tem contrato em [docs/protocol](../protocol/README.md) com seção "Verificado" (rodado contra o servidor real) ou está em uso diário desde o início, sem correção em aberto.
- 🧪 **experimental**: entrou nas últimas horas sem verificação registrada, depende de algo que a imagem padrão não traz (CLI, permissão do macOS, conector) ou o próprio contrato aponta limitação conhecida.

Caminhos: `server/` = `apps/server/src/modules/`, `mac/` = `apps/mac/Sources/RunelayBots/Features/`, `providers/` = `packages/providers/src/`.

---

## 1. Login, conta e primeiro acesso

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Primeiro dono | Servidor novo abre a tela "Primeiro acesso": a primeira pessoa cria a conta de dono, uma vez só | `server/auth`, `mac/Onboarding/SignInScreen.swift`, [auth.md](../protocol/auth.md) v36 | ✅ |
| Login obrigatório | Toda rota, stream e WebSocket pede sessão ou chave; só `/health` e as rotas de login ficam abertas | `server/auth`, `mac/Auth/AuthGate.swift`, v41 | ✅ |
| Tela de login dividida | E-mail e senha (8+ caracteres), "Manter conectado", provedores sociais quando configurados | `mac/Onboarding/SignInScreen.swift`, v42 | ✅ |
| Touch ID (passkey) | Entrar com a digital, pelo navegador | `server/auth` (better-auth passkey), v32 | ✅ |
| Login pelo navegador (`/device`) | Código mostrado no app e confirmado numa página com aviso anti-golpe | `server/auth`, v42/v51 | ✅ |
| Convites | Depois do dono, gente nova só entra por convite dele | `server/auth`, v32 | ✅ |
| Foto e nome da conta | Barra da conta no rodapé da lateral, foto e troca de nome em Ajustes | `mac/Auth/AccountSettings.swift`, `mac/Sidebar/SidebarAccountBar.swift`, v37 | ✅ |
| Troca de senha e sair | Em Ajustes › Conta | `mac/Auth`, v36 | ✅ |
| Mac como dispositivo | Depois do login o Mac se registra; Ajustes › Dispositivos lista e revoga | `server/devices`, `mac/Devices`, `mac/Settings/DevicesSettings.swift`, v38 | ✅ |
| Rotas só do dono | Integrações, cofre, contas, criação de bot: membro convidado recebe "Só o dono da conta pode fazer isso." | `server/auth`, v51 | ✅ |

## 2. Onboarding (guia de configuração)

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Guia em trilho de passos | Só em servidor vazio: Perfil → Primeiro bot → IA dos bots → Integrações → Conectores → Liberar o Mac | `mac/Onboarding/SetupGuide.swift`, `OnboardingStore.swift` | ✅ |
| Detecção de contas de IA | Passo "Qual IA os bots vão usar?" acha as pastas logadas do Claude e do Codex no servidor, com "Procurar de novo" | `server/accounts`, v47 | ✅ |
| Reabrir o guia | Ajustes › Conta reinicia o guia | `mac/Onboarding` | ✅ |

## 3. Perfis de servidor

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Vários servidores | Perfis (ex.: Local e VPS) com login próprio cada um | `mac/../Stores/ServerProfiles.swift`, `mac/Sidebar/ServerProfileSwitcher.swift` | ✅ |
| Troca rápida | Seletor no topo da lateral, menu Servidor, `⌃⌘1…9` | `App/RunelayBotsApp.swift` | ✅ |
| Tela "servidor desatualizado" | App novo contra servidor velho avisa em vez de quebrar | `mac/Auth/AuthGate.swift` | ✅ |

## 4. Bots

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Criar bot com só um nome | Nome, rosto e cor; o bot chega com uma saudação fixa e pergunta o que fazer | `server/bots`, `mac/Profile/BotEditorView.swift`, v6.1 | ✅ |
| Bot se configura | Pedido em conversa vira papel, instruções e rotinas (`set_role`, `update_instructions`, `add_schedule`) | `server/bots`, v6 | ✅ |
| Bot muda qualquer ajuste | Tudo que a tela de Ajustes faz, por conversa ou voz, com linha "Desfazer" (`settings_get`, `bot_update`…) | `server/settings/services/settings-tools.service.ts`, `mac/Conversation/Views/SettingsChangeLine.swift`, v52 | ✅ |
| Personagem / rosto | Rostos em pontos (`crown`, `visor`, `antenna`, `face-1…11`) e 11 cores | `mac/Character/BotCharacter.swift`, `CharacterGlyph.swift` | ✅ |
| Lateral, seções, fixar, arquivar, excluir | Seções nomeadas, bot fixado, arquivo e lixeira com restaurar | `server/sections`, `server/bots`, `mac/Sidebar`, v7 | ✅ |
| Grupos | Conversa com 2–8 bots; menção escolhe quem fala, sem menção o Jev escolhe; `handoff` entre eles | `server/groups`, `mac/Profile/GroupEditorView.swift`, v9 | ✅ |
| Provedor Claude | Turno no Claude Agent SDK com a assinatura logada (sem API key) | `providers/claude.ts` | ✅ |
| Provedor Codex | Turno no Codex CLI, também como reserva | `providers/codex.ts` | ✅ |
| Provedores Grok e Cursor | Adaptadores prontos; a CLI não vem na imagem Docker e a descoberta de contas por pasta só olha Claude e Codex | `providers/grok.ts`, `providers/cursor.ts` | 🧪 |
| Modelo e esforço por bot | Seletor de conta, modelo e esforço na conversa | `mac/Conversation/Views/ModelPickerPanel.swift` | ✅ |
| Contas por pasta | Cada `~/.claude*` e `~/.codex*` logado no servidor vira uma conta, com nome e padrão | `server/accounts`, `mac/Accounts/AccountsScreen.swift`, v47 | ✅ |
| Failover entre contas | Limite ou conta fora do ar: o mesmo turno continua na outra conta do provedor, depois na reserva; linha "Limite do Claude acabou · continuei com Codex" e volta sozinha | `server/accounts/services/limits.service.ts`, v26/v47 | ✅ |
| Handoff de contexto | Ao trocar de conta ou modelo, o bot recebe um resumo da conversa e lê itens antigos com `thread_read` | `server/conversations/services/handoff.service.ts`, v26 | ✅ |

## 5. Conversas

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Várias conversas por bot | Thread principal mais quantas conversas quiser, cada uma com histórico, fila e worktree | `server/conversations`, v29 | ✅ |
| Abas | Um bot por aba, `⌘T`, `⌘W`, `⇧⌘T`, `⌘1…9`, arrastar para reordenar; só a aba ativa faz stream | `mac/Tabs` | ✅ |
| Busca nas conversas | Busca por texto sem acento no Postgres | `server/conversations`, v40 | ✅ |
| Abrir na hora | Conversa abre do cache local e completa pelo servidor | `mac/Conversation/Stores/TranscriptCache.swift` | ✅ |
| Transcrição virtualizada | Conversa longa rola liso, mensagens longas dobram | `mac/Conversation/Views/TranscriptScrollView.swift`, `MessageFold.swift` | ✅ |
| Mensagem no meio do turno (steer) | Mandar mensagem com o bot trabalhando entra no turno em curso em vez de esperar | `server/engine/services/engine.service.ts` (`steerTurn`) | 🧪 |
| Conversas secundárias (`/side`) | `/side` abre uma conversa filha com o contexto da mãe num painel ao lado; o resultado volta para a mãe | `server/engine/services/side-threads.service.ts`, `mac/Conversation/Views/SideThreadPanel.swift`, v55 | 🧪 |
| Perguntas estruturadas (`ask_user`) | O bot pergunta com opções num card no lugar do campo de mensagem, em passos (wizard) | `server/questions`, `mac/Conversation/Models/QuestionWizard.swift`, `QuestionCard.swift`, v49 | ✅ |
| Aprovações legíveis | Card em português claro com o que o bot quer fazer e por quê; Jev aprova o rotineiro | `server/approvals`, `mac/Conversation/Views/ApprovalCard.swift`, v5/v15 | ✅ |
| Modo de permissão por conversa | Somente leitura, Editar, Padrão, Acesso total; subir o modo sempre pede card | `server/approvals`, `mac/Conversation/Views/PermissionPill.swift`, v29/v52 | ✅ |
| Ilha (island) | Com o app em segundo plano, aprovação e pergunta aparecem numa forma preta no topo da tela e viram o card | `mac/Computer/Executor/IslandPrompt.swift` | 🧪 |
| Anexos nos dois sentidos | Imagem, vídeo (transcrição + quadros), áudio (transcrito), PDF/DOCX/XLSX; o bot manda arquivo de volta | `server/uploads`, `mac/Conversation/Views/AttachmentViews.swift`, v22/v51 | ✅ |
| Skills no composer | `/` lista skills; ficam como token na mensagem | `server/skills`, `mac/Conversation/Views/SlashMenu.swift`, v16 | ✅ |
| Ditado | Segurar `⌥Espaço` para falar no campo de mensagem, transcrito no próprio Mac | `mac/Voice/VoiceInput.swift` | ✅ |
| Limpar e restaurar conversa | Arquiva a thread e começa limpa, com volta | `server/conversations`, v17 | ✅ |
| Delegação entre bots | Um bot pede trabalho a outro (`delegate`); a tarefa roda na conversa do delegado e volta com arquivos | `server/engine`, `mac/Conversation/Views/DelegationViews.swift`, v24 | ✅ |
| Boss | Não é bot fixo: é o nome convencional do bot que coordena os outros (todo bot novo pode delegar aos demais); o Review usa o bot chamado "Boss" por padrão | `server/review/services/review.service.ts` | ✅ |

## 6. Modo código

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Repositórios liberados | O bot pede para trabalhar num repo com um card (`workspace_add`) e lembra o que o repo é | `server/code`, v34 | ✅ |
| Worktree por conversa | Branch `feat/<slug>` e worktree próprias por conversa | `server/code`, v19 | ✅ |
| Vários repos na mesma conversa | Uma pílula por repo aberto, empilhadas | `server/code`, `mac/Code/Views/CodeWorkspaceViews.swift`, v54 | ✅ |
| Diff ao vivo | Edição aparece como diff enquanto o bot escreve; painel Mudanças pela base de merge | `server/code`, `mac/Code/Views/DiffHunkText.swift`, v19.1/v54 | ✅ |
| Checkpoints | Voltar arquivos e conversa juntos a um turno anterior | `server/code`, v19 | ✅ |
| Commit, push e PR | `workspace_deliver`; tira assinatura de IA e recusa `push --force` em main/develop | `server/code`, v25 | ✅ |
| Faixa de PR e CI | PR, estado do CI e review na própria conversa | `server/code/services/pull-request.service.ts`, `mac/Code/Views/PullRequestViews.swift`, v27 | ✅ |
| Terminal real | Todo bot Claude da VPS tem Bash; leitura de produção só por comando somente leitura, escrita passa pela guarda | `server/code`, v50 | ✅ |
| Sandbox de ferramentas | Comandos do modelo em usuário separado, sem hooks de git do repo | `apps/server/rb-sandbox-exec.sh`, v51 | ✅ |
| Servidores de desenvolvimento | "Rodar projeto": perfis, repo + worktree + script; logs ao vivo com cores; um servidor por pasta | `server/servers`, `mac/Servers`, v48 | ✅ |
| Prévia com barra de endereço | Painel ao lado com a página do dev server, barra de endereço, abrir no navegador com link de uso único | `mac/Servers/Views/PreviewAddressBar.swift`, `ServerPanel.swift` | 🧪 |
| Simuladores | Espelho do iPhone/Android do Mac no painel, abrir app Expo pela ponte do Metro | `server/simulators`, `mac/Simulators`, v53 | 🧪 |
| Testes Maestro e Playwright | O bot roda o flow ou a spec e mostra o card `test.result` com passos e prints; Playwright tem orçamento por turno | `server/tests`, `mac/Tests/TestViews.swift`, v53/v56 | 🧪 |

## 7. Uso do computador e navegador

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Navegador do bot | Chromium por bot com perfil persistente (logins ficam), padrão para tarefa web; print volta como imagem | `server/browser`, b97ec63 | ✅ |
| Navegador ao vivo e operável | Ver e assumir o navegador do bot no painel Computador | `server/browser`, `mac/Computer/Views/BrowserCanvas.swift`, v4 | ✅ |
| Saída de rede protegida | `browser_open` e `http_request` só em IP público, com proxy por bot | `server/browser`, v51 | ✅ |
| Uso do seu Mac | Print, árvore de acessibilidade, clique, digitação, AppleScript e arquivos em pastas liberadas, com aura e cursor do bot na tela | `mac/Computer/Executor/*`, `server/computer`, v12 | 🧪 |
| Pausa quando você mexe | Se a pessoa usa o Mac, o bot pausa em vez de cancelar | `mac/Computer/Executor/ComputerExecutor.swift`, 4c3a4db | 🧪 |
| Computador virtual | Desktop Linux (Xvfb) por bot no servidor, ao vivo no painel | `server/browser`, v11 | 🧪 |

## 8. Rotinas e fila

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Rotinas por bot | "Todo dia útil às 9h…" vira cron; resultado cai na thread; pausar e rodar agora | `server/schedules`, `mac/Routines/RoutinesScreen.swift`, v2/v52 | ✅ |
| Triagem de rotina | Resultado sem novidade fica quieto | `server/approvals` (Jev), 0f9f928 | ✅ |
| Fila de jobs | Turnos, rotinas, exportações e captura de memória sobrevivem a reinício; falhos com "tentar de novo" | `server/jobs`, v39 | ✅ |

## 9. Integrações e conectores

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Integrações pelo app | ElevenLabs, Jev e runelay colados em Ajustes › Integrações, validados e cifrados; sem cada um, só aquela parte desliga | `server/integrations`, `mac/Settings/IntegrationsSettings.swift`, v35 | ✅ |
| Formulário seguro de integração | O bot abre o formulário (`integration_setup`) e a chave nunca passa pelo modelo | `mac/Conversation/Views/IntegrationFormCard.swift`, v52 | ✅ |
| Conectores runelay | Linear, GitHub, Supabase, Google Calendar… nas ferramentas de todo bot | `server/connectors`, v8 | ✅ |
| Catálogo de conectores | Buscar e instalar conectores pelo app; `connector_connect` pelo bot | `mac/Connectors`, v14 | ✅ |
| Jev | Camada de decisão: aprova o rotineiro, escolhe quem fala no grupo, filtra memória | `server/approvals`, v5 | ✅ |

## 10. Voz

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Chamada de voz | Ligar para um bot; uma camada rápida (Haiku numa sessão quente) responde em ~0,5 s enquanto o bot trabalha | `server/voice`, `mac/Call`, v13 | ✅ |
| Voz ElevenLabs | Fala com voz escolhida por bot, transcrição em tempo real | `server/voice`, v13 | ✅ |
| Desligar por voz | "Pode desligar" encerra a chamada com despedida | v45 | ✅ |
| Perguntas na chamada | `ask_user` também vira pergunta falada | v49 | ✅ |
| Escolha de microfone | Seletor de microfone | `mac/Voice/Microphones.swift`, v25 | ✅ |

## 11. Blocos e artefatos

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Notas | Notas estilo Obsidian com links `[[ ]]`, backlinks, busca e lixeira | `server/notes`, `mac/Notes`, v31 | ✅ |
| Planilhas | Planilha com fórmulas em português e inglês calculadas no servidor | `server/sheets`, `mac/Sheets`, v31 | ✅ |
| Agenda | Visão de dia e semana do Google Calendar pelo conector, no fuso da pessoa | `server/agenda`, `mac/Agenda`, v31/v44/v46 | ✅ |
| Exportar | Nota em DOCX/PDF/MD, planilha em XLSX/CSV/PDF | `server/exports`, v31 | ✅ |
| Painel dividido | Bloco, artefato, prévia e simulador abrem ao lado da conversa, `⇧⌘F` tela cheia | `mac/Blocks/Views/BlockPanel.swift` | ✅ |
| Artefatos HTML | Páginas que o bot publica, versionadas, com PDF e miniatura viva | `server/artifacts`, `mac/Artifacts`, v18 | ✅ |
| Canvas | Diagrama editável (bot e pessoa), traço à mão, mapa mental e fluxo com layout automático | `server/canvas`, `mac/Artifacts/Views/CanvasViews.swift`, v20 | ✅ |
| Geração de imagem | Bots no Codex geram imagem nativamente e ela volta como anexo | `providers/codex.ts`, 884eec5 | 🧪 |
| Recorte de imagem (`image_cutout`) | Tira o fundo de uma imagem (modelo de matting local) e devolve PNG transparente | `server/images/services/cutout.service.ts`, 4f94999 | 🧪 |
| Áudio falado (`speech_create`) | Bot gera MP3 com a voz dele na ElevenLabs (chave da integração, nunca exposta) e anexa na conversa | `server/voice/services/speech-tools.service.ts` | 🧪 |

## 12. Cofre e segurança

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Cofre de segredos | Segredo chamado por apelido; o valor fica no Keychain do Mac e só entra na ferramenta | `server/vault`, `mac/Vault`, v23 | ✅ |
| Pedir segredo | `request_secret` abre um campo seguro na conversa | `mac/Conversation/Views/SecretFormCard.swift` | ✅ |
| Cofre trancado | Ajustes › Cofre pede Touch ID; Mostrar some em 20 s, Copiar limpa em 60 s | `mac/Vault/VaultLock.swift` | ✅ |
| Cópia no servidor (opcional) | "Usar com o Mac fechado": AES-256-GCM com chave fora do repo | `server/vault`, v51 | ✅ |
| Máscara | Valor de segredo vira `••••` em evento, log e saída de comando | `apps/server/src/shared/redact.ts` | ✅ |
| Guarda de produção | Deploy, escrita em banco, dinheiro e mensagem para fora passam pelo Jev ou por você, mesmo em Acesso total | `server/approvals`, v52 | ✅ |

## 13. Uso e limites

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Anéis de uso | Um anel por conta de IA na barra de ícones | `mac/Usage/UsageRings.swift` | ✅ |
| Tela de Uso | Limites, tokens e custo por provedor e conta, por período | `server/usage`, `mac/Usage/UsageScreen.swift`, v28/v47 | ✅ |
| Aviso de limite | Um aviso por ciclo e servidor | `mac/Usage/UsageStore.swift` | ✅ |

## 14. Memória, skills e contexto

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Memória inteligente | Antes do turno o bot lembra o que já sabe ("O que você já sabe"); depois guarda fatos duráveis, sem segredo; "Lembrei: …" | `server/memory`, v8.1/v56 | ✅ |
| Log do time | Cada bot sabe o que os outros fizeram hoje | `server/memory` | ✅ |
| Skills garantidas | Skill citada é lida e seguida | `server/skills`, v25 | ✅ |
| Compactação e cache | Prompt estável para cache, contexto do Claude compactado em 200k | `server/engine`, v56 | ✅ |

## 15. Painéis de trabalho (GitHub, Linear, Review)

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Tela GitHub | PRs meus, para revisar, menções e mergeados; detalhe com arquivos, checks e conversas; merge, review, comentar, tirar do rascunho, rodar CI de novo | `server/github`, `mac/GitHub`, v57 | ✅ |
| Kanban do Linear | Quadro por visão (minhas, time, visões salvas, projeto), mover, atribuir, começar; avatares, etiquetas e imagens | `server/linear`, `mac/Linear`, v57/v58 | 🧪 |
| Review | Presets (Daily de hoje, Resumo da semana, PRs para revisar) juntam Linear + GitHub e abrem uma conversa com o bot | `server/review`, `mac/Review`, v58 | 🧪 |
| Atalhos (launcher) | Painel com GitHub, Linear, Agenda, Notas e planilhas, Rotinas, Conectores e Uso, a um clique | `mac/Launcher/LauncherPanel.swift` | 🧪 |

## 16. App do Mac em geral

| Recurso | O que a pessoa vê | Onde | Status |
|---|---|---|---|
| Ajustes no estilo do sistema | Seções, subtelas e Esc volta | `mac/Settings` | ✅ |
| Notificações | Respostas, aprovações, rotinas e falhas, cada uma ligável; nunca repetidas | `../Stores/Notifier.swift`, v52 | ✅ |
| Mini player do Spotify | Faixa tocando e controles na lateral, pelo app do Spotify (AppleScript) | `mac/Spotify` | 🧪 |
| Status ao vivo | Quem está trabalhando, servidores e fila em `/status/stream` | `server/status` | ✅ |
| Inspetor | Atividade, servidores, biblioteca de artefatos (`⌥⌘I`) | `mac/Inspector/InspectorView.swift` | ✅ |

---

## Fora do escopo do lançamento

- Hospedagem multiusuário: plano em [docs/hosting.md](../hosting.md), não implementado.
- Dono por recurso (bots por conta): fase 2 em [auth.md](../protocol/auth.md); hoje um membro convidado vê os bots do dono.
- VM Linux por bot com tela assumível: só o computador virtual da v11 existe.
