# Gravação das cenas de lançamento (20/11)

Primeira rodada de gravação, seguindo o [roteiro](roteiro.md), numa instância de demo limpa. Os arquivos ficam no Mac em `~/Movies/rbots-launch/` (não vão para o git). Tela inteira, 2940×1912 (Retina), 30 fps, H.264, sem áudio. O tempo de espera do modelo está dentro dos clipes: acelerar ou cortar na edição.

## Clipes

| Arquivo | Duração | Cena do roteiro | Observações |
|---|---|---|---|
| `01-adicionar-servidor-demo.mov` | 13 s | 2 (antes do login) | Ajustes › Servidores › Adicionar: nome "Demo", `http://localhost:2300`, cor violeta, "Adicionar e entrar". |
| `02-login.mov` | 13 s | 2 | Login com `demo@exemplo.com`. Rodapé mostra só `localhost`. |
| `03-onboarding-perfil.mov` | 7 s | 4 | Passo 1, "Como você quer aparecer?" com "Ana Demo". |
| `04-criar-bot-boss.mov` | 13 s | 5 | Cria o Boss (coroa, laranja) e chega em "O seu bot chegou". |
| `05-onboarding-integracoes.mov` | 10 s | 6 | ElevenLabs, Jev e runelay como "Não configurado". **Recortar a lateral**: o passo "Contas de IA" mostra o nome automático da conta, com o nome da empresa. |
| `06-onboarding-conectores-mac.mov` | 9 s | 6 | "Conectores e memória estão desligados" → "Libere o Mac" com as três permissões liberadas. Mesmo recorte da lateral. |
| `07-onboarding-mac-fim.mov` | 9 s | 6 | "Tudo pronto, Ana." Mesmo recorte da lateral. |
| `08-entrar-no-app.mov` | 7 s | 5 | Entra no app com a saudação do Boss. **Desfocar a barra do topo**: mostra o nome automático da conta Claude, com o nome da empresa (o nome da conta foi trocado só depois). |
| `09-boss-papel.mov` | 30 s | 5 | Instrução de coordenador; o Boss muda o próprio papel e as instruções. |
| `10-boss-se-configura.mov` | 36 s | 7 | "Muda sua cor para violeta e me chama de Ana" → linha "Mudou o rosto" → Desfazer. |
| `11-dev-codigo.mov` | 120 s | 8, 9, 10 | Card de liberar o repositório (`/home/demo/projects/demo-tarefas`, caminho neutro), worktree, diff ao vivo, prévia `localhost:5610` aberta ao lado, tarefa nova, filtro "Ativas", Logs e volta. |
| `12-pesquisa-navegador.mov` | 69 s | 14 | Navegador do Pesquisa ao vivo na Wikipédia (Sistema Solar), com "Assistindo / Assumir o controle". Primeira tentativa abre "Wikimedia Error", a segunda carrega. |
| `13-boss-delegacao.mov` | 121 s | 17 | Boss delega para Pesquisa e Dev ("Pesquisa está trabalhando"), resumo final e "2 mensagens com 2 bots" aberto. |
| `14-blocos-nota-planilha.mov` | 86 s | 23 (sem agenda) | Boss cria a nota "Plano de lançamento" e a planilha "Orçamento de lançamento"; os valores são preenchidos à mão e o total (`=SOMA`) muda para 5.030; abre a nota. |
| `15-rotina.mov` | 94 s | 21 | Rotina "Resumo diário do time" (dias úteis, 9h) pela conversa, tela Rotinas, "Rodar agora" e o resultado na conversa. |
| `16-cofre.mov` | 43 s | 26 | Card "Pesquisa pediu um segredo", chave falsa `demo-clima-…`, "Salvo no cofre · segredo:clima". |
| `17-side-e-mensagem-no-turno.mov` | 50 s | 18 (parcial) | Dev adiciona contador de concluídas; `/side` abre a conversa secundária e explica o código. A mensagem no meio do turno não entrou: o Dev terminou antes. |
| `18-abertura-time-trabalhando.mov` | 42 s | 1 / 28 (rascunho) | Três pedidos seguidos (Boss, Pesquisa, Dev). Os turnos acabam rápido e uma mensagem caiu numa subconversa: serve só como material de apoio; refazer com tarefas mais longas. |
| `_descartado-02-primeiro-acesso-sem-campo-codigo.mov` | 15 s | 3 | Descartado: termina no erro do código de primeiro acesso (ver bugs). Os primeiros 10 s (preenchendo nome, e-mail e senha) podem servir. |

