# Voz

## v13 (19/11): voice call with ElevenLabs

The app builds the call. The server never exposes ElevenLabs: it only mints single-use tokens (15 min, one connection each) and runs the fast voice layer. The ElevenLabs key lives in `.env.local` and never reaches the app.

Two layers:
- **Fast layer:** a warm Claude Haiku 5.5 session per call (Agent SDK on the subscription, streaming input, so the CLI process stays alive between lines). It confirms what it understood, fills the wait, asks approvals out loud, and summarizes the result in short speech. Measured on the VPS, from utterance POST to first speech text: 475–653 ms warm, against ~1.1 s cold `query()` per line and ~7.9 s for Codex CLI (`gpt-6-luna`). Override with `VOICE_FAST_MODEL`.
- **Bot layer:** the normal bot turn in the main thread, with the same tools, memory, approvals and history. Spoken user lines are ordinary deliveries with a voice mark.

### Bot field `voice`

`GET /bots` and `GET /bots/:id` carry `"voice":{"voiceId":"VNaz9wbhLsh3lLuHzAVP","speed":1}` (default: Ana Lu, pt-BR conversational; override with `VOICE_DEFAULT_ID`). `PATCH /bots/:id {"voice":{"voiceId"?,"speed"?}}` merges. `speed` runs from 0.7 to 1.2, otherwise 400 `field:"voice.speed"`. A bad id gives 400 `field:"voice.voiceId"`.

### `GET /voice/voices` → 200 (cached 10 min, `?refresh=1`)

```json
[{"voiceId":"VNaz9wbhLsh3lLuHzAVP","name":"Ana Lu","category":"professional","language":"pt","accent":"brazilian","gender":"female","description":"gentle","previewUrl":"https://storage.googleapis.com/…mp3"}]
```
Portuguese voices first, then by name. `previewUrl` is a public mp3, so the app plays it directly with no credits. 503 when ElevenLabs is not configured, 502 when it fails.

### `POST /bots/:id/voice/session` → 201

Opens the call: ends any previous call for the bot, warms the fast layer, and mints both tokens.
```json
{"callId":"call_5351d1c5176d4a57","sessionId":"wrun_…","streamPath":"/bots/lia/voice/session/call_…/stream","fastModel":"claude-haiku-5-5",
 "voice":{"voiceId":"VNaz9wbhLsh3lLuHzAVP","speed":1},
 "stt":{"url":"wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&language_code=pt&audio_format=pcm_16000&commit_strategy=vad&vad_silence_threshold_secs=0.5&token=sutkn_…","token":"sutkn_…","modelId":"scribe_v2_realtime","sampleRate":16000,"vadSilenceSecs":0.5},
 "tts":{"url":"wss://api.elevenlabs.io/v1/text-to-speech/VNaz…/multi-stream-input?model_id=eleven_flash_v2_5&output_format=pcm_24000&language_code=pt&inactivity_timeout=180&single_use_token=sutkn_…","token":"sutkn_…","modelId":"eleven_flash_v2_5","outputFormat":"pcm_24000","sampleRate":24000}}
```
`sessionId` is the bot's main thread. 409 `bot_deleted` / `bot_archived`, 503 without ElevenLabs.

Each call route below answers 404 `{"code":"call_not_found"}` once the call ends. A call ends on `DELETE`, or 90 s after its last stream listener leaves.

#### `POST /bots/:id/voice/session/:callId/tokens` → 200
Body `{"types":["tts"]}` (or `"stt"`, both by default). Same `voice` / `stt` / `tts` shape, with fresh tokens. Use it to reconnect a socket, because a token is consumed on use.

