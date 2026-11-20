# Visão geral: base, transporte e convenções

## runelay bots: verified protocol

Every body below was captured from the running server (eve 1.1.0, stream version 27) on 2026-11-19.
The approval flow (`interaction.opened` → answer → `interaction.settled`, `call.*`, `content.completed`, `usage.recorded`) was captured from a temporary copy of Lia that used a mock model and the real `browser_click` tool, because there are no model credentials on the VPS yet. With real credentials the shapes are the same; only text, ids and token counts change.

### Deviations

1. **Tailnet port is 10447, not 10445.** `https://<servidor>:10445` is taken by another service. Base URL for the Mac: `https://<servidor>:10447`.
2. **Three eve processes behind a gateway.** eve 1.1.0 runs one root agent per server process (workspace members are built and started separately). The server is an eve agent workspace (`agents/boss`, `agents/davi`, `agents/lia`), each member on its own loopback port (3101, 3102, 3103), plus a small Node gateway on `127.0.0.1:2000` that serves the custom routes and proxies `/bots/:id/eve/*` to the member with the `/bots/:id` prefix stripped. The Mac only needs `sessionBasePath`, as the contract says.
3. **Boss delegates to local copies of Davi and Lia.** eve refuses remote-agent callbacks over loopback outside `eve dev`, so Boss has declared subagents `davi` and `lia` with the same instructions and the same tools. They share the same browser session and data dir as Lia, so `/bots/lia/browser` also reflects what Boss's Lia did. Their child sessions live on Boss's stream and do not appear in `/bots/davi/sessions` or `/bots/lia/sessions`.
4. **Paths inside events are member-relative.** Anything eve puts in an event that is a path (for example `child.opened.data.stream`) starts with `/eve/v1/...`. Prefix it with `/bots/<id>` (the part of `sessionBasePath` before `/eve/v1`).
5. **`GET /bots` schedules carry an extra `timezone` field** (`America/Sao_Paulo`). Davi's cron is the contract's `*/30 8-22 * * *`, so the last run of the day is 22:30.
6. **No route auth.** The eve channels use `none()` and the gateway has no token: the only protection is that it listens on loopback and is exposed only to the tailnet.
7. **Schedule runs in `/sessions` are unverified.** Schedules only fire under `eve start` on their cron. The hook marks a session as `"source": "schedule"` when the delivery carries a `scheduleId` or runs as the app identity; this path has not fired yet.
8. **A prewarmed session (create without `message`) appears in `/sessions` only after its first message.**

### Base

```
BASE = https://<servidor>:10447     (Mac, over tailnet)
       http://127.0.0.1:2000                    (on the VPS)
```

All JSON. No auth header.

## v2 (19/11): Claude Agent SDK engine

Captured from `apps/server/` (Claude Agent SDK 0.3.328, Claude Code 2.1.327, model `claude-sonnet-5-5`, subscription login) on 2026-11-19. Same base URL (`https://<servidor>:10447`), same session API under `sessionBasePath`, same NDJSON line format (`{"at","facts"}`, `{"progress"}`, `{"$eve":...}`) and cursor semantics (`startIndex` = number of stored lines already read).

## v3 (19/11): AI proxy with connected accounts

### Gateway MCP endpoint

`POST /mcp/:botId/:sessionId` (streamable HTTP, stateless, JSON responses). `Authorization: Bearer <per-turn token>`; the token is minted for one turn and revoked when it ends, and must match the bot and session in the path (else `401`). Tools: the bot's `prod_query`, `browser_*`, plus `delegate` when it has delegates. `browser_click` / `browser_fill` block inside the handler until the answer route resolves the approval (`interaction.opened` → answer → `interaction.settled`), the same events as v2. VPS providers call `http://127.0.0.1:2000/mcp/…`; Mac providers call the app's local MCP proxy, which forwards over `/runner/connect` (v38).

## v10

No server change. Notifications are handled entirely by the Mac app.

---
