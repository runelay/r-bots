# Autenticação

Contas, sessões e chaves de API do servidor. Tudo passa pelo [better-auth](https://better-auth.com) 1.7.26 (versão fixa), com as tabelas no mesmo banco SQLite do servidor (`apps/server/src/db/schema/auth.ts`).

## v32 (19/11): contas, sessões e chaves

### Liga e desliga

- `BOTS_AUTH=on` liga a autenticação. Sem ela (padrão enquanto a fase 2 não termina), o servidor se comporta como antes e as rotas abaixo não existem: `GET /auth/setup` responde 404 e o app entende que o servidor não exige login.
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
