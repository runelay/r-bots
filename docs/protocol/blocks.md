# Blocos: notas, planilhas e agenda

## v31 (19/11): blocos do bot (contrato antes do servidor)

Todo bot tem três blocos, sem toggle e sem nada fixo por bot: **Notas** (estilo Obsidian), **Planilhas** (estilo Excel) e **Agenda** (Google Calendar das contas que a pessoa ligou na runelay). O bot cria e edita conversando ou por voz; a pessoa edita no app com o bot ao lado. Exportação em `.docx`/`.pdf`/`.md` (nota) e `.xlsx`/`.csv`/`.pdf` (planilha).

Esta seção é o **contrato escrito antes do servidor**: os tipos estão em `packages/protocol/src/blocks.ts` (exportados por `@runelay-bots/protocol`) e o app do Mac já fala com eles através de um cliente com fixtures. Quando o servidor existir, o `### Verificado` no fim recebe os corpos capturados e qualquer desvio corrige este texto e os tipos no mesmo PR.

Regras gerais:

- Tudo fica sob `/bots/:id/…` e é do bot (`data` no SQLite do executor de armazenamento: `notes`, `note_links`, `sheets`, `sheet_tabs`, `sheet_cells`, `exports`; arquivos exportados no Garage).
- **Paginação, busca, filtro e ordenação são sempre do servidor.** Listas devolvem `{"items":[…],"nextCursor":"…"|null,"total":N}`; `limit` padrão 50, máximo 200; `cursor` é opaco.
- Ids são opacos (`note_…`, `sheet_…`, `tab_…`, `exp_…`; evento de agenda `"<accountId>:<googleId>"` codificado). O app nunca mostra id, caminho nem JSON.
- Datas em ISO 8601 com fuso. Erros seguem o resto do servidor: `{"ok":false,"error":"<pt-BR>"}`, 400 validação, 404 não encontrado, 409 versão velha.
- Concorrência otimista: toda escrita aceita `baseVersion`. Se o item mudou depois dela por **outro autor**, 409 `{"ok":false,"code":"stale","version":N}` e o app relê. Escritas da pessoa a menos de 120 s da versão anterior da pessoa (ainda não vista pelo bot) sobrescrevem essa versão, como no canvas, para o autosave não inundar versões.

### Eventos do stream

Depois do `call.settled` da ferramenta do bot (e depois de cada escrita da pessoa, com `author:"user"`), o servidor grava no stream da sessão em que a ferramenta rodou **e** na thread principal do bot:

```json
{"type":"block.created","data":{"botId":"lia","kind":"note","id":"note_8Hq2","title":"Plano Q1","version":1,"author":"bot","action":"created","callId":"call_…","preview":{"kind":"note","folder":"Projetos","excerpt":"# Plano Q1\n\n- [ ] Fechar metas\n- [x] Revisar orçamento\n…","words":312}}}
{"type":"block.updated","data":{"botId":"lia","kind":"note","id":"note_8Hq2","title":"Plano Q1","version":2,"author":"bot","action":"edited","callId":"call_…","preview":{…},"changed":{"lines":[[4,7]]}}}
{"type":"block.deleted","data":{"botId":"lia","kind":"note","id":"note_8Hq2","title":"Plano Q1","version":3,"author":"bot","action":"deleted","preview":null}}
```

- `kind`: `note` | `sheet` | `agenda`. A agenda é um bloco só por bot com `id: "agenda"`; `version` é uma revisão do servidor que sobe a cada evento criado, mudado ou apagado pelo bot ou pela pessoa.
- `preview` é a prévia que o app desenha no bloco da conversa sem outra chamada:
  - nota: `{"kind":"note","folder":"Projetos","excerpt":"<até 600 caracteres / 14 linhas do markdown, cortado em fim de linha>","words":312}`; `folder` vazio é a raiz.
  - planilha: `{"kind":"sheet","tab":"Resumo","tabs":2,"rows":[[{"v":"Mês","t":"s"},{"v":1520.5,"t":"n","format":{"type":"brl"}}],…],"rowCount":120,"colCount":8,"frozenRows":1,"colWidths":[140,96,96]}` com no máximo 8 linhas × 6 colunas a partir de A1 da aba ativa, **valores já calculados**.
  - agenda: `{"kind":"agenda","view":"day"|"week","start","end","timezone":"America/Sao_Paulo","accounts":[{"id","label","color"}],"events":[{"id","accountId","title","start","end","allDay","meet"}]}` com até 20 eventos do dia (ou da semana) em que o bot mexeu.
