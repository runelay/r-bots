# Artefatos e canvas

## v18 (19/11): artifacts (HTML pages the bot builds)

Every bot has two tools on the `bots` MCP server, with no approval (they only write local files):

- `artifact_create {"title","kind":"slides"|"dashboard"|"page","html"}` → `{"artifactId":"art_…","title","kind","version":1}`.
- `artifact_update {"id", "html"? , "edits"?: [{"old","new"}], "title"?}` → same shape with the new `version`. `edits` must match the latest version exactly and once; otherwise the call fails with a pt-BR message and no version is written.

HTML must be a full document (`<!doctype html>`/`<html>`/`<body>`), at most 600 000 characters. Files: `data/bots/<botId>/artifacts/<artifactId>/v<N>.html` + `meta.json`.

The system prompt carries a guide (`artifactGuide` in `apps/server/src/modules/artifacts/services/artifacts.service.ts`): self-contained HTML, dark theme, responsive; slides as `<section class="slide">` with ←/→ and a counter, exposing `window.slideCount` and `window.goToSlide(i)`; dashboards with Chart.js; no invented data; short design rules (hierarchy, few colors, big numbers, no slop).

### Stream

After the tool's `call.settled`:
```json
{"type":"artifact.created","data":{"artifactId":"art_Z9IRi4jSWofA","title":"Como funciona a fotossíntese","kind":"slides","version":1,"botId":"teste-html","callId":"call_…"}}
{"type":"artifact.updated","data":{"artifactId":"art_Z9IRi4jSWofA","title":"Como funciona a fotossíntese","kind":"slides","version":2,"botId":"teste-html","callId":"call_…"}}
```
The `call.settled` output is the tool result without the internal event.

### Routes

- `GET /bots/:id/artifacts` → 200, newest first: `[{"id","title","kind","createdAt","updatedAt","version","url","versions":[{"n","createdAt","size","url"}]}]` (`url` is relative, e.g. `/bots/teste-html/artifacts/art_…/v/2.html`).
- `GET /bots/:id/artifacts/:artifactId` → 200 the same object; 404 `{"ok":false,"error":"Artefato não encontrado."}`.
- `GET /bots/:id/artifacts/:artifactId/v/:n.html` → 200 `text/html`, 404 `{"ok":false,"error":"Versão não encontrada."}`. Headers:
  `content-security-policy: default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; font-src https://fonts.gstatic.com data:; img-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `cache-control: no-cache`. Only GET (HEAD gives 404).

### Mac

- Transcript entry `.artifact(ArtifactRef)` → `ArtifactCard`: live thumbnail (WKWebView, `pageZoom` = width/1280, no hit testing), title, "Apresentação"/"Dashboard"/"Página", "· vN" when N > 1. The completed `artifact_*` tool row is hidden.
- `ArtifactViewerLayer` (RootView, above sheets): scrim + panel like `ModalOverlay`, interactive WKWebView loading the server route (CSP applies), version menu, "Abrir no navegador" (saves `~/Downloads/<título>.html` with the CSP as `<meta>` and opens it), "Exportar PDF" (`~/Downloads/<título>.pdf`; slides: offscreen 1280×720 WKWebView, `goToSlide(i)` or arrow keys, one landscape page per slide via `createPDF` + PDFKit), ⇧⌘F presents full screen (window full screen + edge-to-edge), esc leaves/closes, "…" → copy link.
- Inspector tab "Biblioteca" (`InspectorTab.library`) lists `GET /bots/:id/artifacts`, reloaded on every artifact event.

### Verified 19/11

Test bot "Teste HTML" (Sonnet 5.5): 4-slide deck + Chart.js dashboard from fixed data, then `artifact_update` by edits → v2 with `goToSlide`. curl over the tailnet: 200 with the CSP header; unknown version and `..` id → 404. Mac build + `make-app.sh` signed "runelay bots Local".

---

## v20 (19/11): canvas (editable diagrams, bot + person)

A canvas is an artifact with `kind: "canvas"`. Instead of HTML, every version is a JSON document: `data/bots/<botId>/artifacts/<artifactId>/v<N>.json` + `meta.json`.

```json
{"schema":1,"layout":"flow"|"mindmap"|"diagram",
 "nodes":[{"id","text","x","y","w","h","shape":"box"|"round"|"diamond"|"ellipse"|"note","color"?}],
 "edges":[{"id","from","to","label"?,"style"?:"dashed"}],
 "groups"?:[{"id","label","nodeIds"}]}