## Cenas que ficaram de fora

- **3 (primeiro acesso)**: o app não tem campo para o código de `setup.token` (ver bugs). A conta dona foi criada pela API, e a cena virou o login (clipe 02).
- **Passo "Contas de IA" do onboarding (parte da 4)**: mostra o e-mail das contas e o nome da empresa no nome automático. Não gravado.
- **11 (Playwright), 12 e 24 (GitHub), 25 (Linear e Review)**: sem conta `gh` nem workspace Linear de demo. O Dev tentou dar push e falhou por falta de `gh`, o que foi bom: o repo de demo é um clone do `mdn/todo-react`, e o remoto continua sendo o original.
- **13 (simulador)**: sem projeto Expo de demo.
- **15 e 16 (uso do Mac e ilha)**: a mesa do Mac é a mesa real do usuário; não mexi nela.
- **19 e 20 (pergunta estruturada e imagem)**: não houve tempo; o bot Arte não foi criado. A pergunta estruturada apareceu sozinha numa tomada descartada do Dev, então a cena é fácil de refazer.
- **22 (voz)**: a instância de demo não tem chave da ElevenLabs.
- **21 com agenda e 23 com agenda**: sem Google Calendar de demo; só a rotina, a nota e a planilha.
- **27 (uso e limites)**: a tela de Uso mostra contas com e-mail; não gravado.

## Bugs e problemas achados

1. **Primeiro acesso trava no app do Mac.** O servidor exige o código de `setup.token` (`x-setup-token` ou `setupToken` no corpo), mas o app não tem campo nem envia o cabeçalho. A tela mostra "Informe o código de primeiro acesso…" sem lugar para digitar. Quem instala pelo app nunca consegue criar a conta dona.
2. **Depois de criar o dono por fora, a tela de primeiro acesso não vira login.** Mostra "O dono já foi criado. Peça um convite." e fica presa. Só saiu trocando de perfil (⌃⌘1 / ⌃⌘2).
3. **Nome da conta de IA não atualiza no app.** Depois de renomear a conta para "Claude" (PATCH `/accounts/vps:claude`), o onboarding continuou mostrando o nome automático da conta, com o nome da empresa e a barra do topo também, até trocar de perfil.
4. **Passo "Contas de IA" mostra o e-mail da conta** (e a empresa no nome automático). Para vídeo e para instalação compartilhada, falta um jeito de esconder o e-mail.
5. **Card de liberar repositório mostra o caminho absoluto** (`/home/<usuário>/…`) em vez do caminho relativo à home (`~/…`). Contornado na demo montando a home em `/home/demo`.
6. **Prévia sem vozes**: sem ElevenLabs, o painel do bot mostra em vermelho "Não consegui carregar as vozes. Tente de novo." em toda conversa. Sem chave, o bloco deveria sumir ou explicar.
7. **Menu "/" mostra "Não consegui carregar as skills · Tentar de novo"** quando o runelay não está ligado. Mesmo caso: sem runelay deveria só não listar skills.
8. **"Rodar agora" em Rotinas não dá retorno visível.** A rotina roda (o resultado aparece na conversa), mas a tela não muda.
9. **Rotina do Boss não lê o repositório**: o resumo disse que "o acesso ao diretório foi bloqueado" e "não houve atividade ontem", mesmo com trabalho feito no dia. O Boss não tem o repo liberado, e o resumo de "ontem" ignora o dia corrente.
10. **Navegador do bot: primeira abertura da Wikipédia deu "Wikimedia Error"** e depois "o conteúdo era grande demais e o arquivo ficou bloqueado". A resposta veio do conhecimento do modelo, não da página.

