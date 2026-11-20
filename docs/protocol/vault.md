# Cofre de segredos

## v23 (19/11): cofre de segredos

O modelo nunca vê o valor. Segredos são chamados por apelido (`segredo:github-token`) e o valor entra só no último instante, dentro da ferramenta. Código: `apps/server/src/modules/vault/services/vault.service.ts` (cofre, regras, histórico, rotas), `apps/server/src/modules/vault/services/vault-tools.service.ts` (ferramentas e instruções), `apps/server/src/shared/redact.ts` (máscara), `apps/server/bin/rb-secret-run.mjs` (Bash); app em `Features/Vault/Vault.swift`, `Features/Vault/VaultStore.swift`, `Features/Conversation/Views/SecretFormCard.swift`, `Features/Vault/VaultScreen.swift`, `Features/Computer/Executor/FrontmostPage.swift`.

### Onde o valor fica

- **Padrão: Keychain do Mac.** Item `kSecClassGenericPassword`, serviço `com.runelay.bots.vault`, conta = nome, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, `kSecAttrSynchronizable = false` (não vai para o iCloud). As regras do segredo ficam no próprio item (`kSecAttrGeneric`, JSON), então o app confere a política com a cópia local, não com o que o servidor disser. O app tenta primeiro o Keychain de proteção de dados (com `SecAccessControl(.userPresence)` quando o Touch ID é "Sempre"); se a assinatura local não tiver o entitlement (`errSecMissingEntitlement`), cai no Keychain de login e o Touch ID é exigido pelo próprio app com `LAContext.evaluatePolicy(.deviceOwnerAuthentication)`. A assinatura estável "runelay bots Local" mantém o acesso entre versões.
- **Opção "usar com o Mac fechado"** (desligada por padrão, marcada na tela como menos segura): o app manda o valor uma vez (`PUT /vault/secrets/:name/server-copy`, só com HTTPS) e o servidor grava a cópia cifrada nas colunas `iv`, `tag` e `ciphertext` da tabela `vault_secrets` no Postgres (não existe mais arquivo `.enc`). Formato atual na seção v51. A chave mestra tem 32 bytes (crus, hex ou base64) e é procurada nesta ordem: `VAULT_KEY_FILE`, `/run/secrets/vault.key`, `<dados>/vault.key` (0600; o servidor não sobe se o arquivo for legível pelo grupo ou por outros). Trocar o valor apaga a cópia do servidor até o app mandar a nova.
- **Metadados sem valor** no servidor: tabela `vault_secrets` do Postgres (desde a v40; antes `data/vault/index.json`) com `{name, description, domains, bots, touchId, expiresAt, storage: "mac"|"mac+server", kind, createdAt, updatedAt, rotatedAt, lastUsedAt, lastUsedBy, lastTool}`. Histórico na tabela `vault_audit` (antes `data/vault/audit.ndjson`): `{at, name, outcome, botId, botName, tool, domain, source, reason, by}`, nunca o valor. `outcome`: `created`, `updated`, `rotated`, `deleted`, `used`, `denied`, `revealed`, `server_copy_on`, `server_copy_off`.

### Regras por segredo

- `domains`: lista de sites. `github.com` vale para `github.com` e `www.github.com`; `*.github.com` vale para o domínio e qualquer subdomínio. Vazio = qualquer site. Com domínios, uso sem site conhecido é negado.
- `bots`: vazio = todos (padrão); senão, só os ids da lista.
- `touchId`: `always` (a cada uso), `hourly` (primeiro uso de cada hora, por segredo, na memória do app), `never`.
- `expiresAt`: depois disso, negado. O formulário com "Salvar no cofre" desmarcado grava com validade de 1 h.
- Servidor e app checam as mesmas regras (o servidor antes de pedir, o app de novo antes de responder).

### Resolução (servidor ↔ app pelo WebSocket do runner)

