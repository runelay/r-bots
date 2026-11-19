# Aprovações, Jev e modos de permissão

## runelay bots: verified protocol

### eve session API (under `sessionBasePath`, e.g. `/bots/lia/eve/v1`)

#### Answer an approval

`POST {sessionBasePath}/session/:sessionId`
```json
{"answers":[{"interactionId":"4WKDdxz39zyo4E6L","optionId":"approve"}]}
```
or `"optionId":"deny"`. → `202`
```json
{"ok":true,"sessionId":"wrun_01M7SVWDTXJ4YQM9W17529F20N","deliveryId":"6fd61b89-b3c2-40a7-bbe5-1dd6d0a8ba8e"}
```
Use `interaction.opened.data.interactionId` and one of `request.options[].id`.

## v5 (19/11): Jev decision layer

The LLM thinks and generates, Jev (TypeSafe System One) judges, and our code decides and executes. Endpoint `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $JEV_API_KEY` (from `.env.local`, never logged), model pinned to `jev-1.14.0` (`JEV_MODEL`; aliases `jev-latest`/`jev-preview` point to it today). Timeout 1.5 s (`JEV_TIMEOUT_MS`). Price $0.042 per million input tokens (output free). Observed latency 160–280 ms per call, about 280–560 input tokens, about US$0.00002 each.

### `decision.made` event

```json
{"type":"decision.made","data":{"kind":"approval","question":"Esta ação do bot é segura para rodar sem uma pessoa confirmar?","answer":{"risk":0,"riskProbabilities":{"0":1,"1":0,"2":0,"3":0},"needsHuman":0.54,"aligned":0.83},"confidence":1,"threshold":0.85,"outcome":"auto_approved","latencyMs":224,"model":"jev-1.14.0","costUsd":0.0000238,"tool":"browser_click","callId":"call_0p3bdHBBj2zZ"},"scope":{"turnId":"turn_0"}}
```
`kind`: `approval` | `progress` | `triage`. `outcome`:
- approval: `auto_approved`, `human`, `allowed` / `flagged` (prod_query only), `fallback`
- progress: `continue`, `stop`, `fallback`
- triage: `notify`, `quiet`, `fallback`

A hard rule sends `answer:null`, `model:null`, `latencyMs:0` and a `reason`. On Jev error or timeout, `outcome:"fallback"` with `reason`, and today's behavior applies: a human card for click/fill, delegate and prod_query run, no guard, normal unread.

### 1. Approval gate

Gated tools: `browser_click`, `browser_fill`, `prod_query`, `delegate`, plus the v6 `add_schedule` / `remove_schedule`. The state sent to Jev: bot name/role, the user's message for this turn, tool and arguments, current page url/title, and the target element's line from the last snapshot. Questions: `risk` (Score, 4 levels from "só navega ou lê" to "destrutiva, financeira, irreversível ou expõe dado pessoal"), `needs_human` (Noul) and `aligned` (Noul).

The policy is in code:
- **Auto-approve** only when `decisions.autoApprove`, risk score < 1, `confidence` ≥ `threshold`, needs_human < 0.7 and aligned ≥ 0.5. The call then starts with `clearedBy: {"decision":"jev","model":"jev-1.14.0"}` and no card.
- **Always human, Jev not asked:** `browser_fill` into a password, card, CPF/CNPJ, PIX, token or PIN field; a value that looks like a card number, CPF or CNPJ; a value containing a newline (it submits); and any `browser_click` or `browser_fill` on an element whose text says send, pay, delete, confirm, buy, finish, subscribe, transfer, withdraw, cancel, deactivate or publish (Portuguese and English).
- **prod_query** stays read-only by code and never gets a card. Jev only marks it `flagged` (risk ≥ 1.5, needs_human ≥ 0.5 or not aligned) or `allowed`.
- **delegate** without auto-approval gets a card ("Posso pedir ao Davi: …?") in chat. In schedule turns it runs as before.
- In schedule turns, non-auto approvals are denied (no one is there).

Per-bot setting `"decisions":{"autoApprove":true,"threshold":0.85}` in `GET /bots`. It can be changed with PATCH: `threshold` must be between 0.5 and 1, otherwise `400 {"ok":false,"error":"decisions.threshold precisa ficar entre 0.5 e 1.","field":"decisions.threshold"}`.

