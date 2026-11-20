# r/bots: roteiro do vídeo de lançamento

Lista de cenas em ordem narrativa, com o que gravar e o que não pode aparecer. O inventário completo está em [features.md](features.md); a arquitetura, em [../architecture/handoff.md](../architecture/handoff.md).

**Duração alvo do corte principal:** 4 a 5 min. Cada cena tem uma duração alvo já editada (sem espera de modelo: grave inteiro e acelere ou corte o tempo de resposta na edição).

**Fio narrativo:** "um time de bots que é seu". Começa vazio, monta o time, mostra o time trabalhando em código, no navegador, no Mac e na voz, e fecha com o time organizando o seu dia.

---

## Preparação

### Servidor de demo

Nunca gravar no servidor do dia a dia: a lateral, a busca, a memória e os conectores mostram dado real.

1. **Instância limpa numa porta separada.** Já existe uma receita de instância de teste do onboarding: servidor em `127.0.0.1:2300`, pasta de dados própria, banco próprio no Postgres, Redis em outro db, `BLOB_DRIVER=fs`, rotinas desligadas, exposta no tailnet numa porta própria com `tailscale serve`. Em 20/11 o processo da 2300 **não estava no ar** (a regra do `tailscale serve` continuava). Para gravar: zerar (parar o processo, `drop database` do banco da instância, apagar a pasta de dados) e subir de novo pelo script da pasta, para o onboarding aparecer do começo.
2. **Rotinas:** a instância sobe com `BOTS_SCHEDULES=off`. Para a cena de rotina, use "Rodar agora", que não depende do agendador.
3. **Contas de IA:** a instância lê as pastas `~/.claude*` e `~/.codex*` do servidor, e o nome de cada conta vem do login (pode ser o seu nome ou o de uma empresa). Antes de gravar, renomeie as contas na instância de demo para "Claude" e "Codex" (Ajustes › Contas de IA; vale só para essa instância).
4. **runelay:** use uma org de demo no runelay, com chave própria, e só conectores de contas de demo (Linear de demo, Google Calendar de demo, GitHub de demo). Com a chave do dia a dia, a memória lembra fatos reais e os conectores abrem dados de trabalho.
5. **Memória:** com a org de demo, a memória começa vazia. Se não der para usar outra org, desligue `memory.recall` e `memory.capture` nos bots de demo.
6. **GitHub (`gh`):** a tela GitHub e a faixa de PR usam o `gh` logado no servidor. Para gravar, a instância precisa de um `gh` logado numa conta de demo (ver perguntas em aberto). Sem isso, pule ou desfoque as cenas 12 e 24.
7. **ElevenLabs e Jev:** podem ser as chaves reais (não aparecem na tela; o campo é mascarado). Cole as chaves fora da gravação.

### Bots de demo

| Nome | Rosto / cor | Papel (instruções curtas) | Conta |
|---|---|---|---|
| Boss | `crown` / laranja | Coordena o time, delega e resume | Claude |
| Dev | `visor` / azul | Engenheiro: código, testes, PR | Claude |
| Pesquisa | `antenna` / verde-água | Pesquisa na web pelo navegador | Claude |
| Agenda | `face-3` / violeta | Agenda, notas e planilhas | Claude |
| Arte | `face-7` / rosa | Imagens e recorte de fundo | Codex |

Crie só o Boss ao vivo (cena 5). Os outros quatro, crie antes de gravar, logo depois do onboarding, para a lateral não ficar vazia nas cenas seguintes.

### Repositório de demo

- Um repositório público e novo numa conta ou org de demo, por exemplo um app Vite + React de lista de tarefas (`demo-tarefas`), com `README`, um teste Playwright simples em `tests/` e um script `dev`.
- Liberado na instância de demo pelo card `workspace_add` (aparece sozinho na cena 8).
- Nada de repositório da empresa, nem nome de branch com nome de pessoa ou id de issue real.

