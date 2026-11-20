# Simuladores e testes e2e

Simuladores iOS (e emuladores Android) do Mac da pessoa, a ponte do Metro até eles, e os testes e2e que o bot roda: Maestro no simulador e Playwright contra a prévia local. Os servidores de desenvolvimento estão em [servers](servers.md).

## v53 (20/11): simuladores, ponte do Metro, Maestro e Playwright

### Quem faz o quê

- O **servidor** roda o código (Metro do Expo, Vite, wrangler) na VPS, como na v48.
- O **app do Mac** é o runner: chama `xcrun simctl`, o emulador do Android SDK e o Maestro, e abre a ponte TCP do Metro. Anuncia a capacidade `simulators` no `hello` do `/runner/connect`.
- O **simulador** abre o app apontando para `127.0.0.1:<porta>` no próprio Mac. `localhost` é liberado pelo ATS, e a porta não sai do Mac.

### Ponte do Metro (`/runner/tunnel`)

WebSocket `GET /runner/tunnel?port=<porta>` com `Authorization: Bearer <token de dispositivo>` (o mesmo do `/runner/connect`):

- sem token de dispositivo → `401`;
- porta que não é de um servidor do runelay bots no ar (`starting` ou `running`) → `404`;
- aceito → cada mensagem binária é um pedaço do fluxo TCP, nos dois sentidos, até `127.0.0.1:<porta>` (ou `::1`, se o servidor só ouve em IPv6). Fechar um lado fecha o outro. Não há protocolo por cima.

No Mac, o app abre `127.0.0.1:<porta>` (a mesma porta da VPS quando está livre) e cria um WebSocket por conexão TCP. A ponte vive enquanto o app estiver aberto.

Ao abrir um app Expo, o servidor também lê as `EXPO_PUBLIC_*` de `.env`, `.env.development`, `.env.local` e `.env.development.local` (só as chaves que apontam para `http(s)://localhost:<porta>` ou `127.0.0.1:<porta>`) e abre a ponte dessas portas quando elas são de um servidor do runelay bots no ar. As que não são voltam em `missing`, e o bot avisa para subir a API nessa porta.

### Operações do runner (`type:"request"`, `op`, `body`)

Resposta `{"type":"response","id","ok":true,"result":…}` ou `{"ok":false,"error"}`.

| `op` | `body` | `result` |
| --- | --- | --- |
| `sim.list` | `{}` | `{devices:[{udid,name,runtime,state,platform}], android:{sdk,adb}, maestro:{installed,version}}`; AVDs do Android vêm como `udid:"avd:<nome>"` |
| `sim.boot` | `{udid}` | `{udid,state:"Booted"}`; abre o app Simulator com `-CurrentDeviceUDID` e espera o boot |
| `sim.shutdown` | `{udid}` | `{udid,state:"Shutdown"}` |
| `sim.open_url` | `{url, udid?}` | `{url}`; sem `udid`, o simulador ligado |
| `sim.screenshot` | `{udid?}` | `{base64, mimeType:"image/jpeg", width, height}` (até 1100 px de altura) |
| `sim.tunnel` | `{port}` | `{localPort}` |
| `sim.tap` | `{udid?, text? \| id? \| x?,y?}` | `{ok}`; um flow de um passo no Maestro (`x`,`y` em % da tela) |
| `sim.type` | `{udid?, text}` | `{ok}`; `inputText` do Maestro |
| `maestro.run` | `{flow, name, udid?}` | `{passed, durationMs, steps:[{name,status,durationMs?,error?}], error?, screenshot?, log, device}`; passos lidos do `commands.json` do `--debug-output`, print da falha, do `takeScreenshot` ou do simulador |
| `maestro.install` | `{}` | `{installed, path}`; instalador oficial (`curl -fsSL https://get.maestro.mobile.dev \| bash`) |

`macDeviceCall` no servidor recusa com "O app do Mac ainda não controla simuladores." quando o app conectado não anuncia `simulators`.

### Rotas

| Rota | Resposta |
| --- | --- |
| `GET /simulators` | `200` com o `result` do `sim.list` |
| `POST /simulators/open-expo` `{server, udid?, client?:"go"\|"dev"}` | `200 {"ok":true,url,localPort,client,bridged:[portas],missing:[portas]}`; `400` sem `server`; `502` com a mensagem do Mac ou do servidor |
| `GET /tests/:id` | `200` execução (abaixo) |
| `POST /tests/:id/rerun` | `202 {"ok":true,"run":…}` com `attempt` + 1; `409` se ainda roda |
| `GET /tests/:id/files/<screenshot.jpg\|screenshot.png\|log.txt\|video.webm\|trace.zip>` | o arquivo; `404` se não existe |