- `changed` (opcional) diz onde o bot mexeu, para o destaque sutil no editor: nota `{"lines":[[início,fim]]}` (linhas 0-based do conteúdo novo, inclusivas); planilha `{"tabId","ranges":["B2:C9"]}`; agenda `{"eventIds":[…]}`.
- Eventos com `author:"user"` não criam bloco na conversa; servem para atualizar o painel aberto e a lista.

### Ferramentas do bot (MCP `mcp__bots`, sem aprovação, todos os bots)

Rótulo (`capability.label`) em pt-BR, no passado e com o título entre aspas curvas, que vira a linha compacta da conversa: `Criou a nota “Plano Q1”`, `Editou a nota “Plano Q1”`, `Editou a planilha “Orçamento”`, `Marcou “Reunião com a Ana” na agenda`.

| Ferramenta | Entrada | Saída |
| --- | --- | --- |
| `note_list` | `{folder?, q?, tag?, sort?, cursor?, limit?}` | página de `NoteSummary` |
| `note_tree` | `{folder?}` | `NoteTreeLevel` |
| `note_read` | `{id}` ou `{title}` | `Note` (marca como vista) |
| `note_search` | `{q, cursor?, limit?}` | página de `NoteSearchHit` |
| `note_write` | `{id?, title, folder?, content, baseVersion?}` | `Note` (sem `id` cria) |
| `note_patch` | `{id, ops, baseVersion?}` | `Note` |
| `note_move` | `{id, folder?, title?}` | `{note, relinked}` |
| `note_delete` | `{id}` | `{ok:true}` |
| `sheet_list` | `{q?, cursor?, limit?}` | página de `SheetSummary` |
| `sheet_create` | `{title, tabs?: [nome], cells?: [{a,input}]}` | `Sheet` |
| `sheet_read` | `{id, tabId?, range}` | `SheetRange` com valores calculados |
| `sheet_write` | `{id, tabId?, cells:[{a,input}], baseVersion?}` | `SheetWriteResult` |
| `sheet_format` | `{id, tabId?, ranges, format}` | `SheetWriteResult` |
| `sheet_tab` | `{id, op:"add"|"rename"|"delete"|"freeze"|"structure", …}` | `Sheet` |
| `agenda_accounts` | `{}` | `AgendaAccount[]` |
| `agenda_list` | `{start, end, accounts?, q?}` | `AgendaList` |
| `agenda_create` | `AgendaEventBody` | `AgendaEvent` |
| `agenda_update` | `{eventId, …campos de AgendaEventBody}` | `AgendaEvent` |
| `agenda_delete` | `{eventId}` | `{ok:true}` |
| `export_create` | `ExportBody` | `ExportJob`; com `send:true` também manda o arquivo na conversa (`file.sent`) |

Antes de cada turno de chat, notas e planilhas cuja última versão é da pessoa e mais nova que a última vista pelo bot entram num bloco curto de sistema, como no canvas: `A nota "Plano Q1" foi editada pela pessoa: linhas 4–7 mudaram; use note_read antes de mudar.` Cada edição é avisada uma vez.

O guia do system prompt diz quando usar cada bloco: notas para texto que a pessoa vai reler e ligar com `[[links]]`; planilha para números, listas com colunas e contas (sempre fórmula, nunca valor calculado à mão); agenda só nas contas ligadas e sempre confirmando horário e conta antes de criar.

### Notas

Conteúdo em markdown com `[[Título]]`, `[[Título|apelido]]` e `[[Título#Seção]]`; `#tag` no texto vira tag. Pasta é um caminho com `/` (`Projetos/2026`), só para organizar; o título é único dentro da pasta.

- `GET /bots/:id/notes?folder=&q=&tag=&sort=updated|title&cursor=&limit=` → 200 `Page<NoteSummary>`. `folder` lista só aquela pasta (sem subpastas); sem `folder`, todas.
  `NoteSummary = {"id","title","folder","version","updatedAt","updatedBy":"bot"|"user","excerpt":"<até 160 caracteres em texto puro>","tags":[…]}`
