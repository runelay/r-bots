# Integrações

## v35 (19/11): integrações configuradas pelo app, sem editar `.env.local`

As chaves dos serviços externos (ElevenLabs, Jev, runelay) são coladas no app, em Configurações › Integrações. O servidor valida na hora, guarda cifrado no SQLite e nunca devolve a chave. Todas são opcionais: sem cada uma, a parte que depende dela desliga sem erro. Código: `apps/server/src/modules/integrations/` (rotas, `integrations.service.ts` com definições e validação, `integration-store.service.ts` com cifra, leitura e avisos de mudança), `apps/server/src/config/runtime-secrets.ts` (tokens internos); app em `Features/Settings/IntegrationsSettings.swift`.

### Onde a chave fica

- Linha `integration:<id>` na tabela `settings` do SQLite: `{iv, tag, ct, keyRef, last4, url, validatedAt, savedAt}`. AES-256-GCM, IV de 12 bytes, AAD `runelay-bots:integration:v1:<id>`.
- Chave da cifra: a do cofre (`VAULT_KEY_FILE`, padrão `<data>/vault.key`, `keyRef: "vault"`). Se ela não existir, `<data>/integrations.key` (0600, gerada no primeiro uso, `keyRef: "data"`).
- O valor aberto entra na máscara (`rememberSecretValue`), então não aparece em log, evento nem saída de ferramenta. Filhos (Claude Code, Codex, Bash) continuam sem herdar as variáveis antigas.
- Uma linha que não abre mais (chave da cifra trocada ou apagada) aparece como `status: "invalid"` e a integração fica desligada até salvar de novo.

### Ordem de leitura

integração salva pelo app → variável de ambiente antiga (`ELEVENLABS_API_KEY`, `JEV_API_KEY`, `RUNELAY_MCP_TOKEN` + `RUNELAY_MCP_URL`) → desligado. A instalação que já usa `.env.local` continua funcionando sem mudar nada; salvar pelo app passa na frente do arquivo, e remover volta para o arquivo (se houver).

Trocar ou remover uma integração vale na hora, sem reiniciar: o runelay reconecta o cliente MCP e relê as conexões, a voz limpa o cache de vozes, Jev e uploads leem a chave a cada uso.

### Tokens internos

- `RUNNER_TOKEN`: sem a variável, é gerado no primeiro boot em `<data>/runner.token` (0600, 32 bytes base64url). O log mostra só o caminho: `runner token in <data>/runner.token`. O app pega a chave do runner sozinho no login (`/auth/runner-key`; login obrigatório desde a v38); antes do login, o arquivo vai para `~/Library/Application Support/runelay bots/runner.token` no Mac.
- `BETTER_AUTH_SECRET`: sem a variável, é gerado em `<data>/auth.secret` (0600). O servidor não escreve mais no `.env.local`.

### `GET /integrations` → 200

`last4` trocado por `wxyz` aqui; o resto como saiu do servidor.
```json
{"integrations":[
 {"id":"elevenlabs","name":"ElevenLabs","description":"Voz natural nas chamadas e transcrição de áudio no servidor.","unlocks":"Chamada de voz com os bots","fallback":"Sem ElevenLabs a chamada de voz fica desligada e os áudios são transcritos no Mac.","keyUrl":"https://elevenlabs.io/app/settings/api-keys","domain":"elevenlabs.io","needsUrl":false,"status":"connected","configured":true,"source":"app","last4":"wxyz","validatedAt":"2026-11-19T22:47:48.470Z","url":null},
 {"id":"jev","name":"Jev","description":"Decide sozinho as aprovações de rotina, percebe bot travado e faz a triagem do que é importante.","unlocks":"Aprovações automáticas","fallback":"Sem Jev toda ação de risco espera você aprovar e nada é marcado como lido sozinho.","keyUrl":"https://typesafe.ai","domain":"typesafe.ai","needsUrl":false,"status":"connected","configured":true,"source":"app","last4":"wxyz","validatedAt":"2026-11-19T22:47:48.663Z","url":null},
 {"id":"runelay","name":"runelay","description":"Conectores (Linear, GitHub, Supabase…), memória e skills compartilhadas em todos os bots.","unlocks":"Conectores, memória e skills","fallback":"Sem runelay os bots trabalham sem conectores, memória e skills.","keyUrl":"https://docs.runelay.com","domain":"runelay.com","needsUrl":true,"status":"not_configured","configured":false,"source":null,"last4":"","validatedAt":null,"url":null}]}
```
- `status`: `connected`, `not_configured` ou `invalid`.
- `source`: `app` (salva pelo app), `env` (variável antiga) ou `null`. Com `env`, `validatedAt` é `null` e `last4` vem da variável.
- `last4`: vazio quando a chave tem menos de 8 caracteres.
- `url`: só no runelay (endereço do MCP, não é segredo).

