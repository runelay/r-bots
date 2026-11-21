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