O app anuncia `"vault"` em `hello.capabilities`. Servidor → app:
```json
{"type":"request","id":"…","op":"secret.resolve","body":{"name":"github-token","botId":"lia","botName":"Lia","tool":"browser_fill","domain":"github.com"}}
```
App → servidor: `{"type":"response","id":"…","ok":true,"result":{"value":"…"}}` ou `{"type":"response","id":"…","ok":false,"code":"denied_domain|denied_bot|expired|cancelled|not_found|insecure","error":"frase em pt-BR"}`. Timeout 95 s (tempo do Touch ID). O app recusa (`insecure`) se o servidor não for https/wss. Ordem no servidor: fonte externa registrada (ponto de extensão) → Mac (se conectado com `vault`) → cópia cifrada do servidor (só com `mac+server`, e só quando o Mac está offline ou não tem o item) → erro "o Mac está offline". O servidor usa o valor e descarta; nada é gravado.

### Onde a referência funciona

| Ferramenta | Como | Site checado |
| --- | --- | --- |
| `browser_fill` | `text: "segredo:nome"`. Só referência = sem card de aprovação (a política é o portão). Preenche por `agent-browser batch` com o comando no stdin (o valor não aparece na lista de processos) e depois marca o campo com `-webkit-text-security: disc` e `autocomplete=off`, para os prints seguintes mostrarem bolinhas. | host da página aberta |
| `computer_type` | `text: "segredo:nome"`. O servidor repassa a referência; o app resolve localmente no Keychain (o valor nem passa pela rede) e pode digitar em campo seguro só nesse caso. O app grava o uso com `POST /vault/audit`. | host do documento da janela da frente (AXDocument; Safari expõe, outros podem não expor → segredo com domínio é negado) |
| `http_request` (novo) | `{method, url, headers?, body?, reason?}`; referência em cabeçalhos, corpo e URL (não no host). Regras atuais de rede e aprovação na seção v51. | host da URL |
| Bash no modo código (Claude na VPS) | `$SEGREDO_NOME` / `${SEGREDO_NOME}` (nome em maiúsculas, hífen vira `_`) ou `segredo:nome`. Desde a v51 só vale uma chamada direta de `curl`, `gh` ou `git`, sem shell; regras na seção v51. | todos os hosts do comando (precisam estar nos sites do segredo; segredo sem sites = negado) |

Codex no modo código não tem hook: lá o segredo só serve pelas ferramentas MCP (`http_request`, `browser_fill`).

### Máscara (`apps/server/src/shared/redact.ts`)

Todo valor resolvido entra numa lista em memória por 30 min desde o último uso (sai antes ao apagar o segredo), com variantes: puro, escapado em JSON (1 e 2 níveis), URL-encoded, base64 (com e sem `=`) e base64url. São trocados por `••••` em: todo evento antes de gravar ou transmitir (`EventLog.emit` e `progress`), toda saída de ferramenta MCP que volta ao modelo, `stdout`/`stderr` do processo (logs do Docker), linhas do histórico, e a saída do Bash pelo helper. Valores com menos de 4 caracteres não são mascarados.

### Formulário seguro: `request_secret`

`request_secret({name, reason, description?, fields?: [{id, label, secure?}], domains?, kind?: "password"|"token"|"text"})`. Com mais de um campo, cada um vira `segredo:<name>-<id>`. Exige o app aberto (senão erro pedindo para abrir). Abre uma interação:
```json
{"type":"interaction.opened","data":{"interactionId":"…","request":{"kind":"secret","display":"secret_form","prompt":"Lia pediu um segredo: …","reason":"…",
 "options":[{"id":"approve","label":"Salvar"},{"id":"deny","label":"Agora não"}],
 "secret":{"name":"github-token","names":["github-token"],"reason":"…","description":"","kind":"password","fields":[{"id":"valor","label":"Valor","secure":true}],"domains":["github.com"],"botId":"lia","botName":"Lia"}},"subject":{"callId":"call_…"}}}
```
O app mostra o card com `SecureField`, o motivo, os sites e "Salvar no cofre" (ligado). Ao salvar: grava no Keychain, manda só os metadados (`PUT /vault/secrets/:name`) e responde `approve` na sessão. O servidor confere que os metadados mudaram e devolve ao bot `Ok, salvo como segredo:github-token`. "Agora não" responde `deny`. A linha da ferramenta `request_secret` fica escondida (o card já conta a história); "Permitir todos" não pega formulários.

`list_secrets()` devolve nomes, descrições, sites, se está liberado para o bot, onde está guardado e validade. Nunca valores.