- `GET /bots/:id/notes/tree?folder=&cursor=&limit=` → 200 um nível da árvore, carregado sob demanda: `{"folder":"Projetos","folders":[{"name":"2026","path":"Projetos/2026","notes":4,"folders":0}],"notes":Page<NoteSummary>}`. Pastas em ordem alfabética, notas por título.
- `GET /bots/:id/notes/search?q=&mode=full|title&cursor=&limit=` → 200 `Page<NoteSearchHit>`: `{"id","title","folder","snippet","ranges":[[início,fim]]}` (`ranges` em UTF-16 dentro do `snippet`). `mode=title` é o autocompletar do `[[`: prefixo e palavras do título, `limit` 8, sem `snippet`.
- `GET /bots/:id/notes/:noteId` → 200 `Note` = `NoteSummary` + `{"content","links":[{"target":"Plano Q1","id":"note_…"|null,"title"}],"backlinkCount":N}`. `id: null` é link para nota que não existe (o app mostra em cinza e cria ao clicar).
- `GET /bots/:id/notes/:noteId/backlinks?cursor=&limit=` → 200 `Page<NoteBacklink>`: `{"id","title","folder","snippet"}` com a linha onde o link aparece.
- `GET /bots/:id/notes/resolve?title=` → 200 `Note` da nota com esse título (na mesma pasta primeiro, depois a mais recente), 404 se não existe.
- `POST /bots/:id/notes {"title","folder"?,"content"?}` → 201 `Note`. Título repetido na pasta → 409 `{"code":"exists","id"}`.
- `PUT /bots/:id/notes/:noteId {"content","title"?,"baseVersion"?}` → 200 `Note`. É o autosave do app (debounce de 600 ms).
- `PATCH /bots/:id/notes/:noteId {"ops":[…],"baseVersion"?}` → 200 `Note`. Ops: `{"op":"replace","old","new"}` (precisa casar uma vez), `{"op":"append","text"}`, `{"op":"prepend","text"}`, `{"op":"insert_after_heading","heading","text"}`, `{"op":"toggle_task","line":N,"done":true}` (o clique no checklist do app). Erro em qualquer op cancela todas, 400 com a mensagem.
- `POST /bots/:id/notes/:noteId/move {"folder"?,"title"?}` → 200 `{"note","relinked":N}`; renomear reescreve os `[[links]]` das outras notas.
- `DELETE /bots/:id/notes/:noteId` → 200 `{"ok":true}`; vai para a lixeira (`deleted_at`), nunca apaga de verdade.

### Planilhas

Endereços A1 (`B2`, `A1:D20`, `B:B`, `3:3`). `input` é o que a pessoa digitou (`"=SOMA(B2:B9)"`, `"1520,50"`, `"12%"`, `"20/11/2026"`, `""` apaga). O **servidor** interpreta, calcula as fórmulas (nomes em inglês e em português, separador `;` ou `,`) e devolve o valor; o app nunca calcula.

`SheetCell = {"a":"B2","r":1,"c":1,"input":"=B1*2","v":3041,"t":"n"|"s"|"b"|"d"|"e"|null,"format"?:{"type":"general"|"number"|"brl"|"percent"|"date"|"datetime"|"text","decimals"?,"bold"?,"align"?},"error"?:"#DIV/0!"}`. Data (`t:"d"`) vem em `v` como `"2026-11-20"` ou ISO completo. Erro (`t:"e"`) vem com `v` = o código (`#REF!`, `#DIV/0!`, `#NAME?`, `#VALUE!`, `#CYCLE!`) e `error` com a explicação em pt-BR.

- `GET /bots/:id/sheets?q=&cursor=&limit=` → 200 `Page<SheetSummary>`: `{"id","title","version","updatedAt","updatedBy","tabs":[{"id","name"}]}`.
- `POST /bots/:id/sheets {"title","tabs"?:["Resumo"]}` → 201 `Sheet`.
- `GET /bots/:id/sheets/:sheetId` → 200 `Sheet` = `{"id","title","version","updatedAt","updatedBy","tabs":[{"id","name","index","rowCount","colCount","frozenRows","frozenCols","colWidths":{"A":140}}]}`. `rowCount`/`colCount` = última linha/coluna usada + 1 (o app mostra pelo menos 100 × 26).
- `PATCH /bots/:id/sheets/:sheetId {"title"}` → 200 `Sheet`. `DELETE /bots/:id/sheets/:sheetId` → lixeira.
- `GET /bots/:id/sheets/:sheetId/tabs/:tabId/range?range=A1:Z60` → 200 `{"tabId","range","version","cells":[SheetCell]}`, esparso (só células com conteúdo ou formato). Máximo 10 000 células por chamada; o app pede só a janela visível mais uma margem.
- `POST /bots/:id/sheets/:sheetId/tabs/:tabId/cells {"cells":[{"a":"B2","input":"=B1*2"}],"baseVersion"?}` → 200 `{"version","cells":[…]}` com as células escritas **e** todas as dependentes recalculadas. Escrita em lote (colar do Excel manda centenas de uma vez); máximo 20 000 células.
- `POST /bots/:id/sheets/:sheetId/tabs/:tabId/format {"ranges":["B2:B20"],"format":{"type":"brl","decimals":2}|null}` → 200 `{"version","cells"}`. `null` limpa o formato.
- `POST /bots/:id/sheets/:sheetId/tabs {"name"}` → 201 `SheetTab`. `PATCH …/tabs/:tabId {"name"?,"frozenRows"?,"frozenCols"?,"colWidths"?:{"B":160}}` → 200 `SheetTab`. `DELETE …/tabs/:tabId` → 200 `Sheet` (a última aba não pode sair: 400).
- `POST …/tabs/:tabId/structure {"op":"insert_rows"|"delete_rows"|"insert_cols"|"delete_cols","at":N,"count":N}` → 200 `{"version","tab"}`; fórmulas são reescritas como no Excel.