### Linear, Calendar e Spotify de demo

- **Linear:** workspace de demo com um time "Produto", 8 a 12 issues inventadas em colunas diferentes (Backlog, Em andamento, Em review, Concluído), uma com imagem e um PR de demo citando a issue.
- **Google Calendar:** conta de demo com eventos inventados na semana da gravação ("Planejamento da sprint", "1:1 com design", "Revisão do lançamento"), sem convidados reais.
- **Spotify:** playlist neutra, sem faixa pessoal (ver perguntas em aberto).

### Mac

- **Não perturbe** ligado (Central de Controle › Foco). Feche Mail, Mensagens, Slack, WhatsApp e qualquer app com notificação.
- Mesa limpa: `defaults write com.apple.finder CreateDesktop false; killall Finder` (volta com `true`).
- Barra de menus: esconder ícones extras (segure `⌘` e arraste para fora, ou use um app de barra limpa); deixar só relógio, Wi-Fi e bateria. Desligar "Mostrar ícone do Tailscale" para o nome do tailnet não aparecer no menu.
- Dock: só Finder, r/bots, Safari e Simulator; esconder automaticamente ligado.
- Papel de parede liso e escuro (ou o padrão do macOS).
- Resolução de gravação: **2560×1440** (corta para 1920×1080 sem perda). Janela do r/bots em ~1600×1000 centralizada; nas cenas com painel dividido, ~2200×1300.
- Aparência: gravar tudo em escuro (ou tudo em claro), sem trocar no meio.
- Permissões já dadas ao r/bots antes da gravação: Acessibilidade, Gravação de Tela, Microfone, Reconhecimento de Fala, Automação (Spotify, Simulator). Diálogo de permissão do macOS na tela é retrabalho.
- Teclado e cursor: cursor grande desligado; usar um app de realce de clique só se for padrão em todas as cenas.
- Safari sem favoritos visíveis, sem abas, perfil limpo.

### Checklist de vazamento (vale para todas as cenas)

Nada disto pode aparecer, nem por um quadro:

- [ ] Tokens, chaves, senhas, `rbk_…`, valores do cofre (o campo mascarado `••••` pode)
- [ ] E-mails reais (login, convites, contas de IA, autor de commit, Calendar)
- [ ] Nome do tailnet, hostname da VPS, IPs (inclusive `100.x.y.z` na página `/device`), porta pública do tailnet
- [ ] Caminhos com `/home/<usuário>` ou `/Users/<usuário>` (aparecem em logs de servidor, cards de arquivo, "Copiar caminho", erros)
- [ ] Nomes de clientes e parceiros da empresa, nomes de repositórios e orgs reais, PRs e issues reais, ids de issue (`ABC-123`) do trabalho
- [ ] Nomes de pessoas reais (colegas, autores de PR, responsáveis no Linear)
- [ ] Banners de notificação de outros apps
- [ ] Eventos reais da agenda
- [ ] Memórias reais na linha "Lembrei" ou em "O que você já sabe"
- [ ] Nomes de conta de IA com nome de pessoa ou de empresa
- [ ] Barra de menus com ícones pessoais, Dock com apps de trabalho
- [ ] Spotify com faixa pessoal (ver perguntas em aberto)

---

## Cenas

### 1. Abertura

- **Objetivo:** a promessa em uma frase: "um time de bots que é seu, no seu servidor, com a assinatura que você já paga".
- **Tela:** logo r/bots sobre fundo escuro, depois a janela do app com a lateral cheia de bots trabalhando (bolinhas pulsando).
- **Passos:** gravar a lateral com 3 bots rodando turnos (deixe Dev, Pesquisa e Agenda com uma tarefa cada). Zoom lento na lateral.
- **Duração:** 8 s.
- **Dados:** bots de demo com conversas já feitas.
- **Risco:** títulos das conversas na lateral (só demo), anéis de uso sem nome de conta.

