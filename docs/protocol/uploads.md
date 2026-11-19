# Anexos

## v22 (19/11): anexos (imagem, vídeo, áudio e arquivos), nos dois sentidos

Código em `apps/server/src/modules/uploads/services/uploads.service.ts`; app em `Features/Conversation/Models/Attachment.swift` e `Features/Conversation/Views/AttachmentViews.swift`.

### Upload

`POST /bots/:id/uploads` com o arquivo como corpo bruto (sem multipart). Headers: `X-File-Name` (nome, percent-encoded) e `Content-Type` (ou `X-File-Type`); `application/octet-stream`, `x-www-form-urlencoded` ou vazio → tipo pela extensão. Limite 100 MB (413 `O arquivo passa de 100 MB.`), vazio → 400, bot excluído → 409.

→ 201:
```json
{"uploadId":"01M7TD7TJ7DQNS1TJ3Q7ME5H9W","name":"video.mp4","mime":"video/mp4","size":128628,"kind":"video",
 "url":"/bots/teste-anexos/uploads/01M7TD7TJ7DQNS1TJ3Q7ME5H9W","thumbUrl":"/bots/teste-anexos/uploads/01M7TD7TJ7DQNS1TJ3Q7ME5H9W/thumb.jpg",
 "width":640,"height":360,"duration":12,"waveform":[0.92,0.91,…]}
```
`kind`: `image` | `video` | `audio` | `file` (SVG é `file`). `uploadId` é um ULID. `width/height` (imagem/vídeo, já com rotação), `duration` (s, áudio/vídeo), `waveform` (48 picos 0–1, áudio ou vídeo com som), `thumbUrl` (vídeo, ou imagem > 640 px ou fora de png/jpeg/gif/webp), `source:"bot"` quando veio de `send_file`.

Disco: `data/bots/<id>/uploads/<ulid>-<nome>`, metadados em `uploads/.meta/<ulid>.json`, derivados em `uploads/.derived/<ulid>/` (thumb, `model.jpg`, `frames/`, `audio.mp3`, `doc-images/`, `prepared.json`). O processamento para o modelo começa logo após o upload e fica em cache.

### Servir

`GET|HEAD /bots/:id/uploads/:uploadId` → o arquivo, com `Range` (206), `accept-ranges`, `cache-control: private, immutable`, `nosniff` e `content-disposition: inline`. HTML/SVG levam CSP fechada. `…/thumb.jpg` → miniatura; `…/meta` → o JSON acima. Mesma proteção das outras rotas: só tailnet, sem token. Id desconhecido → 404 `Anexo não encontrado.`

### Envio

`POST {sessionBasePath}/session/:sessionId` (e a criação de sessão) aceitam `"attachments": ["<uploadId>", …]` (até 10). Pode ir sem `message`. Id inexistente → 400 `Um dos anexos não existe mais. Anexe de novo.` (`field: "attachments"`).

`delivery.consumed.data.attachments` traz a lista no formato do upload (é o que o app usa para redesenhar ao recarregar). `parts[0].text` fica `""` quando só há anexo; `lastMessage` do thread vira `📎 nome` ou `📎 N anexos`. Antes de chamar o modelo sai `attachments.preparing {count}` (o app ignora).

### O que o modelo recebe

O texto da pessoa ganha um bloco `Anexos da pessoa:` com uma linha por anexo, sempre com o caminho no servidor.

| Tipo | Claude na VPS | Codex, Cursor, Grok e qualquer conta `mac:*` |
| --- | --- | --- |
| imagem | bloco de imagem (base64), lado maior ≤ 1568 (ffmpeg → `model.jpg` se maior, > 3,5 MB, GIF ou outro formato) | caminho + tipo, dimensões e tamanho; o modelo é avisado de que não vê a imagem |
| áudio | `[áudio: …]` com a transcrição do ElevenLabs Scribe em lote (`POST /v1/speech-to-text`, `scribe_v2`, cai para `scribe_v1`) | igual |
| vídeo | duração, transcrição do áudio extraído (ffmpeg → mp3 16 kHz) e 6–10 quadros-chave espaçados (≈ 1 a cada 6 s, ≤ 1024 px) como imagens, com o tempo de cada um | duração + transcrição + pasta dos quadros |
| documento | markdown do **anydoc** + até 8 imagens embutidas como blocos de imagem | markdown + pasta das imagens |
| texto/código | o conteúdo | igual |
| outros | caminho + `attachment_read` | igual |

