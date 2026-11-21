# Edição do vídeo de lançamento (21/11)

Corte feito a partir das gravações de [gravacao.md](gravacao.md), seguindo o [roteiro](roteiro.md). Os vídeos não vão para o git: ficam no Mac em `~/Movies/rbots-launch/final/` e na VPS em `~/video-rbots-launch/final/`.

## Entregas

| Arquivo | Formato | Uso |
|---|---|---|
| `rbots-lancamento.mp4` | 1920×1080, H.264 ~10 Mbps, AAC | Corte principal (~5 min 23 s) |
| `rbots-lancamento-60s.mp4` | 1920×1080, 60 s | Teaser com 12 cortes rápidos |
| `rbots-lancamento-vertical.mp4` | 1080×1920, 60 s | Teaser vertical (Reels, Shorts, Stories) |
| `capitulos.txt` | texto | Capítulos do corte principal, prontos para colar no YouTube |

Sem narração. A trilha é sintetizada no próprio projeto (sem licença de terceiros) e abaixa um pouco durante as cenas.

## Estrutura do corte principal

Logo e promessa → abertura com três bots trabalhando → cinco partes, cada uma com um cartão de título e um rótulo por cena:

1. **Monte o seu time**: adicionar o servidor (01), primeiro acesso com código e onboarding inteiro (v2-34), Boss como coordenador (09), o bot se configura pela conversa com Desfazer (10).
2. **Trabalho de verdade**: código do pedido à prévia (11), mudar de ideia no meio do trabalho (v2-20e), pergunta respondida pela ilha (v2-22), navegador na Wikipédia (v2-26), delegação do Boss (13), `/side` (v2-24), ícone com recorte (v2-21), Playwright falha e passa (v2-23).
3. **O seu dia organizado**: nota e planilha com `=SOMA` (14), rotina criada pela conversa (15) e "Rodar agora" (v2-25), cofre (16).
4. **Conectado ao seu trabalho** (produção, desfocado): GitHub (v2-28), Linear (v2-29), atalhos, agenda, notas e catálogo (v2-30).
5. **No seu Mac** (produção, desfocado): uso do Mac com aprovação (v2-32) e com o Jev aprovando sozinho (v2-35), chamada de voz (v2-31, só a imagem), uso e limites (v2-27), Spotify (v2-33).

Encerramento: logo, "Um time de bots que é seu.", "Self-hosted com Docker · app nativo para Mac · Claude, Codex e mais" e `github.com/runelay/r-bots`.

Espera de modelo foi acelerada de 2× a 16× com rampa de velocidade (um selo "N×" aparece no canto enquanto acelera). Zoom suave nas partes importantes da tela.

## Desfoque aplicado

Desfoque forte (pixelado + gaussiano) aplicado antes de qualquer corte ou zoom, por região e por tempo:

- **v2-28 GitHub:** lista de repositórios, lista de PRs, cabeçalho e corpo do PR, avatar, abas de conversa, lateral e nome do usuário. O menu Review, as abas e os selos de CI ficam legíveis. O diálogo de merge foi cortado (o corpo do PR por trás ficava legível).
- **v2-29 Linear:** cartões, detalhe da issue, chip do time, entradas de times e clientes no menu de visões. **A issue 2 (80–102 s, com e-mail e @ de pessoa real) não entrou no corte.**
- **v2-30:** lateral, conversa do daily, rotinas com nomes de issue e cliente, eventos e legenda da agenda, conector da empresa no catálogo.
- **v2-31, v2-32, v2-35:** abas com nomes de bots reais. O diálogo "Abrir" da pasta Downloads (v2-32, 10–42 s) e o Control Center com o nome do Wi-Fi (v2-31, 0–2 s) foram cortados e cobertos.
- **v2-33:** lateral e nome do usuário.
- **v2-27:** custo em dólar (aba Custo e "Economia do cache").
- **v2-22:** o diálogo da Pré-Visualização (11–40 s, com nome de usuário do Mac e arquivos de trabalho) foi cortado.
- **Demo:** o texto vermelho "Não consegui carregar as vozes" (sem ElevenLabs na demo) foi coberto em 11, 16, v2-23 e v2-24.

Conferência: quadros a cada 1,5 s dos trechos de produção, antes e depois da composição final, sem texto legível.

## O que ficou de fora e por quê

- **02–08, 12, 17, 18:** substituídos pelas tomadas melhores (v2-34, v2-26, v2-24, v2-19).
- **v2-20 e v2-20b:** na v2-20 o bot ignorou a correção; na v2-20b a primeira mensagem aparece como "Não enviada". Ficou a v2-20e, em que a correção chega logo depois do fim do turno (o rótulo diz "no meio do trabalho", não "no meio do turno").
- **Diálogo de merge do GitHub, issue 2 do Linear, visão "Produto/Tech" vazia:** dado sensível ou bug visível.
- **Voz:** a transcrição da v2-31 saiu errada, então só a chamada abrindo e o nível de voz aparecem, sem áudio.

## Como renderizar de novo

Projeto em `~/video-rbots-launch` na VPS. Os intermediários foram apagados; para refazer, copie os clipes do Mac para `raw/` e recrie as dependências:

```sh
cd ~/video-rbots-launch
rsync -a --exclude '_*' <mac>:Movies/rbots-launch/*.mov raw/
uv venv .venv && uv pip install --python .venv/bin/python numpy scipy pillow
(cd remotion && bun install)
(cd scripts && ../.venv/bin/python build_beats.py)         # corta, acelera e desfoca cada cena (cache por cena)
.venv/bin/python scripts/music.py remotion/public/music-main.wav 323.5 100 11
cd remotion
npx remotion render src/index.ts main ../out/main_raw.mp4 --port=3917 --crf=15
npx remotion render src/index.ts teaser ../out/teaser_raw.mp4 --port=3917 --crf=15
npx remotion render src/index.ts vertical ../out/vertical_raw.mp4 --port=3917 --crf=15
bun chapters.ts > ../capitulos.txt
cd .. && scripts/finish.sh                       # codifica em H.264 ~10 Mbps em final/
```

- `scripts/edl.py` é a lista de edição: trechos de cada clipe com velocidade, regiões de desfoque (em % do quadro, tempo do clipe bruto), zooms e textos. Mudar uma cena e rodar `build_beats.py` só refaz aquela cena.
- `scripts/verify_frames.sh` extrai quadros para conferir o desfoque.
- Composição, cartões, rótulos e trilha ficam em `remotion/src/Video.tsx`.