### 2. Login

- **Objetivo:** mostrar que é um servidor seu com conta própria.
- **Tela:** tela de login dividida; à direita a vitrine de bots.
- **Passos:** abrir o app no perfil "Demo"; digitar e-mail de demo e senha; marcar "Manter conectado"; Entrar. Alternativa: "Entrar com Touch ID".
- **Duração:** 8 s.
- **Dados:** conta de dono criada na instância de demo com e-mail de demo (ex.: `demo@exemplo.com`).
- **Risco:** e-mail real no campo; endereço do servidor no rodapé ou em Ajustes; se usar login pelo navegador, a página `/device` mostra IP e endereço, então **não gravar a página `/device`**.

### 3. Primeiro acesso (opcional, só se a instância estiver zerada)

- **Objetivo:** "o primeiro a abrir vira dono".
- **Tela:** "Primeiro acesso", nome, e-mail, senha.
- **Passos:** preencher com dados de demo e criar.
- **Duração:** 6 s (pode substituir a cena 2).
- **Dados:** instância zerada.
- **Risco:** igual à cena 2.

### 4. Onboarding: perfil e IA dos bots

- **Objetivo:** configurar sem editar arquivo.
- **Tela:** trilho de passos; "Como você quer aparecer?" e "Qual IA os bots vão usar?" com as contas achadas.
- **Passos:** escolher foto e nome de demo; Continuar; no passo de IA, mostrar "Claude" e "Codex" prontos; Continuar.
- **Duração:** 10 s.
- **Dados:** contas renomeadas na instância (Preparação, item 3).
- **Risco:** nome de conta de IA com nome de pessoa ou empresa; e-mail da conta no subtítulo.

### 5. Criar o primeiro bot

- **Objetivo:** criar um bot só com nome; ele chega e pergunta o que fazer.
- **Tela:** passo "Monte o seu primeiro bot" → editor com nome, rosto e cor → conversa com a saudação.
- **Passos:** Criar bot; nome **Boss**; rosto coroa; cor laranja; Criar. Na conversa, digitar:
  > Você coordena o meu time de bots. Quando eu pedir algo grande, divida e delegue para quem for melhor, e me devolva um resumo curto.
- **Duração:** 15 s.
- **Dados:** nenhum.
- **Risco:** nenhum específico.

### 6. Onboarding: integrações, conectores e Mac

- **Objetivo:** mostrar que voz, aprovações automáticas e contas externas ligam pelo app.
- **Tela:** "Quer ligar mais alguma coisa?" (ElevenLabs, Jev, runelay já ligados), "Quais contas os bots podem usar?" (catálogo), "Libere o Mac para os bots".
- **Passos:** passar pelos três com Continuar; parar 1 s no catálogo com Linear, GitHub e Google Calendar marcados como conectados.
- **Duração:** 10 s.
- **Dados:** chaves já coladas fora da gravação; conectores da org de demo.
- **Risco:** qualquer chave visível (o campo só mostra máscara; não clicar em "Mostrar"); nome da org runelay real; lista de conectores reais (Gmail, Slack, bancos de produção).

### 7. Conversa: o bot se configura sozinho

- **Objetivo:** "converse em vez de configurar".
- **Tela:** conversa com o Boss; linha de ajuste com "Desfazer".
- **Passos:** digitar:
  > Muda sua cor para violeta e me chama de Ana daqui pra frente.
  Mostrar a linha de ajuste e clicar em Desfazer na cor.
- **Duração:** 10 s.
- **Dados:** nenhum.
- **Risco:** nenhum.

### 8. Código: liberar o repositório e abrir a tarefa

- **Objetivo:** o bot pede para trabalhar num repo e cria uma worktree própria.
- **Tela:** conversa com o Dev; card `workspace_add`; pílula do repo e da branch.
- **Passos:** nova conversa com o Dev (`⌘N`) e digitar:
  > No repositório demo-tarefas, adiciona um filtro "Só pendentes" na lista de tarefas e roda o app para eu ver.
  Aprovar o card de liberar o repositório.