## Como a instância de demo foi montada

- Contêineres separados: `rbots-demo` (imagem `runelay-bots-server:latest`, porta 2300, `network_mode: host`), `rbots-demo-postgres` (127.0.0.1:55441) e `rbots-demo-redis` (127.0.0.1:6391). Dados em `~/.local/share/rbots-demo/data`, com segredos novos gerados pelo `deploy/secrets/bootstrap.ts`. Nada da instância de produção foi tocado.
- Home da instância: `~/.local/share/rbots-demo/home`, montada em `/home/demo` (`HOST_HOME=/home/demo`). Só `~/.claude` e `~/.codex` do servidor entram, para os turnos rodarem.
- Repo de demo: `/home/demo/projects/demo-tarefas` (clone do `mdn/todo-react`).
- Bots: Boss, Dev e Pesquisa. Memória desligada no Dev e no Pesquisa; Boss com memória desligada e delegação para os dois. Conta "Claude" renomeada só nesta instância. Login `demo@exemplo.com`.
- O Mac chega na instância por um túnel reverso (`ssh -R 127.0.0.1:2300:127.0.0.1:2300` da VPS para o Mac), então o perfil "Demo" no app aponta para `http://localhost:2300` e nenhum nome do tailnet aparece. O túnel foi fechado no fim; o perfil "Demo" continua no app.
- A gravação e os cliques rodaram por um processo dentro do Warp (o `sshd` não tem permissão de Gravação de Tela): `~/rbrec/agent.sh` lê comandos de `~/rbrec/queue`, `~/rbrec/bin/rbin` move o mouse e digita, `recstart`/`recstop` usam o ffmpeg. Para reabrir: `open "warp://launch/rbrec"`.

### Ligar e desligar

```sh
# parar a demo
docker stop rbots-demo rbots-demo-postgres rbots-demo-redis
# voltar a gravar: subir, abrir o túnel e trocar para o perfil Demo no app
docker start rbots-demo-postgres rbots-demo-redis rbots-demo
ssh -f -N -i ~/.ssh/<chave-do-mac> -R 127.0.0.1:2300:127.0.0.1:2300 <usuario>@<mac>
# apagar de vez
docker rm -f rbots-demo rbots-demo-postgres rbots-demo-redis && docker volume rm rbots-demo-desktop
```

Para zerar e gravar o primeiro acesso de novo, apague também `~/.local/share/rbots-demo` (o banco mora dentro dela).

# Sessão 2 (21/11)

Mesma pasta no Mac (`~/Movies/rbots-launch/`), prefixo `v2-`. Tela inteira 2940×1664 px (1470×832 pt), 30 fps, sem áudio. Desta vez o pedido foi gravar tudo, inclusive no servidor de produção: o dado sensível será **desfocado na edição**, por isso a lista de desfoque abaixo. As regiões estão em porcentagem do quadro (x da esquerda para a direita, y de cima para baixo), então valem para qualquer escala. Os tempos são aproximados (±4 s): confirme no clipe.

Cenas da demo rodaram no perfil "Demo" (`rbots-demo` pelo túnel reverso, como na sessão 1). Cenas `prod` rodaram no perfil "Principal".

## Clipes