Unit calls (jev-1.14.0, no model turn):

| state | outcome | confidence | risk / needsHuman / aligned | latency |
|---|---|---|---|---|
| click "Learn more" on example.com | auto_approved | 1.00 | 0.00 / 0.43 / 0.71 | 267 ms |
| click "Próxima página" on HN | auto_approved | 1.00 | 0.00 / 0.45 / 0.80 | 159 ms |
| click "Excluir conta" | human (rule) | – | – | 0 ms |
| click "Encerrar minha conta permanentemente" | human (Jev) | 0.80 | 2.81 / 0.98 / 0.09 | 160 ms |
| fill "Senha" | human (rule) | – | – | 0 ms |
| fill search "clima São Paulo" | human | 1.00 | 1.00 / 0.17 / 0.94 | 200 ms |
| prod_query count(*) | allowed | 0.98 | 0.03 / 0.18 / 0.95 | 189 ms |

7 calls ≈ US$0.000116 in all.

### 2. Progress guard

Every 4 settled tool calls in a turn, delegated calls included, Jev gets `{user_request, recent_tool_calls}` (the last 8 summaries). It answers `progress` (Score: going in circles / some progress / clear progress) and `stuck` (Noul). The turn stops only if progress < 0.7 **and** confidence ≥ 0.8 **and** stuck ≥ 0.8. The provider is aborted, then a pt-BR reply is written: "Parei aqui porque não estava avançando no seu pedido…" with the last attempts. The turn ends with `turn.settled` `{"outcome":"completed","stoppedBy":"progress_guard"}`. Davi's 6-query round: `continue`, progress 1.95, conf 0.92, 164 ms.

### 3. Schedule triage

After a schedule run with a reply, Jev gets `{bot_role, routine:{name, instructions}, result}` and a Noul "something the person should look at now?". If below 0.5: `turn.settled` carries `"quiet": true` and the reply stays in the thread without raising `unread`. Otherwise unread goes up as before. Davi's watch run on 19/11: `notify`, noul 0.89, 219 ms (it reported stuck payment transfers), unread 0 → 1.

Not done: the optional engine model `"auto"` (Jev picking a cheap or strong model per message).

---

## v15 (19/11): human approvals

`interaction.opened.data.request` can now carry what the action is about, so the app never has to show `@e1`:

```json
{"interactionId":"…","request":{"kind":"approval","display":"confirmation","allowFreeform":false,
 "options":[{"id":"approve","label":"Aprovar"},{"id":"deny","label":"Negar"}],
 "prompt":"Posso clicar em “Entrar”?",
 "target":{"label":"Entrar","role":"button","url":"https://mail.google.com/"},
 "previewImage":"data:image/jpeg;base64,/9j/…",
 "reason":"Para abrir sua caixa de entrada"},
 "subject":{"callId":"call_…"}}
```

- `target` (optional): `label` is the element's accessible name (empty when it has none), `role` is the ARIA role for the browser (`button`, `link`, `textbox`…), the AX role for the Mac (`AXButton`…), or `page` / `app` / `desktop`. `url` is the page the bot is on (browser) or the URL being opened. `app` and `bundleId` name the Mac app (`computer_*`, from the last `computer_ui_tree`).
- `previewImage` (optional): a JPEG data URL, at most 360 px wide, cropped from a fresh screenshot around the target with 28 px of margin. Sent for `browser_click` / `browser_fill` (the element is scrolled into view first) and `desktop_click` (around the point). Missing when the capture fails or the user has control.
- `reason` (optional): the bot's own short sentence. `browser_click`, `browser_fill`, `desktop_*` and `computer_click` / `computer_type` / `computer_key` / `computer_open` accept an optional `reason` argument; it is stripped before the call reaches the Mac runner.
- Where the bot runs:
  - Browser: refs resolve through `refs` from the last `browser_snapshot` (agent-browser `snapshot -i --json`), then through the snapshot line.
  - Mac: `elementId` resolves through the last `computer_ui_tree` of that bot (title, then description, placeholder, value).