- **Duração:** 12 s.
- **Dados:** repo de demo clonado na máquina do servidor.
- **Risco:** caminho do repo no card (`/home/<usuário>/…`): se aparecer, recortar ou clonar o repo num caminho neutro; nome da branch.

### 9. Código: diff ao vivo

- **Objetivo:** ver o bot editando, como um editor.
- **Tela:** diff aparecendo no meio da conversa; painel Mudanças.
- **Passos:** deixar o turno rodar; abrir o painel Mudanças no fim.
- **Duração:** 12 s (acelerado).
- **Dados:** repo de demo.
- **Risco:** caminhos absolutos em linha de comando do Bash (ferramenta expandida); colapsar as linhas de ferramenta.

### 10. Código: dev server com prévia e barra de endereço

- **Objetivo:** o app roda e aparece ao lado, com barra de endereço.
- **Tela:** card do servidor na conversa → painel dividido com Prévia e Logs.
- **Passos:** clicar no card do servidor; na prévia, clicar em "Só pendentes"; trocar para Logs por 1 s e voltar; digitar `/sobre` na barra de endereço.
- **Duração:** 15 s.
- **Dados:** app de demo com uma rota `/sobre`.
- **Risco:** a barra de endereço mostra o endereço da prévia (domínio do servidor): **conferir se aparece o hostname do tailnet**; se sim, desfocar a barra ou usar `BOTS_PREVIEW_ORIGIN` com um nome neutro. Logs com caminho de pasta.

### 11. Código: teste Playwright

- **Objetivo:** o bot testa o que fez e mostra o resultado.
- **Tela:** card `test.result` com passos e print.
- **Passos:** digitar:
  > Roda o teste do Playwright da lista e me mostra o resultado.
- **Duração:** 10 s.
- **Dados:** spec em `tests/` do repo de demo; Playwright instalado antes (o `playwright_install` pede card; não gravar a instalação).
- **Risco:** caminho da pasta de execução no card.

### 12. Código: commit, PR e CI

- **Objetivo:** do pedido ao PR sem sair da conversa.
- **Tela:** faixa de PR com estado do CI.
- **Passos:** digitar:
  > Pode commitar e abrir o PR.
  Mostrar a faixa do PR com o CI rodando e depois passando.
- **Duração:** 10 s.
- **Dados:** repo de demo com um workflow de CI simples; `gh` de demo.
- **Risco:** conta do GitHub real, nome de org real, autor do commit com e-mail real (conferir `git config user.email` usado pelo servidor na instância de demo).

### 13. Simulador (opcional)

- **Objetivo:** o mesmo para app mobile.
- **Tela:** painel do simulador espelhando o iPhone.
- **Passos:** só com um app Expo de demo; senão, pular.
- **Duração:** 8 s.
- **Dados:** projeto Expo de demo.
- **Risco:** apps pessoais na tela inicial do simulador (usar simulador recém-criado).

### 14. Navegador do bot

- **Objetivo:** cada bot tem o próprio navegador, e você assiste ao vivo.
- **Tela:** painel Computador com o navegador do Pesquisa.
- **Passos:** conversa com o Pesquisa:
  > Abre a página da Wikipédia sobre o Sistema Solar e me diz em três linhas qual é o maior planeta e por quê.
  Abrir o painel Computador durante o turno.
- **Duração:** 15 s.
- **Dados:** nenhum (site público).
- **Risco:** histórico ou logins do perfil do navegador do bot (usar bot novo).

### 15. Uso do seu Mac