#### Transcrição (áudio e som do vídeo)

- Fila no servidor: no máximo `UPLOAD_STT_CONCURRENCY` (padrão 1) chamadas batch ao Scribe ao mesmo tempo, para não disputar o limite de concorrência do plano Starter com a chamada de voz.
- Retry em 429, 5xx e erro de rede: esperas de 1 s, 3 s e 8 s com até 40 % de jitter, ou o `Retry-After` (segundos ou data, até 30 s) se for maior. 400/422 passa para o modelo seguinte (`scribe_v2` → `scribe_v1`); outro 4xx falha na hora.
- Se o Scribe ainda falhar e o app estiver aberto, o servidor manda o áudio (mp3 16 kHz mono, até 25 MB) ao Mac pela conexão do runner: `{"type":"request","id","op":"transcribe_file","body":{"audioBase64","name","locale":"pt-BR"}}` → `{"type":"response","id","ok":true,"result":{"text"}}` ou `{"ok":false,"error"}`, timeout 240 s. O app (`Features/Voice/FileTranscriber.swift`) usa `SFSpeechURLRecognitionRequest` pt-BR, no aparelho quando houver modelo local, com pontuação; sem permissão de fala responde erro. O `hello` do app passa a anunciar `"transcribe"`.
- A transcrição fica no meta do upload (`transcript`, `transcriptSource: "scribe"|"mac"`). Turnos seguintes e `attachment_read` reusam; chamadas simultâneas do mesmo anexo esperam a mesma transcrição.
- `attachment_read` em áudio/vídeo devolve `{name, kind, duration, transcript}`. O rótulo da chamada é "Ler o áudio de 0:26", "Ler o vídeo de 0:12" ou "Ler <nome do arquivo>", nunca o id ("Ler o anexo" se o servidor reiniciou e ainda não leu aquele anexo).
- Verificado 19/11: áudio de 4 s → transcrito pelo Scribe, gravado no meta, relido por `attachment_read` com o rótulo "Ler o áudio de 0:04". Não exercitado ao vivo: o 429 em si e o fallback no Mac (o Scribe aceitou todos os formatos testados, e derrubar a chave pararia a voz).

Texto vai cortado em 60 000 caracteres; o resto se lê com `attachment_read`. Falha no processamento entra na linha como `(não consegui processar: …)` e o turno segue. Conversas de grupo não recebem anexos (o app não oferece).

Claude: com imagens, `packages/providers/src/claude.ts` passa o prompt como mensagem de usuário em streaming (`AsyncIterable<SDKUserMessage>`) com `[rótulo, imagem]…, texto`; `TurnRequest.images = [{path, mime, label}]`. O runner do Mac não recebe imagens.

### Documentos: anydoc

`@firecrawl/anydoc` **0.2.4** fixo no `package.json` (o 0.2.5 saiu em 18/11; ficou de fora por ser novo demais). Roda local no container, binário nativo `linux-x64-gnu`, sem chave e sem OCR hospedado (`ocr: "reject"`).

- Formatos: `.doc/.docx/.docm`, `.ppt/.pptx/.pps*`, `.xls/.xlsx/.xlsm/.xlsb`, `.odt/.ods/.odp`, `.rtf`, `.epub`, `.csv` e também `.pdf` (texto). Formato pelo conteúdo (`formatFromBytes`), senão pela extensão.
- `toMarkdownBytes` → markdown. `toDocument` (não existe para PDF/CSV) → `assets`: imagens > 2 KB, até 8, gravadas em `doc-images/`; png/jpeg/webp ≤ 1568 px passam direto, o resto vira jpg pelo ffmpeg.
- Fallback: se o anydoc falhar ou vier vazio, PDF vai pelo `pdftotext -layout` (poppler-utils, no Dockerfile) e texto/código é lido como UTF-8. PDF escaneado (`needsOcr`) cai no pdftotext, que também não faz OCR.