### Rotas do cofre (todas com `Authorization: Bearer <RUNNER_TOKEN>`, só o app tem)

- `GET /vault/secrets` → `{"secrets":[{…metadados, "ref":"segredo:x","env":"SEGREDO_X"}],"serverStorage":true}`
- `PUT /vault/secrets/:name` `{description?, domains?, bots?, touchId?, expiresAt?, kind?, rotated?}` → metadados (cria ou atualiza; `rotated:true` apaga a cópia do servidor)
- `DELETE /vault/secrets/:name` → `{ok:true}` (apaga metadados e a cópia cifrada, esquece a máscara)
- `PUT /vault/secrets/:name/server-copy` `{value}` (≤ 16 KB) / `DELETE …/server-copy`
- `GET /vault/audit?name=&limit=` (mais novo primeiro) / `POST /vault/audit` `{name, outcome: used|denied|revealed, botId?, botName?, tool?, domain?, reason?}`
- Sem token → `401 {"ok":false,"error":"O cofre só responde ao app r/bots."}`. `POST /vault/exec/:ticket` é a única rota sem token (tíquete de uso único).

### Endurecimento junto

- Filhos (Claude Code, Codex, Bash) não herdam mais `RUNNER_TOKEN`, `JEV_API_KEY`, `RUNELAY_MCP_TOKEN` nem `ELEVENLABS_API_KEY` (`packages/providers/src/proc.ts`).
- O portão do modo código trata como protegidos `~/.config/runelay-bots`, `/run/runelay-bots`, `/proc`, `vault.key` e `*.enc`.

### App

- Trilho de ícones: "Cofre" (`lock.shield`). Lista com nome, descrição, sites, "Mac" ou "Mac + servidor", último uso e por quem. Detalhe: referência com copiar, "Ver o valor" (Touch ID sempre, mostra 10 s), descrição, sites, bots (todos ou escolhidos), Touch ID (Sempre / A cada 1 h / Nunca), validade, "Usar com o Mac fechado" com o aviso de que é menos seguro, Salvar regras, Trocar valor (Touch ID), Apagar (confirmação) e histórico.
- Mudar o Touch ID entre "Sempre" e outro, ligar a cópia do servidor e trocar o valor pedem Touch ID.

### Ponto de extensão (1Password, fora de escopo agora)

`registerSecretSource({id, handles(meta), read(meta, request)})` em `apps/server/src/modules/vault/services/vault.service.ts`. Uma fonte registrada atende os segredos que ela reconhece antes do Mac (por exemplo, um item com `op://…` lido pelo `op` CLI ou pela Connect API) e o histórico grava `source: <id>`. As regras do segredo continuam valendo antes da leitura. Nada está registrado hoje.

### Modelo de ameaça

Protege contra:
- o modelo (ou uma injeção de prompt) ler o valor: ele só manipula a referência; saídas com o valor voltam `••••`;
- o valor parar em `data/` (sessões, eventos, histórico, prints de campos preenchidos pelo cofre), no log do Docker ou nos transcripts do Claude Code;
- uso fora das regras: site, bot, validade e Touch ID checados no servidor e de novo no Mac;
- roubo do disco do servidor: só metadados e, na opção de servidor, cifrado com chave fora de `data/`;
- sincronização acidental: o Keychain não vai para o iCloud nem sai deste aparelho.

Não protege contra:
- quem tem shell no container ou no host como o usuário do servidor: o servidor, a chave e o Bash do modo código rodam com o mesmo usuário, então um processo malicioso consegue ler a memória do servidor e a chave (o portão do modo código bloqueia os caminhos, mas não é uma fronteira de usuário);
- o site de destino devolver o valor na própria página (o snapshot é mascarado, mas um texto da página que repete o valor aparece em prints como pixels);
- transformações que a máscara não conhece (o Bash com segredo nega as ferramentas comuns de conversão, mas não todas as combinações possíveis);
- o segredo com "usar com o Mac fechado": com o Mac offline, os bots usam sem Touch ID;
- um bot liberado usar o segredo de um jeito errado dentro do site permitido.

### Verificado 19/11 (instância separada na 2100, dados descartáveis, app simulado no lugar do Mac)

