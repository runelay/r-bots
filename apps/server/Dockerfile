# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.4-debian AS bun

FROM node:24-bookworm

ARG CLAUDE_CODE_VERSION=2.1.328
ARG CODEX_VERSION=0.170.0
ARG AGENT_BROWSER_VERSION=0.27.0
ARG SUPABASE_VERSION=3.0.0
ARG PNPM_VERSION=12.18.0

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep procps sudo less unzip \
      ffmpeg poppler-utils xvfb xdotool openbox xterm x11-utils fonts-liberation fonts-noto-color-emoji \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && curl -fsSL -o /tmp/supabase.deb "https://github.com/supabase/cli/releases/download/v${SUPABASE_VERSION}/supabase_${SUPABASE_VERSION}_linux_amd64.deb" \
 && dpkg -i /tmp/supabase.deb && rm /tmp/supabase.deb

RUN usermod -l anderson -d /home/anderson -m node \
 && groupmod -n anderson node \
 && groupadd -g 1501 runelaybot \
 && useradd -m -u 1501 -g 1501 -s /bin/bash runelaybot \
 && chmod 750 /home/runelaybot \
 && echo "anderson ALL=(runelaybot) NOPASSWD: ALL" > /etc/sudoers.d/runelaybot \
 && chmod 440 /etc/sudoers.d/runelaybot \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

RUN --mount=type=cache,target=/root/.npm \
    npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "agent-browser@${AGENT_BROWSER_VERSION}" \
      "pnpm@${PNPM_VERSION}"

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

RUN HOME=/home/anderson agent-browser install --with-deps \
 && chrome_dir="$(ls -d /home/anderson/.agent-browser/browsers/chrome-* | sort | tail -1)" \
 && cp -a "$chrome_dir" /opt/runelay-chrome \
 && chmod -R a+rX /opt/runelay-chrome \
 && mkdir -p /home/anderson/.config/gh /home/anderson/.cache /home/anderson/.local/share /home/anderson/.supabase /home/anderson/.claude /home/anderson/.codex \
 && chown -R anderson:anderson /home/anderson

ENV HOME=/home/anderson \
    USER=anderson \
    LANG=C.UTF-8 \
    DISABLE_AUTOUPDATER=1 \
    DESKTOP_CHROME=/opt/runelay-chrome/chrome

WORKDIR /app
RUN chown anderson:anderson /app
COPY --chown=anderson:anderson package.json bun.lock tsconfig.base.json /app/
COPY --chown=anderson:anderson apps/server/package.json /app/apps/server/
COPY --chown=anderson:anderson packages/protocol/package.json /app/packages/protocol/
COPY --chown=anderson:anderson packages/providers/package.json /app/packages/providers/
USER anderson
RUN --mount=type=cache,target=/home/anderson/.bun/install/cache,uid=1000,gid=1000 \
    bun install --frozen-lockfile --production

COPY --chown=anderson:anderson packages/ /app/packages/
COPY --chown=anderson:anderson apps/server/ /app/apps/server/

ENV PATH=/home/anderson/.local/bin:$PATH
WORKDIR /app/apps/server
CMD ["bun", "src/index.ts"]