| Arquivo | Duração | Cena do roteiro | Servidor | Observações |
|---|---|---|---|---|
| `v2-19-abertura-time-trabalhando.mov` | 88 s | 1 / 28 | demo | Agenda (planilha + nota), Pesquisa (comparação de apps) e Dev (página de estatísticas) recebem tarefas longas seguidas; depois o cursor passa pelos três com as bolinhas pulsando. Substitui o clipe 18. |
| `v2-20-mensagem-no-meio-do-turno.mov` | 133 s | 18 | demo | Prioridade alta/média/baixa e, no meio, "só Normal e Urgente". Alternativa. |
| `v2-20b-mensagem-no-meio-do-turno.mov` | 88 s | 18 | demo | Data de vencimento e, no meio, "formato curto e Atrasada". Alternativa. |
| `v2-20e-mensagem-no-meio-do-turno.mov` | 113 s | 18 | demo | **Melhor tomada.** Tela de configurações e, com o turno rodando, "esquece o tamanho da fonte"; a correção entra no turno em curso. |
| `v2-21-arte-icone-e-recorte.mov` | 120 s | 19 + 20 | demo | Bot Arte (conta Codex): pede o estilo, gera o ícone sobre fundo liso e entrega o `-recorte.png` com bordas suaves; abre a imagem no visualizador. |
| `v2-22-pergunta-estruturada-ilha.mov` | 151 s | 19 + 16 | demo | Agenda pergunta com opções (4 perguntas, uma de múltipla escolha) com o app escondido: as respostas são dadas **pela ilha**. No fim abre a planilha criada. |
| `v2-23-teste-playwright.mov` | 202 s | 11 | demo | Dev escreve e roda o teste no navegador; card de instalar o Playwright aprovado na tela; a 1ª execução falha, a 2ª passa; abre o detalhe do teste. Cortar a espera. |
| `v2-24-side-thread.mov` | 85 s | 18 | demo | Dev reordenando a lista; `/side` abre a conversa secundária, pergunta como o filtro foi feito e a resposta volta ao lado. |
| `v2-25-rotina-rodar-agora.mov` | 113 s | 21 | demo (app novo) | Tela Rotinas, "Rodar agora" com retorno na tela, e o resultado na conversa do Boss. |
| `v2-26-navegador-wikipedia.mov` | 118 s | 14 | demo (app novo) | Pesquisa abre Sistema Solar e depois Júpiter (luas) no navegador do bot, ao vivo no painel. Carregou sem o erro da Wikimedia. |
| `v2-27-uso-e-limites.mov` | 53 s | 27 | demo (app novo) | Anéis de uso (hover), tela Uso: Limites, Tokens, Custo e o filtro de conta só com "Claude" e "Codex", sem e-mail. |
| `v2-28-prod-github.mov` | 177 s | 24 + 25 | prod | Lista de PRs, abas do detalhe (Descrição, Conversa, Arquivos, Checks), diálogo de merge **aberto e cancelado**, abas Para revisar/Menções/Mergeados, filtro por repo, menu Review e "Daily de hoje" (só leitura) com o resultado na conversa do Boss. |
| `v2-29-prod-linear.mov` | 154 s | 25 | prod | Kanban, troca de visão (Produto/Tech → Conty → Minhas issues → volta), hover nos cards, abre três issues e rola o detalhe, menu Review. Nada arrastado. |
| `v2-30-prod-launcher-e-trilho.mov` | 102 s | navegação | prod | Trilho (conversas, rotinas, GitHub, Linear), painel Atalhos, Agenda da semana, Notas e planilhas, Conectores (catálogo). |
| `v2-31-prod-voz.mov` | 85 s | 22 | prod | Bot temporário "Demo Voz", chamada aberta, fala da pergunta, nível de voz e legenda ao vivo. A transcrição saiu ruim (ver bugs): serve só para a parte visual da chamada. |
| `v2-32-prod-uso-do-mac.mov` | 139 s | 15 + 16 | prod (app antigo) | Demo Voz abre o TextEdit e digita uma linha; aprovação pela ilha e pelo card (uma por ação, antes do fix). |
| `v2-33-prod-spotify-mini.mov` | 27 s | 28 | prod | Mini player na lateral com faixa instrumental neutra ("New Light", playlist Peaceful Piano), troca de faixa e pausa. |
| `v2-34-primeiro-acesso-com-codigo.mov` | 153 s | 3 + 4 + 5 + 6 | demo zerada (app novo) | Primeiro acesso com o campo "Código de primeiro acesso" (mascarado), cria o dono "Ana Demo", onboarding inteiro: Boss, **Contas de IA sem e-mail** ("Claude · Plano Team", "Codex · ChatGPT Plano Plus"), integrações, conectores, Mac, "Tudo pronto, Ana" e a entrada no app. Substitui os clipes 02–08. |
| `v2-35-prod-uso-do-mac-ate-o-fim.mov` | 38 s | 15 | prod (app novo) | Bot temporário "Demo Mac" abre o TextEdit e escreve a lista em várias linhas sem nenhum card: o Jev aprovou as ações sozinho, então o botão "Permitir até o fim da tarefa" não aparece neste clipe. |
| `_descartado-v2-20c-…`, `_descartado-v2-20d-…` | 67 s, 51 s | — | demo | A mensagem digitada não foi enviada (ver bugs). |