### Ferramentas do bot (todos os bots, sem aprovação)

- `send_file {path, name?}` copia um arquivo do servidor para os uploads (`source:"bot"`) e emite, depois do `call.settled`:
  `{"type":"file.sent","data":{"attachment":{…formato do upload…},"botId","callId"}}`. Só aceita caminhos (resolvidos com realpath) dentro da pasta de dados, de `CODE_WORKTREES_DIR`, de `/home/runelaybot` ou de `/tmp`; nega `.env*`, `.git`, `.ssh`, `.claude`. Arquivo do Mac da pessoa não dá (ficou para depois).
- `attachment_read {uploadId, offset?, limit?}` lê o texto (anydoc/pdftotext/UTF-8) em pedaços de até 200 000 caracteres; para binários devolve tipo, tamanho e caminho.
- O system prompt ganhou a seção `## Arquivos` (`uploadGuide`).

### App

- Anexar: ⌘V na caixa (arquivos copiados no Finder, ou PNG/TIFF sem RTF; TIFF vira PNG), arrastar para a conversa inteira (overlay "Solte para anexar"), "+" → "Anexar arquivo…" (NSOpenPanel, vários). Até 10 por mensagem. Grupos não têm anexo.
- Caixa: faixa de chips no topo, dentro da caixa (padding `Spacing.m`, rola na horizontal, 44 pt de altura); embaixo a linha "+ | texto | mic | enviar" alinhada ao fundo. Imagem/vídeo em miniatura (vídeo com ▶ e duração), áudio com onda (do servidor, ao terminar o upload) e duração, arquivo com ícone e nome; x dentro do canto. Upload começa na hora, com anel de progresso; falha → toque para tentar de novo. Enviar com upload em andamento espera e envia sozinho ("Enviando os anexos…").
- Conversa: anexos acima do texto da bolha (mensagem só com anexo também vira bolha). Imagens em grade (1 grande; 2/4 em 2 colunas; senão 3) que abrem no QuickLook (com setas entre as imagens da mensagem); vídeo com miniatura e player AVKit inline ao tocar (streaming por Range); áudio com player compacto (play/pausa, onda clicável para pular, tempo), um tocando por vez; arquivo como card que abre no QuickLook. Arquivos baixam para `~/Library/Caches/runelay bots/attachments/<id>/`.
- `file.sent` vira um card/miniatura do lado do bot; a linha da ferramenta `send_file` concluída fica escondida.

### Verificado 19/11

Bot "Teste Anexos" (Sonnet 5.5, `vps:claude`). Imagem 2400×1800 (fundo vermelho, retângulo azul, quadrado amarelo) → descrita certo, a partir do `model.jpg` 1568 px. Áudio feito com `say -v Luciana` (aiff, 8,3 s), enviado sem texto → transcrição exata ("…a senha secreta é girassol azul…") e resposta certa. Vídeo ffmpeg 12 s (vermelho/verde/azul + seno 440 Hz) → 6 quadros, o modelo descreveu as cores em ordem e o som como bipe sem fala. PDF feito à mão → código e faturamento certos (anydoc; o pdftotext também extraiu). `.docx` com imagem embutida e `.xlsx` gerados no container → anydoc deu markdown e tabela; a imagem do docx foi como bloco de imagem e o modelo a descreveu. `send_file` com o print do browser → `file.sent` com miniatura. Range (206) e `thumb.jpg` conferidos por curl. Build do Mac + `make-app.sh` assinado "runelay bots Local". Não testado ao vivo: Codex/Cursor/Grok com anexo (só o caminho no texto), upload perto de 100 MB, arquivo `.doc`/`.pptx`/`.epub` reais.