- `prompt` and `capability.label` use the element's name too: `Posso clicar em “Entrar”?`, `Clicar em “Entrar”`, `Preencher “E-mail”`. A ref without a name falls back to `um elemento` / `um campo`, never the ref. `computer.action.summary` uses the same label.
- Not supported: “sempre permitir neste site/app”. Options stay `approve` / `deny`.
- `GET /bots/:id/browser/screenshots/<file>.png` (alias `browser/shots/…`) → 200 PNG: the screenshot taken after one browser action. `<file>` is the last path component of `call.settled.output.screenshot`; only `[\w-][\w.-]*\.png` is accepted and it is read from `data/bots/<id>/browser/shots/` only. 404 when it no longer exists.
- `GET /bots/:id/browser` now also returns `alive` (boolean): whether the bot's agent-browser session is still running (`agent-browser session list`). The app uses it to choose between the live view and the last screenshot of the action with "Abrir de novo".

---

## v27 (19/11): PR e CI do modo código + mensagem com card aberto

### Mensagem com card de aprovação aberto (bug da resposta duplicada)

Causa: na conversa do Engenheiro de Software a pessoa escreveu "não precisa, eu já alterei, só guarde na memória" enquanto o card do `save_issue` estava aberto. O app manda isso como mensagem nova (fica "na fila"); a pessoa depois clicou Negar; o turno pausado seguiu, salvou a memória e respondeu ("Você tem razão… Guardei a regra…"), e só então a fila rodou a mensagem como turno novo, que respondeu de novo ("Já está guardado…"). Não era voz nem handoff.

Agora (`apps/server/src/modules/engine/services/engine.service.ts`): mensagem de chat só com texto que chega com o turno pausado em aprovação entra **no mesmo turno**: `delivery.consumed` com o escopo do turno e `steer:true`, cada card aberto fecha com `interaction.settled {outcome:"withdrawn", reason:"message"}` (a ferramenta volta negada), a rodada do provedor é encerrada (o mesmo `onEndRun` da troca de worktree) e o texto que ela ainda soltar é descartado. O turno continua com `resume` da sessão do provedor e o prompt "A pessoa respondeu por mensagem enquanto seu pedido de aprovação estava aberto… numa resposta só"; se o `resume` falhar, roda de novo com o resumo da conversa. Mensagem com anexo, skill, voz, grupo ou rodada de delegado continua indo para a fila. App: card mostra "Respondido por mensagem" e a fase volta para trabalhando.

## v29 (19/11): várias conversas por bot + modo de permissão por conversa

### Modo de permissão (`readonly | edit | default | full`)
- Padrão do bot: campo `permission` (`PATCH /bots/:id`, default `default`). Por conversa: `PATCH …/conversations/:sid {permission}`. Efetiva = conversa ?? bot ?? default.
- Prompt: seção "## Permissão desta conversa" com o modo, valendo acima das regras de autonomia.
- Gate do código (`beginCall`): a ação é classificada (leitura: Read/Glob/Grep, Bash só de leitura por `commandIsReadOnly` com o parser de shell; edição: Edit/Write; comando: o resto do Bash e `dev_server_start`; entrega: `workspace_deliver`).
  - **Somente leitura**: leitura segue o gate normal; edição, comando e entrega são negados sem card (`TOOL_POLICY`). Codex roda com `-s read-only`.
  - **Editar**: leitura e edição seguem o gate normal; todo comando e entrega viram card (soft), inclusive commit e push da branch da tarefa.
  - **Padrão**: igual à v25.
  - **Acesso total**: nenhum card (`clearedBy: {permission: "full"}`), também nas ferramentas de navegador/computador, de autoconfiguração e nos conectores. Continua negado sem card: assinatura de IA em commit/PR, PR para main quando a base é develop e `push --force` em main/master/develop (`fixedRuleViolation`, inclusive `HEAD:develop` e `+ref`). As outras negações técnicas (caminho protegido, `git config`, `&`) continuam.
- Conectores (`runRemote`): leitura passa em todos; escrita comum e mensagem para fora → negadas no Somente leitura, card no Editar, só mensagem para fora pede card no Padrão, nada pede no Acesso total.
- Limite conhecido: Codex não tem gate por chamada, então no Editar ele roda comandos como no Padrão.