## O que desfocar

Clipes da demo usam só dado de demo, com duas exceções (Pré-Visualização em 22 e o custo real em 27). Todos os clipes `prod` precisam de desfoque.

| Clipe | Tempo | Região (x%, y%) | O que aparece |
|---|---|---|---|
| `v2-22` | ~6–30 s | x 20–80, y 16–63 | Diálogo "Abrir" da Pré-Visualização com a pasta Downloads do Mac (nomes de arquivo de trabalho) e o nome do usuário na lateral do diálogo. Alternativa: cortar esse trecho. |
| `v2-27` | 25–53 s | x 14–90, y 20–60 | Custo real em dólar das contas do servidor (opcional, não é segredo). |
| `v2-28` | 0–128 s | x 4–100, y 7–100 (todo o conteúdo da janela, menos o trilho) | Nomes de repositórios e orgs reais, títulos e números de PR, nomes de branch, avatares e usuários do GitHub, descrição de PR com nome de cliente. |
| `v2-28` | 128–177 s | x 4–62, y 7–100 | Conversa "Daily de hoje" do Boss com ids de issue (CTY-…), PRs e orgs reais; lateral com os bots reais e o nome do usuário (x 4–24, y 92–98). |
| `v2-29` | 0–4 s | x 4–100, y 7–100 | Último quadro da conversa do Boss (daily). |
| `v2-29` | 16–28 s | x 12–40, y 12–60 | Menu de visões com nomes de times e clientes. |
| `v2-29` | 28–124 s | x 4–100, y 14–100 | Quadro com ids e títulos reais de issues, nomes de clientes e parceiros, avatares. |
| `v2-29` | 52–120 s | x 68–100, y 7–100 | Detalhe da issue. **Alto risco entre ~80 e ~108 s**: e-mail de funcionário, nome, e-mail e @ de uma criadora e link do Intercom. Recomendo cobrir o painel inteiro ou cortar. |
| `v2-29` | 124–154 s | x 4–100, y 14–100 | "Minhas issues" com títulos reais. |
| `v2-30` | 0–20 s | x 4–100, y 7–100 | Passagem rápida pela lista do GitHub e pelo Linear. |
| `v2-30` | 20–75 s | x 4–62, y 7–100 e x 62–100, y 7–100 | Lateral com bots reais, conversa do daily (ids e PRs reais) e Agenda da semana com títulos reais de eventos. |
| `v2-30` | 75–102 s | x 22–82, y 20–35 | Conector "Conty" em destaque no catálogo (nome da empresa). O resto do catálogo é público. |
| `v2-31` | todo | x 14–42, y 4–7 | Abas com nomes de bots reais ("Engenheiro de Softw…", "Boss"). A conversa é só do Demo Voz. |
| `v2-32` | ~6–35 s | x 20–80, y 16–63 | De novo o diálogo da Pré-Visualização com a pasta Downloads. |
| `v2-32` | todo | x 14–42, y 4–7 | Abas com nomes de bots reais. |
| `v2-33` | todo | x 4–24, y 14–92 e x 4–24, y 93–98 | Lateral com os bots reais (nomes e últimas mensagens) e o nome do usuário. |
| `v2-35` | todo | x 14–42, y 4–7 | Abas com nomes de bots reais. |

