# Autenticação

Contas, sessões e chaves de API do servidor. Tudo passa pelo [better-auth](https://better-auth.com) 1.7.26 (versão fixa), com as tabelas no mesmo banco SQLite do servidor (`apps/server/src/db/schema/auth.ts`).

## v32 (19/11): contas, sessões e chaves

### Liga e desliga

- `BOTS_AUTH=on` liga a autenticação. Sem ela (padrão enquanto a fase 2 não termina), o servidor se comporta como antes e as rotas abaixo não existem: `GET /auth/setup` responde 404 e o app entende que o servidor não exige login. (Mudou na v36: sem valor é o modo automático.)
- `BETTER_AUTH_URL`: endereço público do servidor, o mesmo que o app usa (ex.: `https://vps.exemplo.ts.net:10447`). Define a origem confiável, o `rpID` da passkey e o domínio do cookie. Sem ela: `http://GATEWAY_HOST:GATEWAY_PORT`.
- `BETTER_AUTH_SECRET`: chave das assinaturas. Sem ela, o servidor gera uma no primeiro boot e grava no `.env.local` (modo 600). Se o arquivo for somente leitura (o compose monta assim), grava em `data/auth.secret` (modo 600) e lê de lá nos boots seguintes. O valor nunca aparece em log.
- `BETTER_AUTH_TRUSTED_ORIGINS`: outras origens aceitas, separadas por vírgula (opcional).

### Plugins

| Plugin | Para quê |
| --- | --- |
| e-mail e senha | login no app e na página `/device`. Cadastro aberto desligado (`disableSignUp`). Senha de 10 a 256 caracteres |
| `bearer` | o app nativo manda `Authorization: Bearer <token>` em vez de cookie. O token sai no header `set-auth-token` do login |
| `@better-auth/passkey` | Touch ID. `rpID` = host de `BETTER_AUTH_URL` |
| `@better-auth/api-key` | chave do runner do Mac e de automações. Prefixo `rbk_`, guardada com hash, sem vencimento e sem limite de uso por chave |
| `admin` | papéis `owner` (dono) e `member` |
| `deviceAuthorization` | login do app pelo navegador (RFC 8628), que é onde a passkey funciona |

Sessão: 30 dias, renovada a cada 24 h de uso. Sair (`POST /api/auth/sign-out`) revoga na hora.

### Rotas livres

Só estas passam sem sessão nem chave:

| Rota | Por quê |
| --- | --- |
| `GET /health` | healthcheck do compose |
| `/api/auth/*` | rotas do próprio better-auth (login, passkey, device, sign-out) |
| `GET /device` | página do navegador que aprova o app |
| `GET` e `POST /auth/setup` | primeiro acesso (só funciona sem nenhum usuário) |
| `POST /auth/invites/accept` | entrar com convite |
| `POST /mcp/:botId/:sessionId` | já exige o token por sessão do gateway MCP |
| `/preview/*` e o tráfego com o cookie `rb_preview` | já exigem o token da prévia |

Todo o resto (REST, streams NDJSON/SSE e os WebSockets `/runner/connect`, navegador ao vivo, desktop e voz) exige uma destas credenciais:

- `Authorization: Bearer <token da sessão>`;
- `Authorization: Bearer rbk_…` ou `x-api-key: rbk_…` (chave de API);
- o cookie de sessão do better-auth (usado pelos `WKWebView` do app e pela página `/device`). Com cookie, um `POST`/`PUT`/`DELETE` ou upgrade de WebSocket que traga `Origin` de fora das origens confiáveis leva 403.

Sem credencial válida: `401` com `www-authenticate: Bearer realm="runelay-bots"` e `{ "ok": false, "error": "Entre de novo para continuar.", "code": "unauthorized" }`.

Rate limit: login por senha 5 por minuto por IP, verificação de passkey 10, pedido e aprovação de código de dispositivo 10, demais rotas do better-auth 120. `POST /auth/setup` e `POST /auth/invites/accept`: 5 por minuto por IP (429 com `retry-after`). O IP vem de `x-forwarded-for` (o `tailscale serve` preenche).

### Primeiro acesso e convites

1. `GET /auth/setup` → `{ ok, needsOwner }`.
2. Sem nenhum usuário, `POST /auth/setup` com `{ name, email, password }` cria o dono (`owner`) e já devolve o token. Uma vez só: depois disso responde 409 `setup_closed`.
3. O dono convida: `POST /auth/invites` com `{ email? }` → `{ id, code, email, role, expiresAt }`. O código (`rbi_…`) aparece só nessa resposta e vale 7 dias, uma vez. `GET /auth/invites` lista os abertos; `DELETE /auth/invites/:id` cancela. Membro recebe 403.
4. A pessoa entra com `POST /auth/invites/accept` e `{ code, name, email, password }` → token. Se o convite tem e-mail, tem que ser o mesmo.

### App do Mac

- **Senha**: `POST /api/auth/sign-in/email` com `{ email, password }` → o token vem em `set-auth-token`.
- **Touch ID**: o app pede `POST /api/auth/device/code` com `{ client_id: "runelay-bots-mac" }`, abre `verification_uri_complete` numa `ASWebAuthenticationSession` e consulta `POST /api/auth/device/token` (`grant_type=urn:ietf:params:oauth:grant-type:device_code`) no intervalo pedido. Na página `/device` a pessoa entra com a passkey (Touch ID do Safari) ou com senha, confere o código e libera. A página então abre `runelaybots://device-approved`, que fecha a janela, e o app recebe `access_token`, que é um token de sessão. Logada por senha no navegador, a página oferece "Ativar Touch ID neste Mac" para registrar a passkey.
- Passkey nativa (`ASAuthorizationPlatformPublicKeyCredentialProvider`) exige o app assinado por um time da Apple com Associated Domains apontando para o servidor. O app é assinado com um certificado local, então a passkey passa pelo navegador.
- Depois do login: `GET /auth/me` → usuário, validade e o cookie de sessão assinado, que o app instala em `HTTPCookieStorage` e no `WKWebsiteDataStore` para as páginas de artefato e canvas. Em seguida `POST /auth/runner-key` gera a chave do runner.
- Token e chave do runner ficam no Keychain (`com.runelay.bots.auth`, por origem do servidor, `AfterFirstUnlockThisDeviceOnly`), nunca em `UserDefaults`. O cookie é de sessão (sem `expires`): não vai para o disco e é reinstalado a cada abertura do app.
- Qualquer 401 do servidor com token salvo apaga o token e mostra o login por cima da tela, sem desmontar o que estava aberto.

### Runner do Mac

- `POST /auth/runner-key` (só com sessão; com chave de API dá 403) apaga a chave `mac-runner` anterior da pessoa e cria outra → `{ id, key, name }`. A chave aparece só nessa resposta.
- O runner conecta em `/runner/connect` com `Authorization: Bearer rbk_…`. O cofre usa a mesma chave.
- Com `BOTS_AUTH` desligado, o runner continua com o `RUNNER_TOKEN` de antes (o app cai no arquivo `runner.token` se não houver chave no Keychain).

### Dono por recurso (fase 2)

Bots, conversas, cofre e arquivos ganham `owner_id` (`ownerId()` em `db/schema/auth.ts`, `references user.id on delete cascade`). Na fase 1 só o desenho; cada service passa a filtrar por dono na fase 2. O `principalOf(request)` de `modules/auth/gate.ts` entrega `{ userId, role, method }` para isso.

### Verificado

Capturado do módulo de auth rodando com o better-auth real e banco em memória (`BETTER_AUTH_URL=https://bots.example.ts.net`). Tokens, chaves e códigos trocados por `…`.

```text
GET /auth/setup -> 200
{"ok":true,"needsOwner":true}

POST /auth/setup -> 201
{"ok":true,"token":"…","user":{"id":"rIrbL2L2plffQbw0nkRReELrCbhm8mRR","name":"Dono","email":"owner@example.com","role":"owner"}}

POST /auth/setup -> 409
{"ok":false,"error":"O dono já foi criado. Peça um convite.","code":"setup_closed"}

POST /api/auth/sign-in/email -> 200 (set-auth-token: …)
{"redirect":false,"token":"…","user":{"name":"Dono","email":"owner@example.com","emailVerified":false,"image":null,"createdAt":"2026-11-19T21:56:41.417Z","updatedAt":"2026-11-19T21:56:41.417Z","role":"owner","banned":false,"banReason":null,"banExpires":null,"id":"rIrbL2L2plffQbw0nkRReELrCbhm8mRR"}}

GET /auth/me -> 200
{"ok":true,"user":{"id":"rIrbL2L2plffQbw0nkRReELrCbhm8mRR","name":"Dono","email":"owner@example.com","role":"owner"},"method":"session","expiresAt":"2026-12-19T21:56:41.465Z","cookie":{"name":"__Secure-better-auth.session_token","value":"…"}}

GET /bots -> 401
{"ok":false,"error":"Entre de novo para continuar.","code":"unauthorized"}

POST /auth/invites -> 201
{"ok":true,"id":"01M7TWZNXEJ1MMP75Q6T62NAS1","code":"rbi_…","email":"member@example.com","role":"member","expiresAt":"2026-11-26T21:56:41.518Z"}

POST /auth/runner-key -> 201
{"ok":true,"id":"pFzrncjcmQLUB9pWNVcY0zjM0fvJmeg6","key":"…","name":"mac-runner"}

POST /api/auth/device/code -> 200
{"device_code":"…","user_code":"EM9ZUKMS","verification_uri":"https://bots.example.ts.net/device","verification_uri_complete":"https://bots.example.ts.net/device?user_code=EM9ZUKMS","expires_in":600,"interval":5}
```

## v36 (19/11): primeiro acesso pelo app e portão automático

### Modo do portão

`BOTS_AUTH` deixa de ser obrigatório. Três modos:

| `BOTS_AUTH` | Comportamento |
| --- | --- |
| sem valor (padrão) | **automático**. O módulo de auth sobe sempre. Sem nenhum usuário, o servidor segue aberto como antes e só responde as rotas de auth (`/auth/*`, `/api/auth/*`, `/device`). Assim que o dono é criado, o portão liga na hora, sem reiniciar, e continua ligado nos boots seguintes |
| `on` (ou `true`, `1`) | força o portão desde o boot, mesmo sem usuário (todo o resto dá 401 até criar o dono) |
| `off` (ou `false`, `0`) | desliga o módulo: `GET /auth/setup` dá 404, como num servidor antigo |

No log do boot: `auth waiting for the owner (…)` no modo automático sem usuário, `auth on (…)` com o portão ligado.

### `GET /auth/setup`

Ganhou `required` e `methods`. O app decide o fluxo só por esta resposta:

- `404`: servidor sem login (antigo ou `BOTS_AUTH=off`). O app pula o fluxo de conta.
- `needsOwner: true`: ninguém criou conta ainda. O app mostra "Configurar este runelay bots".
- `required: false`: o portão ainda não está ligado (modo automático sem dono). O app oferece "Agora não" e segue sem conta até a próxima abertura.
- `methods.passwordReset`: `false` enquanto o servidor não tem e-mail configurado. O app só mostra "Esqueci a senha" com `true`.

### Dono e dados existentes

- `POST /auth/setup` continua uma vez só. Ao criar o dono, o servidor grava `auth:owner` na tabela `settings` com `{ userId, claimedAt }`. Bots, conversas, cofre e arquivos que já existiam continuam iguais: nada é filtrado por dono nesta fase, então a instalação inteira passa a ser da conta dona. A fase 2 usa esse registro para preencher `owner_id`.
- Depois do dono, cadastro só por convite (`POST /auth/invites` → `POST /auth/invites/accept`), sem mudança.

### Tokens internos com o portão ligado

- `Authorization: Bearer <RUNNER_TOKEN>` (o `runner.token` do `data/` ou a variável) vale como credencial interna em qualquer rota e no `WebSocket /runner/connect`. O principal é o dono (`method: "internal"`, `role: "owner"`); sem dono ainda, `userId: "internal"`. Token com menos de 24 caracteres não vale.
- Continua valendo a chave `rbk_…` gerada por `POST /auth/runner-key`. O app novo usa a chave; o app antigo e o executor do Mac seguem com o `runner.token`.

### Troca de senha e saída

- Trocar a senha: `POST /api/auth/change-password` (rota do better-auth) com `{ currentPassword, newPassword, revokeOtherSessions: true }` e a sessão no Bearer. Volta `{ token, user }` e o header `set-auth-token` com a sessão nova; todas as outras sessões, inclusive a que pediu, deixam de valer. Senha atual errada: 400 `INVALID_PASSWORD`. Limite: 5 por minuto por IP.
- Sair: `POST /api/auth/sign-out`, sem mudança.

### App

- Fluxo no molde da runelay: boas-vindas e endereço do servidor (só numa instalação nova), conta (dono, entrar ou convite) e "Primeiros passos" num trilho de 6 etapas: perfil (nome e foto), primeiro bot, contas de IA, integrações, conectores e uso do Mac. As três últimas são opcionais; cada etapa tem "depois". O progresso fica salvo no Mac por servidor e por conta (`onboarding.v2.<origem>.<userId>`), então toda conta nova vê o setup, inclusive o dono criado num servidor que já tinha sido usado antes do login. Ajustes › Conta › "Configurar de novo" e o menu do app "Configurar de novo…" reabrem. O nome muda por `POST /api/auth/update-user` (bearer).
- Instalação que já tinha dados e servidor sem dono: abre direto em "Configurar este runelay bots", avisando que os bots e conversas continuam e passam a ser da conta.
- Sessão no Keychain (`com.runelay.bots.auth`), como na v32. Sair e trocar senha em Ajustes › Conta.

### Verificado

Instância separada (`GATEWAY_PORT=2100`, `BOTS_SCHEDULES=off`, cópia do `data/` de produção com 25 bots e 31 conversas no banco, sem usuário). Tokens trocados por `…`.

```text
boot: auth waiting for the owner (http://127.0.0.1:2100, secret from data-file)

GET /auth/setup -> 200
{"ok":true,"needsOwner":true,"required":false,"methods":{"password":true,"passkey":true,"device":true,"invites":true,"passwordReset":false}}

GET /bots (sem credencial, antes do dono) -> 200, 4 bots

POST /auth/setup -> 201
{"ok":true,"token":"…","user":{"id":"vUvG9KvCRMPwtWrCL6emiewKzmtA6PZJ","name":"Teste Dono","email":"dono@example.com","role":"owner"}}

GET /auth/setup -> 200
{"ok":true,"needsOwner":false,"required":true,"methods":{"password":true,"passkey":true,"device":true,"invites":true,"passwordReset":false}}

GET /bots (sem credencial) -> 401
{"ok":false,"error":"Entre de novo para continuar.","code":"unauthorized"}

GET /bots (sessão do dono) -> 200, os mesmos 4 bots
GET /bots (Bearer RUNNER_TOKEN) -> 200

GET /auth/me (Bearer RUNNER_TOKEN) -> 200
{"ok":true,"user":{"id":"vUvG9KvCRMPwtWrCL6emiewKzmtA6PZJ","name":"Teste Dono","email":"dono@example.com","role":"owner"},"method":"internal","expiresAt":null}

settings: auth:owner = {"userId":"vUvG9KvCRMPwtWrCL6emiewKzmtA6PZJ","claimedAt":"2026-11-19T23:24:03.821Z"}

POST /auth/setup (de novo) -> 409
{"ok":false,"error":"O dono já foi criado. Peça um convite.","code":"setup_closed"}

sem credencial / sessão / RUNNER_TOKEN
/health 200/200/200 · /meta 401/200/200 · /status 401/200/200 · /accounts 401/200/200 · /vault/secrets 401/200/200

WS /runner/connect: sem credencial recusado · RUNNER_TOKEN abre · chave rbk_ abre

POST /api/auth/change-password (senha atual errada) -> 400
{"message":"Invalid password","code":"INVALID_PASSWORD"}

POST /api/auth/change-password -> 200 (set-auth-token: …)
{"token":"…","user":{"name":"Teste Dono","email":"dono@example.com",…,"role":"owner",…}}
depois: sessão antiga 401 · sessão que pediu 401 · sessão nova 200

POST /api/auth/sign-out -> 200 {"success":true}; depois 401

reinício sem variável: auth on (http://127.0.0.1:2100, secret from data-file); GET /bots sem credencial -> 401
```

## v37 (19/11): foto da conta

### Rotas

Todas pedem sessão (ou chave `rbk_…`, ou `RUNNER_TOKEN` com dono criado). Sem credencial: 401.

| Rota | Corpo | Resposta |
| --- | --- | --- |
| `PUT /auth/me/avatar` (ou `POST`) | bytes da imagem, `content-type` `image/png`, `image/jpeg` ou `image/webp`, até 2 MB | `200 { ok, image }` |
| `DELETE /auth/me/avatar` | vazio | `200 { ok, image: null }` |
| `GET /auth/avatars/:userId/:arquivo` | | os bytes, com `content-type` da imagem e `cache-control: private, max-age=31536000, immutable` |

- A imagem vai para o `BlobStore` em `users/<userId>/avatar/<arquivo>` e o caminho de serviço (`/auth/avatars/<userId>/<arquivo>`) fica no campo `image` do usuário do better-auth. Cada envio gera um arquivo novo e apaga o anterior; por isso o cache pode ser eterno.
- O servidor confere a assinatura do arquivo (PNG, JPEG ou WebP) e o tamanho. Não recorta nem redimensiona: o app manda o recorte quadrado pronto (512×512).
- `GET /auth/me` ganha `user.image` (`null` sem foto). O app baixa a foto pelo caminho com o próprio Bearer.
- Servidor sem login (`GET /auth/setup` 404): não há foto no servidor. O app mostra o nome e a foto da conta do macOS.

### Erros

| Caso | Status | Corpo |
| --- | --- | --- |
| tipo não aceito ou corpo vazio | 400 | `{ ok: false, error, field: "image" }` |
| bytes não batem com o tipo | 400 | `{ ok: false, error: "O arquivo não é a imagem que diz ser.", field: "image" }` |
| mais de 2 MB | 413 | `{ ok: false, error, field: "image", code: "too_large" }` |
| credencial sem conta (`RUNNER_TOKEN` antes do dono) | 404 | `{ ok: false, error: "Conta não encontrada.", code: "not_found" }` |
| arquivo que não existe mais | 404 | `{ ok: false, error: "Foto não encontrada.", code: "not_found" }` |

### Verificado

Instância separada (`GATEWAY_PORT=2100`, `BOTS_SCHEDULES=off`, `BLOB_DRIVER=fs`, cópia do banco de produção). Tokens trocados por `…`.

```text
GET /auth/me -> 200
{"ok":true,"user":{"id":"kE53UMUWZX4ROjBdDL1WrUaCAto1vmlD","name":"Teste Dono","email":"dono@example.com","role":"owner","image":null},"method":"session","expiresAt":"2026-12-19T23:31:33.979Z","cookie":{"name":"better-auth.session_token","value":"…"}}

PUT /auth/me/avatar (image/png, 74 bytes) -> 200
{"ok":true,"image":"/auth/avatars/kE53UMUWZX4ROjBdDL1WrUaCAto1vmlD/mwo6pczc-9be4f70e.png"}

GET /auth/me -> 200
{"ok":true,"user":{…,"role":"owner","image":"/auth/avatars/kE53UMUWZX4ROjBdDL1WrUaCAto1vmlD/mwo6pczc-9be4f70e.png"},…}

GET /auth/avatars/kE53UMUWZX4ROjBdDL1WrUaCAto1vmlD/mwo6pczc-9be4f70e.png -> 200
Content-Type: image/png
Cache-Control: private, max-age=31536000, immutable
X-Content-Type-Options: nosniff
content-length: 74
(mesmos bytes enviados)

GET (sem credencial) -> 401
{"ok":false,"error":"Entre de novo para continuar.","code":"unauthorized"}

PUT /auth/me/avatar (image/gif) -> 400
{"ok":false,"error":"Envie uma imagem PNG, JPEG ou WebP.","field":"image"}

PUT /auth/me/avatar (2,2 MB) -> 413
{"ok":false,"error":"A imagem passa de 2 MB.","field":"image","code":"too_large"}

PUT /auth/me/avatar (de novo) -> 200
{"ok":true,"image":"/auth/avatars/kE53UMUWZX4ROjBdDL1WrUaCAto1vmlD/mwo6pd1v-2825bfc5.png"}
GET da foto anterior -> 404 {"ok":false,"error":"Foto não encontrada.","code":"not_found"}
blobs/users/kE53UMUWZX4ROjBdDL1WrUaCAto1vmlD/avatar/ -> só o arquivo novo

DELETE /auth/me/avatar -> 200
{"ok":true,"image":null}
blobs/users/…/avatar/ -> vazio

GET /auth/me (Bearer RUNNER_TOKEN) -> 200
{"ok":true,"user":{"id":"kE53UMUWZX4ROjBdDL1WrUaCAto1vmlD","name":"Teste Dono","email":"dono@example.com","role":"owner","image":null},"method":"internal","expiresAt":null}
```

## v41 (20/11): login obrigatório

### Servidor

- O portão está sempre ligado. Sem nenhum usuário, só respondem `GET /health`, as rotas de primeiro acesso (`GET`/`POST /auth/setup`), `POST /auth/invites/accept`, `/api/auth/*` e `GET /device`. Todo o resto dá 401. O modo automático da v36 (aberto até criar o dono) saiu.
- `BOTS_AUTH=off` só vale em teste (`NODE_ENV=test`, que o `bun test` define, ou `BOTS_TEST=1`/`true`). Em qualquer outro ambiente o valor é ignorado e o portão continua ligado. `BOTS_AUTH=on` deixou de existir como opção (é sempre assim).
- `GET /auth/setup` responde `required: true` sempre. O campo fica por compatibilidade.
- `RUNNER_TOKEN` (≥24 caracteres) continua valendo como credencial de máquina em qualquer rota, inclusive antes do dono (principal `userId: "internal"`), até o executor do Mac virar dispositivo. Ele não administra contas: `/auth/invites*` com `method: "internal"` dá 403.
- Log do boot: `auth on, waiting for the owner (…)` sem usuário, `auth on (…)` com dono.
- O binário compilado (`bun build --compile`) carrega `reflect-metadata` na primeira linha de `src/index.ts`; sem isso o `tsyringe` do plugin de passkey derruba o boot (o bundler avalia o `tsyringe` antes do polyfill que o `@peculiar/x509` importa).
- `BETTER_AUTH_URL` precisa ser o endereço que o app usa (no tailnet, `https://<host>:10447`). Sem ela, o login do app leva 403 `INVALID_ORIGIN`, porque o app manda `Origin` com o endereço do tailnet.
- Healthcheck do compose passou para `/health` (`/bots` agora dá 401).
- Operação: `GET /status` exige credencial. Antes de reiniciar, `curl -s -H "Authorization: Bearer $RUNNER_TOKEN" 127.0.0.1:2000/status`.

### App

- Não existe mais uso sem conta: saíram o bloco "Neste Mac" (nome e foto do macOS), o "Agora não" do primeiro acesso, o pular quando `/auth/setup` dá 404 e o menu da barra lateral sem "Sair".
- Sem sessão: tela de entrar ou de primeiro acesso. `/auth/setup` 404: tela "Este servidor está desatualizado" com o campo do endereço. Servidor fora do ar e sem sessão salva: "Não deu para falar com o servidor", também com o campo.
- Ajustes › Conta mostra só a conta: foto, nome, e-mail, trocar senha e sair.

### Verificado

Produção (container `runelay-bots`, imagem `runelay-bots-server:release-b75488d`), antes e depois. `RUNNER_TOKEN` = credencial de máquina.

```text
antes (release-f04bdae): /bots, /status, /accounts, /integrations, /meta sem credencial -> 200; /auth/setup -> 404

boot: auth on, waiting for the owner (https://vps.…:10447, secret from data-file)

                 sem credencial   RUNNER_TOKEN
/health          200              200
/bots            401              200
/status          401              200
/accounts        401              200
/integrations    401              200
/meta            401              200
/vault/secrets   401              200
/usage/limits    401              200
/auth/setup      200              200
tailnet /health 200 · /bots 401

GET /auth/setup -> 200
{"ok":true,"needsOwner":true,"required":true,"methods":{"password":true,"passkey":true,"device":true,"invites":true,"passwordReset":false}}

bots 4 (boss, davi, engenheiro-de-software, qa), uma conversa cada; banco 25 bots, 31 threads, 0 usuários (igual ao antes)
integrações elevenlabs/jev/runelay connected; contas vps:claude, vps:codex, mac:claude, mac:codex, mac:cursor ready (igual ao antes)
log: mac runner connected (RUNNER_TOKEN)

instância de teste, BETTER_AUTH_URL ausente: POST /api/auth/sign-in/email com Origin do tailnet -> 403 {"code":"INVALID_ORIGIN"}
com BETTER_AUTH_URL: -> 200
```

## v42 (20/11): tela de login e provedores sociais

### `GET /auth/providers` (pública)

```text
GET /auth/providers -> 200
{"ok":true,"providers":[],"methods":{"password":true,"passkey":true,"device":true,"invites":true,"passwordReset":false}}
```

- `providers` lista, na ordem `apple`, `google`, `github`, só os que têm as duas variáveis: `APPLE_CLIENT_ID`/`APPLE_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`. Sem nenhuma, `[]`. Com Apple, `https://appleid.apple.com` entra nas origens confiáveis.
- O callback de cada provedor é o do better-auth: `<BETTER_AUTH_URL>/api/auth/callback/<provedor>`.
- Cadastro continua só por convite: os provedores sobem com `disableImplicitSignUp`, então só entra quem já tem conta com o mesmo e-mail.

### Login social pelo app

1. O app pede o código de dispositivo como no Touch ID e abre `verification_uri_complete` com `&provider=<id>`.
2. A página `/device`, sem sessão, chama `POST /api/auth/sign-in/social` com `{ provider, callbackURL: "/device?user_code=…", errorCallbackURL: "/device?user_code=…", disableRedirect: true }` e segue para o `url` devolvido.
3. Na volta, com a sessão do provedor, a página mostra "Liberar o app" como no fluxo da v32. Se o provedor recusar, volta com `error`: `signup_disabled` vira "Essa conta ainda não tem acesso. Peça um convite."; o resto, "Não deu para entrar com essa conta."

### Manter conectado

`POST /api/auth/sign-in/email` recebe `rememberMe`. `true` (padrão no app): sessão de 30 dias. `false`: sessão de 1 dia (padrão do better-auth para `dontRememberMe`).

### App

- Tela dividida: formulário à esquerda (sem cabeçalho de logo desde 20/11; "Não tem conta?" + "Usar convite" no canto superior direito, na altura dos botões da janela; selo com o ícone do app (`RunelayAppMark`, o mesmo da barra) no halo em todas as variantes, título, botões sociais e "OU" só quando `providers` não está vazio, e-mail e senha com rótulo, asterisco, ícone e olho, "Manter conectado", "Esqueci a senha?" só com `methods.passwordReset`, botão escuro "Entrar", rodapé com "© 2026 runelay bots", o servidor (volta para a escolha do endereço) e "PT"). À direita, numa superfície de contraste com grade sutil: três personagens de pontos animados e três frases que trocam a cada 6 s com fade, param com o mouse em cima e têm indicador clicável.
- Primeiro acesso ("Configure seus bots na runelay", subtítulo "Crie a conta dona deste servidor para começar."; até 20/11 era "Configurar este runelay bots") e convite ("Criar conta com convite") usam o mesmo layout, trocando título e campos.
- Abaixo de 900 pt de largura o painel da direita some.
- Touch ID continua como "Entrar com Touch ID" abaixo do botão principal.

### Verificado

Testes do módulo de auth com o better-auth real: `socialFromEnv` só aceita par completo; módulo com GitHub e Apple lista `["apple","github"]`, `/auth/providers` é pública, e `POST /api/auth/sign-in/social` com `provider: "github"` devolve 200 com `url` começando em `https://github.com/login/oauth/authorize`.

Produção (`release-955354f`): `/auth/providers` 200 sem credencial com `providers: []`; `/bots`, `/status`, `/accounts`, `/integrations` 401 sem credencial e 200 com `RUNNER_TOKEN`; 4 bots com uma conversa cada, banco 25/31/0, integrações conectadas e contas do Mac `ready` depois de o app reconectar.