```
`x,y` are the top-left corner in world points; `w,h` come from the text when missing. `color` is one of `neutral grey red orange amber yellow green teal blue indigo violet pink`; without it each shape has a default (ellipse green, diamond yellow, box/round blue, note neutral). At most 400 nodes and 800 edges. Edges pointing to unknown nodes are dropped.

`meta.json` gains `versions[].author` (`"bot"`|`"user"`) and `canvas: {seen, notified}`: the last version the bot produced or read, and the last user version already reported to it.

### Bot tools (all bots, no approval, `apps/server/src/modules/canvas/services/canvas.service.ts`)

- `canvas_create {"title","kind"?: "flow"|"mindmap"|"diagram","nodes":[{id,text,shape?,color?,x?,y?}],"edges":[{from,to,label?,style?}],"groups"?}` → `{"artifactId","title","kind":"canvas","version":1,"nodes","edges"}`. If any node lacks x/y, the server lays out everything: mindmap radial from the root (node with no incoming edges), flow/diagram layered top to bottom (DFS cycle breaking, longest-path layers, barycenter ordering, parent-centered x).
- `canvas_read {"id"}` → `{"artifactId","title","version","editedByPerson"?,"doc"}`: the latest state, including the person's edits. Marks it as seen.
- `canvas_update {"id","ops":[…],"title"?}` → same shape as create plus `editedByPersonBefore?`. Ops apply on the latest version: `add_node {text,id?,shape?,color?,x?,y?,parent?}` (no x/y: placed next to the connected node without overlapping), `update_node {id,text?,shape?,color?|null,x?,y?}`, `remove_node {id}`, `add_edge {from,to,label?,style?,id?}`, `update_edge {id,label?,style?}`, `remove_edge {id}|{from,to}`, `set_group {label,nodeIds,id?}`, `remove_group {id}`, `relayout {}`. Any error aborts the call with a pt-BR message; no version is written.
- System prompt guide (`canvasGuide`): use canvas instead of HTML for logic, flows, mind maps, architecture and processes; few words per box; ~25 boxes before grouping; read before changing something the person edited; no relayout over hand-placed positions.

### Routes

- `GET /bots/:id/artifacts/:artifactId/doc` → 200 latest doc + `"version"`. `GET …/v/:n.json` → that version. 404 for unknown versions. List/detail `url`s point to `.json` for canvases.
- `PUT /bots/:id/artifacts/:artifactId/doc {"doc", "baseVersion"?}` → 200 the artifact object. Saves with author `user`. Saves within 120 s of the previous user version (not yet seen by the bot) overwrite that version instead of creating one, so autosave does not flood versions. `baseVersion` older than a bot version → 409 `{"code":"stale","version"}` (the app reloads). Emits on the bot's thread session:
  `{"type":"artifact.updated","data":{"artifactId","title","kind":"canvas","version","author":"user","botId"}}`. Bot-made events carry `"author":"bot"`.
- `POST /bots/:id/artifacts/:artifactId/layout {"doc"}` → 200 the doc laid out (not saved). Used by "Organizar".

### Edit note

Before each chat turn (not schedules or groups), canvases whose latest version is the person's and newer than `seen`/`notified` add a short system block: `O canvas "X" (art_…) foi editado pela pessoa: +2 caixas ("…"), 1 caixa renomeada ("a" → "b"), +1 conexão (…), 3 caixas movidas.` plus "use canvas_read antes de mudar". Each edit is reported once.

### Mac (native SwiftUI, no WebView)

- `Features/Artifacts/Stores/CanvasEditor.swift` (state, undo, autosave, shortcuts, Mermaid) and `Features/Artifacts/Views/CanvasViews.swift` (surface, nodes, edges, toolbar, snapshot, export).
- Surface: drag background pans, two-finger scroll pans, pinch and ⌘scroll zoom, ⌘+ ⌘− ⌘0 (fit), dotted grid. ⇧ drag on the background = selection rectangle.
- Nodes in `Theme.surfaceRaised` (or palette tint), shapes box/round/diamond/ellipse/note; double click edits (Enter or click outside confirms, esc cancels). Double click on empty space creates a box. Tab = connected child, Enter = sibling (mind-map style). Click, ⇧ click, drag moves the selection, ⌫ deletes, ⌘Z/⌘⇧Z, ⌘D duplicates, ⌘A.
- Hover shows 4 handles; drag to another box connects (bezier with arrow), drop on empty space creates a connected box. Double click an edge to edit its label.
- Glass toolbar: shape, color, solid/dashed line, "Organizar" (animated relayout), zoom. Autosave 800 ms after the last change via PUT, "Salvando…"/"Salvo" top right.
- New boxes pop in with the Motion spring; relayout, undo and bot updates animate positions (edges are animatable shapes).
- Card in the conversation draws the latest doc natively (`CanvasThumbnail`); user-authored events do not add cards. Viewer opens the editor; "…" menu: Exportar PNG, Exportar PDF (ImageRenderer, light appearance, ~/Downloads), Copiar como Mermaid. Library lists canvases with the other artifacts. Completed `canvas_create`/`canvas_update` tool rows are hidden.

### Layout and look (19/11, second pass)

- Layered layout inserts dummy nodes for edges that skip layers, so a skipped branch gets its own column. Edges labelled sim/yes lean left and não/no lean right. A final pass pushes apart any boxes that overlap (gap 32), for mind maps too.
- Box size comes from the text: Virgil at 16 pt, wrapping only between words at 200 pt, line 24. Box/round/note: `w = max(120, text + 36)`, `h = max(56, lines·24 + 28)`. Diamond: `1.5·text + 48` × `1.6·lines·24 + 40`. Ellipse: `1.25·text + 44`. The server estimates 9.4 pt per character. The app measures with NSFont and refits sizes on load (center kept, not saved until the next edit). The edit diff compares centers, so a refit does not count as a move.
- The app routes edges: direct bezier, or around the right/left (above/below for horizontal edges) when the direct curve crosses another box. "não" from a vertical branch prefers the right side. Labels slide along the curve (t 0.5 → 0.2/0.8) to the first spot that is clear of every box.
- Excalidraw look: double-pass hand stroke with deterministic jitter per id (`CanvasRough`), hand-drawn chevron arrowheads, Excalidraw palette (dark: blue #4dabf7, green #69db7c, yellow #ffd43b, red #ff8787, violet #b197fc, neutral #e9ecef; light: the darker Excalidraw shades), 16 % fill plus diagonal hachure on colored shapes, neutral without fill. Text in Virgil (`Resources/Fonts/Virgil.woff2`, OFL, family "Virgil 3 YOFF"), with Chalkboard SE as the fallback. Selection is a dashed accent frame.
- Cursors: hand on the toolbar, menus, header, edges, labels and card; open/closed hand on boxes and on the background while panning; crosshair on connection handles; I-beam while editing.

### Verified 19/11

Bot "Teste Canvas" (Sonnet 5.5): a 3-level mind map (17 boxes, radial) and an approval flow with a "Valor acima de R$ 500?" diamond (sim/não). PUT on the flow renamed "Pagamento" → "Pagar reembolso", moved "Análise do pedido" and added "Aprovação do gestor" → "Fim" ("recusa"): a new user version, a second PUT merged into it, and `artifact.updated` with `author:"user"` appeared on the thread. Next message: the bot called `canvas_read` (`editedByPerson` listed the rename, the new connection and the moves), then `canvas_update` with ops and kept every edit (v4, `author:"bot"`). Layout preview of v4: sim on the left, não on the right, 0 overlaps. Bot deleted with `POST /bots/teste-canvas/delete`. Mac build + `make-app.sh` signed "runelay bots Local".

---

## v44 (20/11): conteúdo do usuário isolado (uploads, artefatos, exportações, navegador)

`GET /bots/:id/artifacts/:artifactId/v/:n.html` ganhou duas diretivas no fim do CSP:

```
… form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-downloads
```

Sem `allow-same-origin`, `allow-popups` nem `allow-top-navigation`: a página roda com origem opaca, então `localStorage`, `sessionStorage`, cookies e IndexedDB não existem, e `window.open('/health')` ou navegar o topo não saem do quadro. Os scripts e fontes dos CDNs liberados continuam carregando (o Google Fonts responde com CORS aberto). `window.slideCount`/`window.goToSlide` e o PDF do app seguem funcionando: o PDF é feito no Mac (`ArtifactPDFRenderer`, `evaluateJavaScript` do próprio WebKit), não no servidor. O guia do bot (`artifactGuide`) agora diz para não usar armazenamento nem popups.

App: o visualizador cancela qualquer navegação cujo endereço (sem o fragmento) não seja o do próprio artefato; link clicado (`linkActivated`) só abre no navegador do sistema quando é `http`/`https`.

### Verificado 20/11

Por testes: `artifacts.test.ts` (11). Swift alterado sem build (o Mac precisa de `make-app.sh`).