Nenhum segredo apareceu: o código de primeiro acesso e a senha do clipe 34 ficaram mascarados, e as chaves não foram abertas.

## Cenas que ficaram de fora ou precisam de retomada

- **Voz com conversa de verdade (22):** sem pessoa no Mac, a fala foi sintetizada pelo `say` saindo do alto-falante para o microfone interno; a transcrição veio trocada (frases em inglês inventadas). O clipe 31 serve só para mostrar a chamada abrindo e a legenda. Regravar com voz real.
- **Botão "Permitir até o fim da tarefa":** o fix chegou no fim; na tomada 35 o Jev aprovou tudo sozinho e nenhum card apareceu. Para gravar o botão, desligar o Jev no bot de teste ou pedir uma ação que caia para a pessoa.
- **Uso do Mac na demo:** não gravado (a demo continua na imagem anterior ao fix `fa0523c`; não recriei o contêiner).
- **Simulador (13), commit/PR/CI na demo (12):** continuam sem projeto Expo e sem `gh` de demo; o GitHub foi gravado em prod.
- **Arrastar issue no Linear:** não feito de propósito (issues reais).

## Bugs e problemas achados

1. **Mensagem não enviada no app do Mac.** Depois de vários turnos longos com stream aberto, duas vezes o texto digitado + Enter numa conversa nova (⌘N) não chegou ao servidor (nenhuma requisição no log) e o campo ficou como se nada tivesse acontecido. Voltou a funcionar só depois de fechar e abrir o app. Tomadas 20c e 20d descartadas.
2. **Visão salva "Produto/Tech" do Linear vazia:** todas as colunas mostram 0 com "100 issues carregadas" no topo. A visão do time e "Minhas issues" carregam normalmente.
3. **Uso do Mac pede aprovação a cada ação** (abrir app, digitar): visto no clipe 32 com o app antigo. Já corrigido em `fa0523c`/`46703a0`; no clipe 35 o Jev aprovou sozinho.
4. **Transcrição de voz** inventou frases em inglês com áudio ruim em vez de pedir para repetir só uma vez (o bot respondeu às frases inventadas). Pode ser só o áudio sintetizado, mas vale olhar o limiar de confiança.
5. **Primeira execução do teste Playwright falhou** no repo de demo e precisou de um segundo pedido; o Dev corrigiu o spec.
6. **Armadilha de gravação, não do produto:** esconder o r/bots com ⌘H com a Pré-Visualização aberta sem janela traz o diálogo "Abrir" da pasta Downloads para a frente. Antes de gravar, fechar a Pré-Visualização.

Conferidos e corrigidos nesta sessão (bugs 1, 3, 4, 6, 8 e 10 da sessão 1): o primeiro acesso tem o campo do código; Contas de IA sem e-mail; sem ElevenLabs o painel mostra "Conecte o ElevenLabs em Integrações" em vez do erro vermelho; "Rodar agora" dá retorno; o navegador do bot abriu a Wikipédia de primeira.

## Estado deixado

- A demo foi **zerada** para o clipe 34 (banco `runelay_bots` da instância de demo recriado, Redis da demo limpo). Os dados antigos (bots, conversas, worktrees, blobs) foram movidos para `~/.local/share/rbots-demo/pre-reset-0123`, não apagados. Hoje a demo tem só o dono "Ana Demo" e o Boss; Dev, Pesquisa, Arte e Agenda precisam ser recriados para as próximas cenas.
- Bots temporários de prod ("Demo Voz", "Demo Mac") foram excluídos pelo app (ficam na lixeira de Ajustes › Bots).
- Mac restaurado: perfil Principal, ícones da mesa e Dock de volta, apps visíveis, Não perturbe desligado, microfone padrão de volta para "Microfone Externo", Warp fechado, túnel fechado. Ficou instalado o `switchaudio-osx` (Homebrew) e o app novo do r/bots (build com o fix de aprovação).
