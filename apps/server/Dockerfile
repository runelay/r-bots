# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.4-debian AS bun

FROM oven/bun:1.4.4-debian AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/providers/package.json packages/providers/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY packages/ packages/
COPY apps/server/ apps/server/
RUN cd apps/server \
 && bun build --compile --minify --sourcemap --bytecode --target=bun-linux-x64 src/index.ts --outfile /out/runelay-bots-server \
 && cp -r bin /out/bin \
 && cp "$(ls -d /src/node_modules/.bun/@anthropic-ai+claude-agent-sdk-linux-x64@*/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 | tail -1)/claude" /out/claude-agent \
 && mkdir -p /out/native \
 && cp "$(ls -d /src/node_modules/.bun/@firecrawl+anydoc-linux-x64-gnu@*/node_modules/@firecrawl/anydoc-linux-x64-gnu | tail -1)/anydoc.linux-x64-gnu.node" /out/native/

FROM node:24-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.328
ARG CODEX_VERSION=0.170.0
ARG AGENT_BROWSER_VERSION=0.27.0
ARG SUPABASE_VERSION=3.0.0
ARG PNPM_VERSION=12.18.0
ARG WRANGLER_VERSION=4.158.0

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client jq ripgrep procps sudo less unzip xz-utils file bubblewrap age acl \
      python3 \
      ffmpeg poppler-utils xvfb xdotool openbox xterm x11-utils fonts-liberation fonts-noto-color-emoji \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /etc/apt/keyrings/pgdg.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends gh postgresql-client-17 \
 && curl -fsSL -o /tmp/supabase.deb "https://github.com/supabase/cli/releases/download/v${SUPABASE_VERSION}/supabase_${SUPABASE_VERSION}_linux_amd64.deb" \
 && dpkg -i /tmp/supabase.deb && rm /tmp/supabase.deb

RUN userdel -r node \
 && (groupdel node 2>/dev/null || true) \
 && groupadd -g 1000 app \
 && useradd -m -u 1000 -g 1000 -s /bin/bash app \
 && groupadd -g 1501 runelaybot \
 && useradd -m -u 1501 -g 1501 -s /bin/bash runelaybot \
 && chmod 750 /home/runelaybot \
 && echo "app ALL=(runelaybot) NOPASSWD: ALL" > /etc/sudoers.d/runelaybot \
 && chmod 440 /etc/sudoers.d/runelaybot \
 && groupadd -g 1503 rbwork \
 && groupadd -g 1502 runelaytool \
 && useradd -m -u 1502 -g 1502 -G rbwork -s /bin/bash runelaytool \
 && chmod 700 /home/runelaytool \
 && usermod -a -G rbwork app \
 && printf '%s\n' \
      'Defaults!/usr/local/bin/rb-sandbox-exec !syslog, !pam_session, !lecture, env_reset' \
      'app ALL=(runelaytool) NOPASSWD: /usr/local/bin/rb-sandbox-exec' > /etc/sudoers.d/runelaytool \
 && chmod 440 /etc/sudoers.d/runelaytool \
 && visudo -c -q \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

RUN --mount=type=cache,target=/root/.npm \
    npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "agent-browser@${AGENT_BROWSER_VERSION}" \
      "pnpm@${PNPM_VERSION}" \
      "wrangler@${WRANGLER_VERSION}"

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

RUN HOME=/home/app agent-browser install --with-deps \
 && chrome_dir="$(ls -d /home/app/.agent-browser/browsers/chrome-* | sort | tail -1)" \
 && cp -a "$chrome_dir" /opt/runelay-chrome \
 && chmod -R a+rX /opt/runelay-chrome \
 && mkdir -p /home/app/.config/gh /home/app/.cache /home/app/.local/share /home/app/.supabase /home/app/.config/.wrangler /home/app/.claude /home/app/.codex \
 && chown -R app:app /home/app

RUN printf '%s\n' \
      '{' \
      '  "URLBlocklist": ["file://*", "chrome://*", "view-source:*", "devtools://*", "chrome-extension://*"],' \
      '  "URLAllowlist": [],' \
      '  "DownloadRestrictions": 3' \
      '}' > /tmp/runelay-policy.json \
 && for dir in /etc/chromium/policies/managed /etc/opt/chrome/policies/managed /etc/opt/chrome_for_testing/policies/managed; do \
      install -d -o root -g root -m 0755 "$dir" \
      && install -o root -g root -m 0644 /tmp/runelay-policy.json "$dir/runelay.json"; \
    done \
 && rm /tmp/runelay-policy.json

ENV HOME=/home/app \
    USER=app \
    LANG=C.UTF-8 \
    DISABLE_AUTOUPDATER=1 \
    DESKTOP_CHROME=/opt/runelay-chrome/chrome

WORKDIR /app/apps/server
COPY --from=build /out/ /app/apps/server/
RUN chown -R root:root /app && chmod -R u=rwX,go=rX /app
COPY --chmod=0755 apps/server/docker-entrypoint.sh /usr/local/bin/runelay-entrypoint
COPY --chmod=0755 apps/server/rb-sandbox-exec.sh /usr/local/bin/rb-sandbox-exec
ENV BOTS_APP_DIR=/app/apps/server \
    BOTS_TOOL_SANDBOX=uid \
    CLAUDE_CODE_EXECUTABLE=/app/apps/server/claude-agent \
    NAPI_RS_NATIVE_LIBRARY_PATH=/app/apps/server/native/anydoc.linux-x64-gnu.node
ENTRYPOINT ["/usr/local/bin/runelay-entrypoint"]
CMD ["./runelay-bots-server"]