### `PUT /integrations/:id` `{key, url?}` → 200

Valida antes de gravar, com uma chamada barata:
- ElevenLabs: `GET /v1/user` com `xi-api-key`.
- Jev: uma pergunta `noul` mínima no `JEV_URL`.
- runelay: conecta no MCP do `url` (ou no salvo, ou no `RUNELAY_MCP_URL`) e chama `list_connections`.

Resposta: o mesmo objeto de um item do `GET`, com `source: "app"` e `validatedAt` novo. A chave nunca volta.

Erros:
- `400 {"ok":false,"error":"Cole a chave inteira.","field":"key"}` (menos de 8 caracteres, espaço no meio ou mais de 4096).
- `400 {"ok":false,"error":"Informe o endereço do seu runelay.","field":"url"}` / `"Endereço inválido."` (só http/https).
- `422 {"ok":false,"code":"invalid_key","status":"invalid","error":"O Jev recusou essa chave."}`; também `"O ElevenLabs recusou essa chave."`, `"O runelay recusou essa chave."`, `"Não consegui falar com o runelay nesse endereço."`, `"O <serviço> respondeu 503. Tente de novo em instantes."`. Uma chave recusada não apaga a que já estava salva.
- `404` para id desconhecido ou outro método.

### `DELETE /integrations/:id` → 200

Apaga a linha e esquece o valor da máscara. Devolve o item já com a fonte seguinte (`env` ou `not_configured`).

### `GET /meta` ganha `integrations`

```json
{"accents":[…],"capabilities":[…],"engine":"multi-provider","model":"claude-sonnet-5-5","efforts":[…],"integrations":{"elevenlabs":true,"jev":true,"runelay":false}}
```
O app usa isso para mostrar os atalhos. Servidor antigo sem o campo = tudo ligado.

### Sem cada chave

- **Jev:** as decisões caem no fallback que já existia (`decisions.service.ts`, "Jev desligado."): aprovação vai para a pessoa, sem detector de bot travado, a triagem marca tudo como não lido, o roteamento de grupo vai pelo primeiro mencionado ou pelo coordenador, a memória inteligente não decide sozinha. Nenhum erro na conversa.
- **ElevenLabs:** `GET /voice/voices` e `POST /bots/:id/voice/session` respondem `503 {"ok":false,"error":"Conecte o ElevenLabs em Configurações › Integrações para usar a voz."}`. Anexo de áudio é transcrito no Mac (o caminho que já existia quando o Scribe falha). Escolha: aviso com atalho, não voz do sistema. A chamada usa o Scribe realtime para ouvir, o VAD dele para dividir os turnos e o TTS em streaming para falar; trocar só a fala pelo `AVSpeechSynthesizer` não resolve a escuta, e refazer a escuta no aparelho com a tomada de turno e o barge-in atuais é outra feature.
- **runelay:** `/connectors`, `/skills` e o composer respondem `503 {"ok":false,"error":"runelay não está configurado no servidor."}`; os bots não recebem ferramentas de conector, memória nem skills.

### App

- Configurações › Integrações (ícone `key.horizontal`): lista no estilo da tela de Conectores, com o logo de cada serviço pelo mesmo `CatalogConnectorIcon` (ElevenLabs pelo Simple Icons, runelay pelo `RunelayMark`, Jev com monograma). Cada linha mostra Conectado / Não configurado / Chave inválida, o que a integração libera e o final da chave. Ao abrir: o que acontece sem ela, endereço (só runelay), `SecureField`, "Onde pego a chave?" (página oficial), Validar e salvar, Remover (só com `source: "app"`, com confirmação).
- Atalhos quando desligado: botão de chamada de voz fica apagado e mostra "Conecte o ElevenLabs para voz natural." com Conectar; a tela de Conectores mostra "Conectores e memória estão desligados" com Conectar runelay; o "Aprovar ações seguras automaticamente" do perfil mostra "Sem o Jev, toda ação de risco pede sua aprovação." com Conectar Jev.

