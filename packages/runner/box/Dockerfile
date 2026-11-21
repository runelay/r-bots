# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.4-debian AS bun

FROM oven/bun:1.4.4-debian AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/providers/package.json packages/providers/
COPY packages/runner/package.json packages/runner/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY packages/ packages/
RUN mkdir -p /out \
 && bun build --target=bun packages/runner/src/box-agent-main.ts --outfile /out/box-agent.js \
 && cp "$(ls -d /src/node_modules/.bun/@anthropic-ai+claude-agent-sdk-linux-x64@*/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 | tail -1)/claude" /out/claude-agent

FROM node:24-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.328
ARG CODEX_VERSION=0.170.0
ARG PNPM_VERSION=12.18.0
ARG INSTALL_CURSOR=0
ARG GROK_NPM_PACKAGE=
ARG RBOTS_PROVIDERS=claude,codex

LABEL rbots.providers="${RBOTS_PROVIDERS}"

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client jq ripgrep procps sudo less unzip xz-utils file bubblewrap acl \
      util-linux python3 \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh

RUN userdel -r node \
 && (groupdel node 2>/dev/null || true) \
 && groupadd -g 1000 app \
 && useradd -m -u 1000 -g 1000 -s /bin/bash app \
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
 && install -d -o app -g app -m 0750 /data \
 && install -d -o root -g rbwork -m 2775 /cache \
 && install -d -o root -g root -m 0755 /etc/rb-sandbox /opt/rbots \
 && echo 0 > /etc/rb-sandbox/bwrap \
 && mkdir -p /home/app/.claude /home/app/.codex /home/app/.config /home/app/.cache \
 && chown -R app:app /home/app

RUN --mount=type=cache,target=/root/.npm \
    npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "pnpm@${PNPM_VERSION}" \
 && if [ -n "${GROK_NPM_PACKAGE}" ]; then npm install -g "${GROK_NPM_PACKAGE}"; fi

RUN if [ "${INSTALL_CURSOR}" = 1 ]; then \
      curl -fsSL https://cursor.com/install -o /tmp/cursor-install.sh \
      && HOME=/home/app su app -c "bash /tmp/cursor-install.sh" \
      && ln -sf /home/app/.local/bin/cursor-agent /usr/local/bin/cursor-agent \
      && rm /tmp/cursor-install.sh; \
    fi

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -eu' \
      'printf "%s\n" "${RBOX_SANDBOX_ROOTS:-}" | tr ":" "\n" | sed "/^$/d" > /etc/rb-sandbox/roots' \
      ': > /etc/rb-sandbox/hide' \
      'exec sleep infinity' > /usr/local/bin/rbbox-init \
 && chmod 0755 /usr/local/bin/rbbox-init

COPY --chmod=0755 apps/server/rb-sandbox-exec.sh /usr/local/bin/rb-sandbox-exec
COPY --from=build --chmod=0644 /out/box-agent.js /opt/rbots/box-agent.js
COPY --from=build --chmod=0755 /out/claude-agent /opt/rbots/claude-agent

ENV HOME=/home/app \
    LANG=C.UTF-8 \
    DISABLE_AUTOUPDATER=1 \
    BOTS_TOOL_SANDBOX=uid \
    CLAUDE_CODE_EXECUTABLE=/opt/rbots/claude-agent

WORKDIR /data
CMD ["/usr/local/bin/rbbox-init"]