#### `GET /bots/:id/voice/session/:callId/stream` → NDJSON
Events, each with `at`:
- `call.ready {callId, sessionId, pending}`: `pending` is the open approval or `null`.
- `speech.started {id, kind, elapsedMs}`: `kind` is `ack` (answer to the person), `filler` (wait), `result` (summary), `error`, or `approval` (question, or the fixed "Beleza, seguindo." / "Tá bom, não vou fazer." / "Não entendi…"). `elapsedMs` is the time from the trigger to the first text.
- `speech.delta {id, text}`: send these to the TTS socket as they arrive.
- `speech.done {id, text}`: flush the TTS context.
- `speech.cancelled {id}`: interrupted, or the fast layer chose silence. Drop the context.
- `bot.state {state:"working"|"awaiting"|"idle", turnId, outcome?}`, `bot.tool {label, turnId}`.
- `approval.asked {interactionId, prompt}`, `approval.settled {interactionId, outcome}`.
- `call.ended`, and `heartbeat` every 15 s.

The fast layer speaks on its own as the thread moves:
- **filler:** on `call.requested`, at most 3 per turn, 6 s apart, and only when nothing else is speaking.
- **approval:** on `interaction.opened`.
- **result / error:** on `turn.settled`. The result is skipped when the person spoke again after that turn began. A `(silêncio)` answer is never streamed. When the reply is already short and speakable (≤ 350 chars after cleanup, no code block, table, heading or list over 2 lines), the reply itself is spoken, links reduced to their text; otherwise the fast layer summarizes it.
- **Thread:** the spoken result is never written as a new message: the thread keeps only the bot reply (with `voice:true`, so it gets the voice mark). Acks, fillers, approvals and errors are written as spoken lines (`spoken:true`). If an ack repeats the reply (half or more of its content words), it is removed at `turn.settled` by a `content.completed` with the same `partId`, `value:""` and `retracted:true`.

#### `POST /bots/:id/voice/session/:callId/utterance` → 202
Body `{"text":"…","interrupted"?:bool}` is one whole turn of the person, already joined by the app (see Turn taking). `interrupted:true` means the turn started by cutting the bot's voice. It does one of these:
- With no open approval and no bot turn running, or with `interrupted:true`, it cancels whatever the fast layer is saying, delivers the text to the main thread as a voice message and the fast layer acknowledges it once: `{"ok":true,"action":"message","deliveryId":"…","sessionId":"wrun_…","continuation":false}`.
- With a bot turn still running and `interrupted` false, the text is a complement: it is queued as the next delivery, nothing is cancelled, no ack is spoken, and the running turn's result is still spoken: `{…,"action":"message","continuation":true}`.
- With an open approval, it classifies the answer. Regex first (`sim`, `pode`, `claro`, `manda`… / `não`, `para`, `cancela`…), then the fast layer.
  - `{"ok":true,"action":"answer","interactionId":"…","optionId":"approve"|"deny"}`: **the app then answers through the existing route** (`POST {sessionBasePath}/session/:id {"answers":[…]}`).
  - `{"ok":true,"action":"repeat","interactionId":"…"}`: the server asks again.

#### `POST /bots/:id/voice/session/:callId/interrupt` → 200 `{"ok":true,"interrupted":"speech_…"|null}`
The person talked over the bot. It cancels the current fast-layer line and the queued ones; the bot turn keeps running.

#### `DELETE /bots/:id/voice/session/:callId` → 200

### Turn taking (app, 19/11)

The app owns turn taking, because only it sees partials, mic energy and whether the bot is audible. Scribe VAD closes after 0.9 s of silence (`VOICE_VAD_SILENCE`).
- **Joining:** after a commit the app waits 1.2 s; a new commit or a partial in that window joins the same turn (a partial extends the wait to 2.4 s). One turn is one POST `utterance` and one message in the thread.
- **Backchannel:** while the bot speaks, thinks or just spoke (2 s), a commit under 3 words that opens no turn is dropped when it is only fillers (`tá`, `uhum`, `ahn`, `ok`…) and otherwise carried into the next turn. With an open approval, short answers always go.
- **Barge-in:** only with the bot audible, energy over the playback threshold (0.62 on the 0…1 level, 0.45 otherwise) for 0.6 s and a partial of 3+ words that is not echo. Then the app stops playback, closes the TTS contexts and calls `interrupt`.
- **Echo:** transcripts heard while the bot is audible or up to 2 s after are dropped when they match what the bot said (bigram or word overlap ≥ 0.6). During playback the mic is half-duplex: chunks under the playback threshold go to Scribe as silence (0.4 s hangover).