### Verificado 19/11 (instância separada na 2100, `BOTS_SCHEDULES=off`, cópia de `data/` com banco novo, `env -i` e `bun --no-env-file`)

1. Sem nenhuma chave no ambiente: subiu, gerou `runner.token` (0600), `GET /integrations` com as três `not_configured`, `/meta` com tudo `false`, `/voice/voices` 503 com a frase acima, `/connectors` e `/skills` 503. Bot novo respondeu um turno inteiro ("ok, funcionando.") sem erro com o Jev desligado.
2. As três chaves reais do `.env.local` de produção salvas pela rota (lidas do arquivo, nunca impressas): 200, `connected`, `source: "app"`, `last4` de 4 caracteres, nenhuma resposta com a chave. `/meta` tudo `true`, `/voice/voices` 200, `/connectors` com 18 conexões, `/skills` 200. Chamada de voz abriu com tokens de STT e TTS e fechou. Turno seguinte rodou o Jev ao vivo (`jev jev-1.14.0 167ms 429 tok` no log).
3. Chave inválida no ElevenLabs: 422 "O ElevenLabs recusou essa chave." e a válida continuou salva.
4. Reinício: as três continuaram ligadas (lidas do SQLite). `DELETE /integrations/runelay` → `not_configured`, `/connectors` 503 e `/meta.runelay` `false` na hora.
5. `grep` das três chaves (puras e em base64) no `data/` de teste e nos logs: 0 arquivos.

Não testado ao vivo: as telas do app com a pessoa (build `make-app.sh` sem erros, sem prints).

## v51 (20/11): endurecimento do cofre, egress e deploy

- Formato v2 da chave guardada (mesmo esquema do cofre, ver [vault](vault.md#v51-2011-endurecimento-do-cofre-egress-e-deploy)): subchave HKDF-SHA256 com info `runelay-bots/integration/v2` a partir da chave do cofre (ou de `<dados>/integrations.key`), `iv` = `0x02` + id da chave + IV de 12 bytes, tag de 16 bytes conferida, AAD `runelay-bots:integration:v2:<id>:<url>`. Trocar a `url` guardada direto no banco invalida a chave (`status: "invalid"`).
- Linhas v1 continuam abrindo e são recifradas para v2 no boot, numa transação só; o log diz `integrations: re-encrypted N keys to v2`.
- A chave do cofre é aceita em 32 bytes crus, hex ou base64 de 32 bytes (o `vault.key` de produção é binário cru; a v2 recusava esse formato e as integrações gravadas antes dela viraram "inválidas" até o fix de 20/11), procurada em `VAULT_KEY_FILE`, `/run/secrets/vault.key`, `<dados>/vault.key`.
- `PUT /integrations/runelay`: `url` precisa ser `https://`; `http://` só para `127.0.0.1`, `[::1]` ou `localhost`. URL com usuário/senha é recusada. Erro: `400 {"ok":false,"error":"Endereço inválido: use https:// (http só para 127.0.0.1).","field":"url"}`.
- A validação do runelay passa por `guardedFetch` (`apps/server/src/shared/net-guard.ts`): endereço interno (rede privada, tailnet, metadata, nome que resolve para dentro) vira `422 "Não consegui falar com o runelay nesse endereço."`. Loopback só é aceito com `RUNELAY_ALLOW_LOOPBACK=1` no ambiente do servidor (runelay rodando na mesma máquina).
- `ELEVENLABS_API_URL` só vale com `https://` (ou `http://` em loopback); fora disso o servidor avisa no log e usa `https://api.elevenlabs.io`.
- `runner.token` muda a cada boot (32 bytes aleatórios, 0600). Nenhum cliente usa o arquivo (o app usa a chave do dispositivo); ele fica só para o operador na máquina: `curl -s -H "Authorization: Bearer $(cat ~/.local/share/runelay-bots/runner.token)" 127.0.0.1:2000/status`.

### Verificado

- `bun test src/modules/integrations/__tests__/integrations.test.ts`: 17 pass (inclui recifragem v1→v2, URL presa na AAD, runelay `http` recusado, probe sem loopback, rotação do `runner.token`).
