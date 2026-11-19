# Cofre de segredos

## v23 (19/11): cofre de segredos

O modelo nunca vê o valor. Segredos são chamados por apelido (`segredo:github-token`) e o valor entra só no último instante, dentro da ferramenta. Código: `apps/server/src/vault.ts` (cofre, regras, histórico, rotas), `apps/server/src/modules/vault/services/vault-tools.service.ts` (ferramentas e instruções), `apps/server/src/shared/redact.ts` (máscara), `apps/server/bin/rb-secret-run.mjs` (Bash); app em `Features/Vault/Vault.swift`, `Features/Vault/VaultStore.swift`, `Features/Conversation/Views/SecretFormCard.swift`, `Features/Vault/VaultScreen.swift`, `Features/Computer/Executor/FrontmostPage.swift`.

### Onde o valor fica

- **Padrão: Keychain do Mac.** Item `kSecClassGenericPassword`, serviço `com.runelay.bots.vault`, conta = nome, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, `kSecAttrSynchronizable = false` (não vai para o iCloud). As regras do segredo ficam no próprio item (`kSecAttrGeneric`, JSON), então o app confere a política com a cópia local, não com o que o servidor disser. O app tenta primeiro o Keychain de proteção de dados (com `SecAccessControl(.userPresence)` quando o Touch ID é "Sempre"); se a assinatura local não tiver o entitlement (`errSecMissingEntitlement`), cai no Keychain de login e o Touch ID é exigido pelo próprio app com `LAContext.evaluatePolicy(.deviceOwnerAuthentication)`. A assinatura estável "runelay bots Local" mantém o acesso entre versões.
- **Opção "usar com o Mac fechado"** (desligada por padrão, marcada na tela como menos segura): o app manda o valor uma vez (`PUT /vault/secrets/:name/server-copy`, só com HTTPS) e o servidor grava `data/vault/<nome>.enc` (0600) com AES-256-GCM, IV de 12 bytes e AAD `runelay-bots:vault:v1:<nome>` (trocar arquivos de nome quebra a decifragem). A chave tem 32 bytes em `~/.config/runelay-bots/vault.key` (0600, fora de `data/`), montada só leitura em `/run/runelay-bots/vault.key` (`VAULT_KEY_FILE`). Trocar o valor apaga a cópia do servidor até o app mandar a nova.
- **Metadados sem valor** no servidor: `data/vault/index.json` (0600) com `{name, description, domains, bots, touchId, expiresAt, storage: "mac"|"mac+server", kind, createdAt, updatedAt, rotatedAt, lastUsedAt, lastUsedBy, lastTool}`. Histórico em `data/vault/audit.ndjson` (0600): `{at, name, outcome, botId, botName, tool, domain, source, reason, by}`, nunca o valor. `outcome`: `created`, `updated`, `rotated`, `deleted`, `used`, `denied`, `revealed`, `server_copy_on`, `server_copy_off`.

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
| `http_request` (novo) | `{method, url, headers?, body?, reason?}`; referência em cabeçalhos, corpo e URL (não no host). GET/HEAD sem card; outros métodos passam pelo Jev e, se preciso, por uma pessoa. Não segue redirecionamento (devolve `location`), bloqueia loopback, link-local e `*.internal`, timeout 30 s, corpo cortado em 20 000 caracteres. | host da URL |
| Bash no modo código (Claude na VPS) | `$SEGREDO_NOME` / `${SEGREDO_NOME}` (nome em maiúsculas, hífen vira `_`); `segredo:nome` vira `${SEGREDO_NOME}`. Depois do portão normal, o hook PreToolUse troca o comando por `node bin/rb-secret-run.mjs <porta> <tíquete> <comando em base64>`: o helper troca o tíquete (32 bytes, uso único, 60 s, só loopback sem cabeçalho de proxy) pelas variáveis em `POST /vault/exec/:ticket`, roda `bash -c` com elas e mascara stdout/stderr em fluxo. Comandos que convertem ou despejam o ambiente (`base64`, `xxd`, `od`, `rev`, `tr`, `cut`, `sed`, `awk`, `printenv`, `env`, `set`, `export`, `python`, `node`, `perl`…), redirecionam para arquivo, usam `tee` ou leem `/proc` são negados quando usam segredo. | hosts das URLs do comando (todas precisam ser liberadas; com domínio e sem URL = negado) |

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
- `DELETE /vault/secrets/:name` → `{ok:true}` (apaga metadados e `.enc`, esquece a máscara)
- `PUT /vault/secrets/:name/server-copy` `{value}` (≤ 16 KB) / `DELETE …/server-copy`
- `GET /vault/audit?name=&limit=` (mais novo primeiro) / `POST /vault/audit` `{name, outcome: used|denied|revealed, botId?, botName?, tool?, domain?, reason?}`
- Sem token → `401 {"ok":false,"error":"O cofre só responde ao app runelay bots."}`. `POST /vault/exec/:ticket` é a única rota sem token (tíquete de uso único).

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
- quem tem shell no container ou no host como `anderson`: o servidor, a chave e o Bash do modo código rodam com o mesmo usuário, então um processo malicioso consegue ler a memória do servidor e a chave (o portão do modo código bloqueia os caminhos, mas não é uma fronteira de usuário);
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