### Agenda

As contas Google ligadas na runelay da pessoa (hoje duas) aparecem para todos os bots. O servidor lê e escreve pelo conector Google Calendar da runelay; o app nunca fala com o Google.

- `GET /bots/:id/agenda/accounts` → 200 `[{"id","label":"Pessoal","email","color":"blue","primary":true,"status":"ready"|"needs_auth","calendars":[{"id","name","color","selected"}]}]`. `color` é um nome da paleta do app (`blue`, `green`, `violet`, `orange`, `pink`, `teal`…), uma por conta e estável.
- `GET /bots/:id/agenda/events?start=&end=&accounts=a,b&q=` → 200 `{"timezone":"America/Sao_Paulo","items":[AgendaEvent]}`. Período de no máximo 62 dias; recorrência já expandida; só calendários `selected`; ordenado por início.
  `AgendaEvent = {"id","accountId","calendarId","title","start","end","allDay","meet":true,"meetUrl":"https://meet.google.com/…"|null,"location","description","attendees":[{"email","name","response":"accepted"|"declined"|"tentative"|"needsAction","self","organizer"}],"status":"confirmed"|"tentative"|"cancelled","recurring":false,"updatedAt"}`. Dia inteiro: `start`/`end` como data (`"2026-11-20"`), `end` exclusivo.
- `POST /bots/:id/agenda/events {"accountId","calendarId"?,"title","start","end","allDay"?,"location"?,"description"?,"attendees"?:[email],"meet"?:true}` → 201 `AgendaEvent`. `meet:true` cria o link do Meet.
- `PATCH /bots/:id/agenda/events/:eventId {…campos}` → 200 `AgendaEvent`. Em evento recorrente muda só essa ocorrência.
- `DELETE /bots/:id/agenda/events/:eventId` → 200 `{"ok":true}`.
- Conta com `needs_auth` → 409 `{"code":"needs_auth","accountId"}`; o app pede para religar na runelay.

### Exportar

- `POST /bots/:id/exports {"kind":"note"|"sheet","id","format","tabId"?}` → 201 `ExportJob` = `{"id","kind","sourceId","format","status":"pending"|"ready"|"failed","fileName":"Plano Q1.docx","size","url","error","createdAt"}`. Formatos: nota `docx`, `pdf`, `md`; planilha `xlsx` (todas as abas, fórmulas e valores), `csv` (só a aba `tabId`, valores), `pdf`. Nota pequena e planilha até 50 000 células saem `ready` na hora; o resto `pending`.
- `GET /bots/:id/exports/:exportId` → 200 `ExportJob` (o app consulta a cada 1 s, no máximo 60 s, só enquanto `pending`).
- `GET {url}` → 200 o arquivo com `content-disposition: attachment; filename*=UTF-8''…` e o `content-type` do formato. O app salva em `~/Downloads/<fileName>` e mostra no Finder.

### App do Mac

- Bloco na conversa: o evento `block.created`/`block.updated` com `author:"bot"` entra no transcript como artefato (`.artifact(ArtifactRef)` com `kind` `note`/`sheet`/`agenda`) logo depois da linha compacta da ferramenta. O card desenha a prévia: nota com título + primeiras linhas em markdown; planilha com a miniatura da grade (cabeçalhos A/B/C e 1/2/3, valores calculados); agenda com os eventos do dia ou da semana. Bloco mais antigo do mesmo item vira "Versão anterior" (compacto, esmaecido) e o mais novo mostra o estado atual.
- Clicar no bloco abre o painel de artefato (o mesmo das apresentações) encaixado à direita, sem escurecer a conversa, para editar com o bot ao lado. O painel aberto atualiza ao vivo com `block.updated` (como o `code.edit`), sem perder o cursor da pessoa; o trecho de `changed` ganha um destaque que some sozinho.
- Botão "Arquivos do bot" no topo da conversa abre o mesmo painel com Notas, Planilhas e Agenda (listas e busca do servidor).
- Até o servidor existir, o app usa `FixtureBlocksClient` (protocolo `BlocksClient`); a troca para `RemoteBlocksClient` não mexe nas views.

### Verificado

Pendente: o servidor dos blocos ainda não existe. Os corpos acima são o contrato; quem implementar o servidor captura os corpos reais aqui.