- **Objetivo:** o bot mexe no Mac com aura e cursor próprios, e pausa quando você mexe.
- **Tela:** aura na borda da tela, cursor do bot, aba "Parar".
- **Passos:** conversa com o Agenda (com "Seu Mac" ligado):
  > Cria uma pasta "Lançamento" na minha mesa e um arquivo de texto dentro com a lista: roteiro, gravação, edição.
  Aprovar o card. Durante a ação, mexer o mouse para mostrar a pausa e soltar.
- **Duração:** 18 s.
- **Dados:** pasta liberada (`~/Desktop`) vazia; mesa com ícones visíveis só nesta cena, ou mostrar o Finder.
- **Risco:** nome de usuário do Mac no caminho do Finder (esconder a barra de caminho), outros arquivos da mesa, notificação do sistema.

### 16. Ilha

- **Objetivo:** com o app em segundo plano, o pedido chega na ilha do topo.
- **Tela:** forma preta no topo que vira o card de aprovação ou pergunta.
- **Passos:** com outro app na frente, pedir ao Agenda (por voz ou antes de trocar de app) algo que peça aprovação; responder pela ilha.
- **Duração:** 8 s.
- **Dados:** nenhum.
- **Risco:** app da frente com dado real (usar o Safari em página neutra).

### 17. Delegação e Boss

- **Objetivo:** o time trabalha junto.
- **Tela:** conversa do Boss com linhas cinzas "Dev está trabalhando…", "Mensagem de Pesquisa".
- **Passos:** conversa com o Boss:
  > Prepara o lançamento do demo-tarefas: o Pesquisa acha três apps parecidos e o que eles têm de bom, e o Dev escreve no README uma seção "Próximos passos" com base nisso.
- **Duração:** 18 s (acelerado).
- **Dados:** repo de demo.
- **Risco:** igual às cenas 9 e 14.

### 18. Conversa secundária e mensagem no meio do turno

- **Objetivo:** fazer duas coisas ao mesmo tempo e corrigir o bot sem parar.
- **Tela:** painel `/side` ao lado; mensagem entrando no turno em curso.
- **Passos:** com o Dev trabalhando, digitar `/side` e:
  > Enquanto isso, me explica em duas linhas como o filtro foi feito.
  Na conversa principal, mandar no meio do turno:
  > Ah, deixa o botão com o texto "Pendentes", sem "Só".
- **Duração:** 15 s.
- **Dados:** repo de demo.
- **Risco:** nenhum além do código.

### 19. Pergunta estruturada

- **Objetivo:** o bot pergunta com opções em vez de adivinhar.
- **Tela:** card de pergunta no lugar do campo de mensagem, em passos.
- **Passos:** ao Arte:
  > Quero um ícone para o demo-tarefas. Me pergunta o estilo antes de começar.
  Responder escolhendo as opções.
- **Duração:** 10 s.
- **Dados:** nenhum.
- **Risco:** nenhum.

### 20. Imagem e recorte

- **Objetivo:** gerar imagem e tirar o fundo.
- **Tela:** imagem gerada como anexo; versão transparente.
- **Passos:** continuar com o Arte:
  > Agora gera o ícone e me manda também uma versão sem fundo.
- **Duração:** 10 s.
- **Dados:** bot Arte na conta Codex.
- **Risco:** nenhum. Cena 🧪: gravar com folga e ter plano B (cortar a cena).

### 21. Rotinas

- **Objetivo:** bots que trabalham sozinhos.
- **Tela:** card de rotina criada; tela Rotinas; "Rodar agora".
- **Passos:** ao Agenda:
  > Todo dia útil às 9h, me manda um resumo da agenda do dia e das tarefas em andamento.
  Abrir Atalhos › Rotinas e clicar "Rodar agora".
- **Duração:** 12 s.
- **Dados:** Calendar e Linear de demo.
- **Risco:** eventos e issues reais.

### 22. Voz