Escrita em `/simulators/**` e `/tests/**` só para o dono (v51). O token interno não entra.

`client` sem valor: `dev` quando o `package.json` tem `expo-dev-client` e o projeto declara `scheme` (`app.json`, `app.config.json` ou `app.config.ts/js`), e aí a URL é `<scheme>://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A<porta>&disableOnboarding=1`; senão, Expo Go com `exp://127.0.0.1:<porta>`.

### Execução de teste e evento `test.result`

```json
{"id":"tst_162b61a744","kind":"maestro","title":"abre-o-app.yaml","target":"iPhone 17 Pro · iOS 26.5","status":"passed","attempt":1,"startedAt":"…","durationMs":…,"steps":[…],"error":null,"screenshot":true,"artifacts":["log.txt"],"botId":"engenheiro-de-software","sessionId":"wrun_…","path":".maestro/abre-o-app.yaml"}
```

`status`: `running` → `passed`, `failed` ou `error` (não rodou). Cada mudança sai como `test.result` na conversa que pediu o teste (`data` = a execução). O app mostra um card por execução (id `test-<id>`): passos com ✓/✗, miniatura do print, duração, "Rodar de novo" e "Detalhes" (painel `kind:"test"` com passos, log completo, vídeo e trace). Dados em `<dados>/tests/<id>/`.

### Ferramentas do bot

- `simulator_list`, `simulator_boot {udid}`, `simulator_shutdown {udid}`, `simulator_open_url {url, udid?}`, `simulator_open_expo {server, udid?, client?}`, `simulator_screenshot {udid?}` (imagem para o modelo), `simulator_tap {text|id|x,y, udid?}`, `simulator_type {text, udid?}`. Sem aprovação: o simulador é isolado.
- `test_maestro {path, project?, branch?, udid?, writesRealData?}`: lê o flow do repositório (por padrão em `.maestro/`) e roda no Mac.
- `test_playwright {path, project?, branch?, server?, baseUrl?, grep?, writesRealData?}`: copia a spec para `<dados>/tools/playwright/runs/<id>`, gera a config (`baseURL` do servidor local, `trace`/`screenshot`/`video` só na falha, Chrome do agent-browser com `--no-sandbox`, `PLAYWRIGHT_BROWSERS_PATH=<dados>/tools/playwright/browsers`) e roda `npx playwright test` com relatório JSON. `test.step` vira passo.
- Aprovação: simulador e prévia local rodam direto; `baseUrl` fora de `localhost` ou `writesRealData:true` abrem o card.
- `maestro_install` e `playwright_install` (`@playwright/test@1.64.1` + `playwright install ffmpeg` na pasta de ferramentas, fora dos repositórios): sempre com card.

### App

- Lateral: **Projetos rodando** junta servidor e aparelho. O card é o projeto; "Abrir" leva a web à prévia, a API aos logs e o mobile ao simulador (liga o aparelho escolhido, espera a tela e abre o app pela ponte). O card mobile mostra "no iPhone 17 Pro" com um seletor para trocar o aparelho, e o "…" liga e desliga o aparelho. Estado vazio: "O servidor roda o código; a prévia (web) ou o simulador (iPhone) mostram o app."
- Painel do simulador (`kind:"simulator"`): cabeçalho com o nome inteiro, status e versão; à direita print (vai para a conversa como anexo), tela cheia, "…" (início, girar, URL/deep link, abrir o app, desligar) e × sempre visível. Estados, um de cada vez com crossfade: seletor de aparelho, "Ligar simulador", "Mostrar simulador", "Ligando o simulador…", "Abrindo a tela…", espelho, erro com "Tentar de novo".
- Espelho: janela do Simulator por ScreenCaptureKit a 24 fps (também atrás de outras janelas), clique e teclado repassados ao processo do Simulator. Sem janela ou sem permissão de Gravação de Tela, cai para `simctl io screenshot` a cada 300 ms, que funciona até sem a janela; aí o toque vira `sim.tap` do Maestro e aparece "Permitir gravação de tela" ou "Espelho fluido". Nada roda com o painel fechado.
- Painel do servidor: abas Prévia e Logs ficam montadas (troca por opacidade), então a prévia não recarrega ao voltar dos logs.