### Voice mark in the thread

- `delivery.consumed.data.voice: true` on spoken lines.
- `content.completed.data.voice: true` on the reply parts of a voice turn.
- A voice turn gets an extra system note: answer short, result first, no tables.

### Client wiring (ElevenLabs)

- **Scribe:** send `{"message_type":"input_audio_chunk","audio_base_64":"…","commit":false,"sample_rate":16000}` with 16 kHz mono PCM16 chunks of about 100 ms, all the time, and silence while muted, because Scribe drops the socket after 15 s without messages. Read `partial_transcript` (live captions, barge-in) and `committed_transcript` (VAD end of turn, then POST `utterance`).
- **TTS (multi-context):**
  - Open the socket once per call.
  - For each `speech.started`, init a context: `{"text":" ","context_id":"<speech id>","voice_settings":{"stability":0.5,"similarity_boost":0.8,"speed":<voice.speed>}}`.
  - Send deltas with `{"text":"… ","context_id":…}`. Add `"flush":true` at sentence ends and on `speech.done`.
  - On barge-in or `speech.cancelled`, send `{"context_id":…,"close_context":true}`.
  - Audio comes back as base64 PCM16 at 24 kHz in `audio`, with `contextId`.
- **Measured (VPS → ElevenLabs):** first audio about 390–520 ms after the flushed text, and token mint about 330 ms.

---

## v25 (19/11): autonomia no código e nos conectores, skills garantidas no prompt, microfone

### Microfone (app)
- `Features/Voice/Microphones.swift`: lista de entrada pelo CoreAudio (sem os `CADefaultDeviceAggregate` do VP), escolha em UserDefaults `voiceInputDeviceUID`/`voiceInputDeviceName`, medidor ao vivo (`MicrophoneMeter`, engine só de entrada) e `MicrophoneCatalog` com listener de dispositivos.
- Seletor "Microfone" na engrenagem da chamada e em Ajustes › Voz ("Padrão do sistema" + dispositivos, barra de nível no escolhido).
- Medido no Mac (19/11): sem VP, a entrada e a saída do AVAudioEngine são o mesmo AUHAL; trocar o dispositivo nele mata a saída (-10875). Com VP, `kAudioOutputUnitProperty_CurrentDevice` no elemento 1 do VPIO aceita e lê de volta, mas o engine entra em loop de `AVAudioEngineConfigurationChange` com 0 buffers; `auAudioUnit.setDeviceID` no VPIO troca a SAÍDA. Por isso: escolhido = padrão do sistema → VP como antes; outro escolhido → engine de captura separado (só entrada, `setDeviceID`) + engine de saída, sem VP (o eco fica com o half-duplex e o descarte de eco do TurnTaker).
- Dispositivo escolhido sumiu → volta ao padrão com "O <nome> não está mais conectado. Voltei para o padrão do sistema." (chamada e ditado).
- Chamada: nos primeiros 3 s ouvindo, pico < 0,002 → "Não estou te ouvindo pelo <nome> · Trocar" na barra e abre o seletor. Ditado: o mesmo aviso no composer, com "Trocar".
- `scripts/voice-e2e` agora precisa de `Features/Voice/Microphones.swift` na lista do swiftc.

## v44 (20/11): endurecimento do cofre, egress e deploy

- `POST /bots/:id/voice/session` e `POST /bots/:id/voice/session/:callId/tokens`: no máximo 30 tokens de uso único por pessoa por minuto (cada tipo, `stt` ou `tts`, conta um) e 4 pedidos de token em andamento por pessoa. Acima disso: `429 {"ok":false,"error":"Muitos pedidos de token de voz agora. Espere um minuto e tente de novo."}`. A pessoa é o `userId` do principal autenticado.
- `ELEVENLABS_API_URL` só vale com `https://` (ou `http://` em loopback); fora disso o servidor usa `https://api.elevenlabs.io`.

### Verificado

- `bun test src/modules/voice/__tests__/voice.service.test.ts`: 31 pass (limite por pessoa, teto em andamento, URL insegura ignorada); `voice.routes.test.ts`: 10 pass.