- **Objetivo:** ligar para um bot e conversar.
- **Tela:** chamada aberta com o nível de voz; o bot trabalhando por trás.
- **Passos:** ligar para o Agenda e falar:
  > Oi, o que eu tenho amanhã de manhã?
  Depois:
  > Marca meia hora sexta às 10h para revisar o lançamento.
  E: "Valeu, pode desligar."
- **Duração:** 20 s.
- **Dados:** Calendar de demo.
- **Risco:** eventos reais; voz de terceiros no ambiente; som de notificação.

### 23. Blocos: agenda, nota e planilha

- **Objetivo:** blocos nativos, não só texto.
- **Tela:** agenda da semana no painel; nota com links; planilha com fórmula.
- **Passos:** ao Agenda:
  > Cria uma nota "Plano de lançamento" com as etapas e uma planilha com orçamento: item, valor e total no fim.
  Abrir a agenda da semana pelo bloco; abrir a planilha e editar um valor para o total mudar.
- **Duração:** 18 s.
- **Dados:** Calendar de demo.
- **Risco:** eventos reais.

### 24. GitHub

- **Objetivo:** PRs sem sair do app.
- **Tela:** tela GitHub com os PRs; detalhe com checks; review.
- **Passos:** abrir GitHub na barra de ícones; abrir o PR da cena 12; aprovar ou comentar.
- **Duração:** 10 s.
- **Dados:** conta `gh` de demo com 3 a 5 PRs de demo.
- **Risco:** **alto**: a tela lista todos os PRs da conta logada no servidor. Sem conta de demo, pular ou desfocar inteiro.

### 25. Linear e Review

- **Objetivo:** o quadro do time e um resumo pronto.
- **Tela:** kanban do Linear; botão Review; conversa com o resumo.
- **Passos:** abrir Linear; arrastar uma issue de "Em andamento" para "Em review"; clicar Review › "Daily de hoje".
- **Duração:** 15 s.
- **Dados:** workspace Linear de demo.
- **Risco:** **alto**: workspace, times, pessoas e issues reais. Sem workspace de demo, pular.

### 26. Cofre

- **Objetivo:** "o modelo nunca vê o segredo".
- **Tela:** card de pedir segredo; valor mascarado.
- **Passos:** ao Pesquisa:
  > Guarda a chave de API do serviço de clima como "clima" e usa ela para buscar a previsão de hoje.
  Colar uma chave falsa no campo seguro.
- **Duração:** 10 s.
- **Dados:** chave inventada.
- **Risco:** nunca colar chave real; não clicar em "Mostrar".

### 27. Uso e limites

- **Objetivo:** sabe quanto está gastando.
- **Tela:** anéis na barra; tela de Uso.
- **Passos:** passar o mouse nos anéis e abrir Uso.
- **Duração:** 6 s.
- **Dados:** instância de demo.
- **Risco:** nome e e-mail das contas; custo real (pode aparecer).

### 28. Encerramento

- **Objetivo:** chamada para ação.
- **Tela:** lateral com o time trabalhando, logo r/bots, "self-hosted · Docker · seu servidor", link do repositório.
- **Passos:** abrir o Spotify mini player por 2 s (opcional), voltar à lateral, fade.
- **Duração:** 8 s.
- **Dados:** playlist neutra.
- **Risco:** faixa pessoal.

---

## Perguntas em aberto

1. **GitHub:** criar uma conta ou org de demo e logar o `gh` dela só na instância de demo, ou pular as cenas 12 e 24?
2. **Linear:** existe um workspace de demo? Sem ele, a cena 25 sai.
3. **runelay:** dá para criar uma org de demo com chave própria (memória vazia, conectores de demo)?
4. **Spotify:** mostrar o mini player com uma faixa qualquer ou cortar? A capa e o nome da faixa aparecem.
5. **Computador virtual e simulador:** entram no corte principal ou ficam para um vídeo de "modo código"?
6. **Prévia:** a barra de endereço da prévia mostra o domínio do servidor; desfocar ou configurar um domínio neutro?