### Limitações

- O app precisa ser compatível com o binário que está no simulador: Expo Go só serve para projeto sem módulo nativo próprio e na mesma versão do SDK; projeto com módulos nativos (o conty3.0 usa Intercom e OneSignal) precisa de um dev client compilado do mesmo código nativo.
- Android: lista e liga AVDs; sem `platform-tools` não desliga. Não há espelho nem Maestro testado no Android.
- Dispositivo físico (fase 3) não foi feito. O caminho seria `xcrun devicectl list devices` e `devicectl device process launch` para iPhone pareado por USB ou Wi-Fi, com a ponte do Metro no Mac e o iPhone na mesma rede (ou `localhost` por `iproxy`), e espelho por QuickTime/`AVCaptureDevice` de tela do iOS.
- Specs do conty-test não rodam por aqui: o framework de lá depende de 1Password (`op run`) e de agentes próprios.

### Verificado

Servidor de produção (`servers-6` a `servers-8`), app instalado a partir de `~/rb-servers`, Mac com Xcode 27.1, 20/11:

`GET /simulators`:

```json
{"devices":[{"udid":"5FBF3402-6D35-4B41-ACCF-8B61CF334724","name":"iPhone 17 Pro","runtime":"iOS 26.5","state":"Shutdown","platform":"ios"},{"udid":"avd:Medium_Phone","name":"Medium Phone","runtime":"Android","state":"Shutdown","platform":"android"}],"android":{"sdk":true,"adb":true},"maestro":{"installed":true,"version":"2.12.1"}}
```

Turno real do Engenheiro de Software: `simulator_list` → `{"devices":2}`, `server_list`, `simulator_boot` → `{"udid":"5FBF3402-…","state":"Booted"}`, `simulator_screenshot` → `{"width":505,"height":1100}`. O primeiro `simulator_open_expo` falhou com "Simulator device failed to open conty://expo-development-client/…" porque o simulador tinha só o build Release (sem dev launcher).

Ponte: `POST /simulators/open-expo {"server":"dev_fda47f5695","client":"go"}` → `{"ok":true,"url":"exp://127.0.0.1:5310","localPort":5310,"client":"go"}`; no Mac, `lsof` mostra o app runelay bots em `127.0.0.1:5310` e `curl -H "expo-platform: ios" http://127.0.0.1:5310/` devolve o manifest do Metro da VPS (`launchAsset.url` em `http://127.0.0.1:5310/…`). O Expo Go do SDK 58 recusou o projeto do SDK 57, e o do SDK 57 carregou o bundle (`iOS Bundled 31282ms … (4068 modules)`) e caiu em módulo nativo (Intercom).

Com um dev client Debug compilado do commit `7067247` do conty3.0 e o Metro numa worktree desse commit (`.env` ligado do checkout principal): `{"ok":true,"url":"conty://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A5313&disableOnboarding=1","localPort":5313,"client":"dev"}`, `iOS Bundled 35160ms … (3956 modules)` sem erro de app; o app abre na splash e espera a API do `.env` (`http://localhost:8787`), que na VPS é um `workerd` de fora do runelay bots.

`test_maestro` pelo bot com `.maestro/abre-o-app.yaml` (`openLink` do dev client, `extendedWaitUntil` "Conty.*", `takeScreenshot`) → `test.result` `passed`, alvo "iPhone 17 Pro · iOS 26.5", `screenshot:true`. Os passos vieram vazios; o Maestro 2.12 grava `<debug>/<flow>/commands.json` e `takeScreenshot/`, e a leitura foi corrigida para procurar nas subpastas (saída real: `Open conty://… COMPLETED`, `Assert that "Conty.*" is visible… COMPLETED`, `Wait for animation to end… COMPLETED`, `Take screenshot tela-inicial… COMPLETED`).

`test_playwright` pelo bot (spec de login no conty-whitelabel, `server` do Vite) → `failed`: "Executable doesn't exist at /home/app/.cache/ms-playwright/ffmpeg-1013" (vídeo da falha). Corrigido com o ffmpeg na pasta de ferramentas. Repetido com a mesma config que o servidor gera, dentro do container: Chrome 158 abre, passo "abre o app" ok, "vê o formulário de entrada" falha com o print da tela "Alguma coisa deu errado" do whitelabel (a API do `.env.local` não responde daqui), anexos `screenshot`, `video`, `error-context` e `trace`.