Bot "Teste Cofre" (Sonnet 5.5). O app simulado conectou em `/runner/connect` com `vault`, guardou o valor num Keychain falso e simulou o Touch ID (ok/cancelado).
1. `request_secret` → card → metadados `PUT` → bot: "Pronto: o token ficou salvo no cofre como `segredo:teste-cofre`, liberado só para 127.0.0.1".
2. Página local `http://127.0.0.1:8899/` com campo de texto que ecoa o valor: `browser_fill` com `segredo:teste-cofre`, sem card, Touch ID simulado ok; o snapshot seguinte voltou ao modelo com o campo `••••`; `-webkit-text-security: disc` e `autocomplete=off` aplicados no campo.
3. `http_request` para example.com com o segredo → "O segredo:teste-cofre só pode ser usado em 127.0.0.1, não em example.com." Touch ID cancelado → "A pessoa cancelou o Touch ID."
4. Modo código num repositório descartável: `curl -s -H "Authorization: Bearer $SEGREDO_TESTE_COFRE" http://127.0.0.1:8898/status` contra um servidor que devolve o cabeçalho → o servidor recebeu o token e o bot viu `recebido: Bearer ••••`. O bot se recusou sozinho a rodar `echo $SEGREDO…` e `| base64` (instruções do cofre). Direto no código: `| base64`, `> arquivo`, domínio errado e variável inexistente foram negados; `printenv` sem referência roda sem nenhum segredo no ambiente.
5. Cópia no servidor: `.enc` (AES-256-GCM, 0600) criado; com o app desconectado o `browser_fill` usou a cópia (`source: server`). Sem a cópia e com o app desconectado → "O segredo:teste-cofre fica só no Mac da pessoa, e o Mac está offline…".
6. Histórico: created, used (browser_fill, mac), denied (http_request, example.com, denied_domain), denied (cancelled), used (Bash), server_copy_on, used (server), server_copy_off, denied (mac_offline), deleted.
7. `grep -r` pelo valor e pelo base64 dele: 0 arquivos no `data/` de teste e no de produção, 0 em `~/.claude/projects`, 0 na worktree, 0 em `~/.agent-browser`, `/tmp`, `.cache` e `.config` do container, 0 linhas no log dos dois containers. Segredo apagado com `DELETE` (sumiu do índice e do `.enc`), instância e repositório de teste removidos.

Não testado ao vivo: o Touch ID e o Keychain reais (precisam da pessoa no Mac), `computer_type` com segredo, Codex com segredo, `list_secrets` num turno. Build do Mac + `make-app.sh` assinado "runelay bots Local".

## v51 (20/11): endurecimento do cofre, egress e deploy

Código novo: `apps/server/src/shared/net-guard.ts` (filtro de rede de saída), `apps/server/src/modules/vault/services/secret-command.service.ts` (análise do comando do Bash), `apps/server/src/modules/vault/services/vault-key.service.ts` (chave, HKDF, formato v2), `apps/server/src/modules/vault/services/public-suffix.ts`.

### Saída de rede (`net-guard`)

