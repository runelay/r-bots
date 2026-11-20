# Git e Linear no app

Telas do app que mostram os PRs do GitHub e o quadro do Linear da conta do dono. Todas as rotas são só do dono (`ownerRoutes`: `github/**` e `linear/**`, qualquer método).

## v57 (20/11): Git e Linear no app

### GitHub (`gh` do servidor)

O servidor usa o `gh` já logado no contêiner (`~/.config/gh`), com `gh api graphql`. Cache curto em memória: lista 30 s, PR 20 s, índice de PR por issue 60 s. `?refresh=1` ignora o cache. Toda escrita limpa o cache e devolve o PR atualizado.

| Rota | O que faz |
|---|---|
| `GET /github/summary` | `{ counts: { mine, review, mentions, merged } }` |
| `GET /github/pulls?filter=mine\|review\|mentions\|merged&repo=dono/nome&q=texto&cursor=` | lista paginada no servidor (30 por página, busca do GitHub), contagens dos quatro filtros e grupos por repositório |
| `GET /github/repos/:dono/:nome/pulls/:n` | `{ pull }` com descrição, arquivos (100), revisões, conversas no código, comentários, commits (40) e checks |
| `POST /github/repos/:dono/:nome/pulls/:n/merge` | `{ method: "squash"\|"merge"\|"rebase", deleteBranch }` → `{ pull, branchDeleted }`. Recusa (400) PR fechado, rascunho, com conflito ou método que o repositório não aceita. Usa `expectedHeadOid` |
| `POST …/review` | `{ event: "approve"\|"request_changes"\|"comment", body }` (texto obrigatório fora do approve) → `{ pull }` |
| `POST …/comment` | `{ body }` → `{ pull }` |
| `POST …/reply` | `{ threadId, body }` (a conversa tem que ser do PR) → `{ pull }` |
| `POST …/ready` | tira do rascunho → `{ pull }` |
| `POST …/rerun` | roda de novo os workflows com check falhando → `{ pull, reruns }` |

Filtros: `mine` = `is:pr is:open author:@me`, `review` = `review-requested:@me`, `mentions` = `involves:@me -author:@me`, `merged` = `is:merged author:@me merged:>=` 7 dias. Todos com `archived:false sort:updated-desc`.

`linear` em cada PR vem da branch (`anderson/cty-1319-…` → `CTY-1319`), do título ou de `closes/fixes/linear.app/…/issue/` no corpo.

Erros: 503 quando o `gh` não está logado ou instalado, 404, 403, 422 (GraphQL recusou), 502 nos outros casos, sempre `{ ok: false, error }`.

### Linear (pelo runelay)

O servidor acha a conexão do Linear no runelay (`list_connections`, nome com `linear`, hoje `linear_server`) e chama as ferramentas oficiais por `call_tool`: `list_teams`, `list_custom_views`, `list_issues`, `list_issue_statuses`, `get_issue`, `list_comments`, `save_issue`. Sem conexão: 503 `"Conecte o Linear em Conectores para ver suas issues aqui."`.

| Rota | O que faz |
|---|---|
| `GET /linear/summary` | `{ started, more }`: issues suas em andamento (até 100) |
| `GET /linear/views` | `{ views: [{ id, name, kind: "mine"\|"team"\|"view", description, team, url }] }`: `mine`, `team:<id>` e `view:<id>` (visões salvas de issues) |
| `GET /linear/board?view=&q=&cursor=` | `{ view, columns: [{ key, name, type, count }], issues, nextCursor, searchable }`, 100 por página. `q` não vale em visão salva (400) |
| `GET /linear/issues/:id` | `{ issue }` com descrição limpa (tags do Linear viram link markdown), comentários, sub-issues, links, `states` do time e `pr` |
| `POST /linear/issues/:id/state` | `{ column: "tipo:nome" }` ou id do status → `{ id, state, stateType, column }` |
| `POST /linear/issues/:id/assign` | atribui a mim → `{ id, assigned: true }` |
| `POST /linear/issues/:id/start` | move para o status de andamento do time (prefere "progresso"), atribui a mim se estiver sem dono → `{ id, state, stateType, column, branch }` |

Colunas: os status dos times das issues, na ordem triagem, backlog, não iniciado, em andamento (progresso, review, correção, teste, deploy, aguardando), concluído; cancelado e duplicado só aparecem com issue. Chave da coluna `tipo:nome`, para juntar times com o mesmo fluxo.

Cada issue traz `pr` (`{ repo, number, title, url, state, draft, ci, review }`) quando um PR seu cita a issue (índice dos últimos 100 PRs com `involves:@me`; no detalhe também procura `head:<gitBranchName>`).

### Verificado

`overview` e `pullDetail` rodados contra o GitHub real (só leitura), saída resumida:

```json
{
  "counts": { "mine": 17, "review": 0, "mentions": 2, "merged": 108 },
  "repos": [{ "name": "Conty-App/conty-lp", "owner": "Conty-App", "avatarUrl": "https://avatars.githubusercontent.com/u/222265698?v=4", "count": 5 }],
  "first": {
    "id": "PR_kwDOVVSno88AAAABQuWs7Q", "repo": "Conty-App/conty-lp", "number": 31,
    "draft": false, "state": "open", "head": "feat/hero-com-logos-reais-das-redes", "base": "main",
    "ci": "none", "review": null, "mergeable": "mergeable", "additions": 567, "deletions": 42,
    "comments": 0, "labels": [], "updatedAt": "2026-11-20T18:27:19Z", "mergedAt": null, "linear": null
  },
  "total": 17,
  "next": null
}
```

```json
{ "mergeState": "clean", "mergeMethods": ["squash", "merge", "rebase"], "defaultMergeMethod": "merge", "deleteBranchOnMerge": false, "viewerIsAuthor": true, "fileCount": 8, "commitCount": 8, "checks": [] }
```

Índice de PR por issue: `CTY-1318 → { repo: "Conty-App/Conty-api", number: 1215, state: "merged", ci: "success" }`.

As respostas do Linear usadas pelo servidor (`list_issues` com `fields`, `list_issue_statuses`, `get_issue`, `list_comments`) foram conferidas pelo runelay com dados reais do time CTY.