- `isPublicAddress(ip)`: só unicast global. Recusa `0/8`, `10/8`, `100.64/10` (tailnet/CGNAT), `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`, `255.255.255.255`, `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, Teredo `2001::/32` e tudo fora de `2000::/3`. `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96` e 6to4 `2002::/16` são desembrulhados e o IPv4 de dentro é checado de novo.
- `resolvePublic(url)`: só `http`/`https`, sem usuário/senha na URL, sem host de um rótulo só, sem `*.ts.net`, `*.internal`, `*.local`, `*.localhost`, `*.localdomain`, `*.home.arpa`, `*.onion`. Resolve **todos** os A/AAAA e recusa se qualquer um for interno (`ValidationError` em pt-BR).
- `guardedFetch`: resolve, fixa o IP checado na conexão (o `Host` e o SNI continuam o nome), nunca segue redirecionamento, timeout (30 s no `http_request`) e teto de resposta (5 MB no `http_request`).

### `http_request`

- Usa `guardedFetch`: nome que resolve para loopback, rede privada, tailnet ou metadata é recusado, inclusive por troca de DNS entre a checagem e a conexão.
- Com `segredo:` a URL precisa ser `https`, o segredo não vai no host, no usuário da URL nem no nome de cabeçalho. Depois da troca da referência a URL é lida de novo e precisa ter o mesmo esquema, host e porta.
- GET/HEAD sem segredo rodam direto; qualquer chamada com segredo (e todo método de escrita) passa pela decisão do Jev e, se preciso, pela pessoa.
- Erro de política sai como `TOOL_POLICY`; segredo negado como `SECRET_DENIED`.

### Segredo sem sites

- `http_request`, `browser_fill` e Bash não usam segredo com `domains` vazio. No `http_request` e no `browser_fill` o primeiro uso abre um card para a pessoa ("Liberar esse site…"); aprovado, o host entra nos `domains` do segredo (sem o `www.`, que continua valendo pela regra de site exato) e fica valendo dali em diante. Em rotina, ou recusado, o uso é negado com `code: "no_domains"`. No Bash é negado direto, pedindo para a pessoa definir os sites no Cofre.
- `browser_fill` só preenche página `https`.
- `computer_type` continua como antes (o app resolve no Keychain).
- `domains` não aceita sufixo público: `com`, `*.com`, `com.br`, `*.com.br`, `co.uk`, `*.github.io` e parecidos dão `bad_domains` ("amplo demais"). Padrão precisa de pelo menos dois rótulos depois do `*.`.
- Valor com menos de 4 caracteres: `PUT …/server-copy` responde `400 {code: "too_short"}` e um valor curto vindo do Mac é negado no uso (`too_short`), porque a máscara não esconde valores tão curtos.

### Bash com segredo

- O comando precisa ser **uma** chamada direta de `curl`, `gh` ou `git` (sem caminho, sem `bash -c`, `env`, `sudo`), sem pipe, `;`, `&&`, redirecionamento, subshell, crase, `$(…)` nem várias linhas. Variável só `$SEGREDO_X`/`${SEGREDO_X}` pura (sem `${X:0:4}`, `${X#…}` e outras); qualquer outra `$VAR` é recusada.
- `curl`: só opções conhecidas; `-x/--proxy`, `--resolve`, `--connect-to`, `-K/--config`, `-L`, `--trace`, `-k` e qualquer opção desconhecida são recusadas. Todo argumento solto precisa ser URL `https://` (host solto como `evil.com` é recusado). O segredo só pode ir em `-H`, `-u`, `--oauth2-bearer`, `-d/--data*`, `--json`, `-F/--form*`, `-b` ou na URL; esses argumentos saem da linha de comando e vão para um config lido da entrada padrão (`--config -`), e o `curl` roda com `--disable` (ignora `~/.curlrc`).
- `gh`: o token só entra por `GH_TOKEN=$SEGREDO_X` ou `GITHUB_TOKEN=$SEGREDO_X` antes do comando. Subcomandos permitidos: `api`, `repo`, `pr`, `issue`, `release`, `run`, `workflow`, `search`, `label`, `gist`, `cache`, `project`, `status`, `variable`, `secret`. Host implícito `github.com` mais `--hostname` e o host de `--repo HOST/dono/repo` precisam estar nos sites do segredo. Roda com `GH_CONFIG_DIR`/`XDG_*` num diretório temporário (sem extensões nem config da pessoa).
- `git`: só `clone`, `fetch`, `push`, `ls-remote`, com URL `https` explícita; o segredo só em `-c http.extraHeader=…`. O cabeçalho vai pelo ambiente (`GIT_CONFIG_COUNT`), restrito à URL (`http.<origem>/.extraHeader`), com `http.proxy` vazio, `http.sslVerify=true`, `core.hooksPath=/dev/null`, `credential.helper` vazio, `protocol.allow=never` (só `https`).
- `npm` ficou de fora: scripts de ciclo de vida e o `.npmrc` do projeto podem mandar o token para outro lugar.
- Todos os hosts do comando precisam estar nos sites de cada segredo usado; segredo sem sites é negado.
- O comando que roda vira `BUN_BE_BUN=1 '<bun>' '<app>/bin/rb-secret-run.mjs' <porta> 3<<<'<tíquete>'`: o tíquete chega pelo descritor 3 (não aparece em `/proc/<pid>/cmdline` do helper), vale 30 s, uma vez, e morre junto com o turno (sinal do turno). Apresentar um tíquete já usado gera aviso no log.
- `POST /vault/exec/:ticket` (mesma rota, só loopback sem cabeçalho de proxy) agora devolve o plano pronto, não um ambiente para `bash -c`:

```json
{"argv":["gh","api","user"],"env":{"GH_TOKEN":"value-1234"},"stdin":null,"tempHome":true,"redact":["value-1234"],"path":"/usr/bin"}
```

  O helper confere que `argv[0]` é `curl`, `gh` ou `git`, procura o binário só no `path` recebido, roda sem shell com ambiente mínimo (`PATH` fixo, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TERM`, `TZ`, `TMPDIR`, `SSL_CERT_*` e as variáveis do plano; nada de `*_PROXY`), escreve `stdin` no programa e continua mascarando stdout/stderr. Ele só fala HTTP com `127.0.0.1`, então funciona com outro uid.
- Risco que fica: o valor está no ambiente do processo filho (`/proc/<pid>/environ`), legível pelo mesmo uid enquanto o comando roda; por isso o Bash do modelo deve rodar com outro uid.

### Chave e formato da cópia no servidor

- Subchaves por HKDF-SHA256 (RFC 5869) a partir da chave mestra, sal `runelay-bots:hkdf:v2`, info `runelay-bots/vault/v2` (cofre) e `runelay-bots/integration/v2` (integrações).
- v2: `iv` = `0x02` + id da chave (4 primeiros bytes do SHA-256 da subchave) + IV de 12 bytes (17 bytes no total); `tag` de 16 bytes, conferida (`authTagLength: 16`); AAD `runelay-bots:vault:v2:<nome>:<sha256 da política>`, com a política `{bots, domains, expiresAt}` em JSON canônico. Mudar `bots`, `domains` ou `expiresAt` direto no banco quebra a decifragem (`server_copy_broken`); mudar pelo Cofre recifra a cópia.
- v1 (IV de 12 bytes, chave mestra direta, AAD `runelay-bots:vault:v1:<nome>`) continua abrindo. No boot, `loadVault` recifra toda cópia v1 para v2 numa transação só (idempotente: v2 é pulada); toda gravação nova já sai em v2.
- Integrações: mesmo esquema, AAD `runelay-bots:integration:v2:<id>:<url>` (trocar a URL guardada no banco invalida a chave), recifradas para v2 no boot.
- A chave é aceita em 32 bytes crus, hex (64 caracteres) ou base64/base64url de 32 bytes, igual no cofre e nas integrações. Arquivo de chave presente que não abre derruba o boot: o servidor nunca gera outra chave por cima (o mesmo vale para `integrations.key` curto demais).

### Histórico

- `POST /vault/audit` só aceita o app do Mac registrado (principal com dispositivo); outro cliente recebe `403 {"ok":false,"error":"Só o app do Mac registrado pode gravar no histórico do cofre."}`.
- Cada linha do histórico ganha `prevHash` e `hash` (SHA-256 da linha anterior + linha canônica), gravados sob a trava de escrita do banco. `GET /vault/audit` devolve os dois campos. `verifyAuditChain()` no repository acha a primeira linha alterada.

### Máscara

- `console.log/info/warn/error/debug/trace` também passam pela máscara (o Bun escreve direto no descritor, sem passar por `process.stdout.write`).
- Variantes novas: hex (minúsculo e maiúsculo), base64 e base64url nos três alinhamentos, URL com `%xx` minúsculo, `+` no lugar de espaço e `encodeURI`.
- Segredos fixos não vencem: senha do Postgres e do Redis, chaves das integrações, segredo do auth, `runner.token`, chave do S3 e os arquivos de `readOrCreateSecret`.

### Verificado

- `bun test` nos arquivos: `src/shared/__tests__/net-guard.test.ts` (18 pass), `src/modules/vault/__tests__/vault.service.test.ts` (46), `vault-tools.test.ts` (34), `vault.routes.test.ts` (15), `secret-command.test.ts` (9), `secret-run.test.ts` (3), `vault-key.test.ts` (3), `src/shared/__tests__/redact.test.ts` (4, com processo filho usando `console.log`).
- O corpo de `POST /vault/exec/:ticket` acima é o que `vault.routes.test.ts` recebe da rota.
