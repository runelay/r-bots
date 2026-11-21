# syntax=docker/dockerfile:1.7
ARG BUN_IMAGE=oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e
ARG NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

FROM ${BUN_IMAGE} AS bun

FROM ${BUN_IMAGE} AS deps
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/providers/package.json packages/providers/
COPY packages/runner/package.json packages/runner/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

FROM deps AS sdk
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG TARGETARCH
ARG CLAUDE_CODE_VERSION=2.1.328
RUN case "${TARGETARCH}" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; esac \
 && mkdir -p /out/native \
 && cp "/src/node_modules/.bun/@anthropic-ai+claude-agent-sdk-linux-${arch}"@*"/node_modules/@anthropic-ai/claude-agent-sdk-linux-${arch}/claude" /out/claude-agent \
 && cp "/src/node_modules/.bun/@firecrawl+anydoc-linux-${arch}-gnu"@*"/node_modules/@firecrawl/anydoc-linux-${arch}-gnu/anydoc.linux-${arch}-gnu.node" /out/native/anydoc.node \
 && found="$(/out/claude-agent --version | cut -d' ' -f1)" \
 && { [ "${found}" = "${CLAUDE_CODE_VERSION}" ] || { echo "claude-agent-sdk ships Claude Code ${found}, CLAUDE_CODE_VERSION is ${CLAUDE_CODE_VERSION}" >&2; exit 1; }; } \
 && chmod 0755 /out/claude-agent \
 && chmod 0644 /out/native/anydoc.node

FROM deps AS server-build
COPY packages/protocol/ packages/protocol/
COPY packages/providers/ packages/providers/
COPY apps/server/ apps/server/
WORKDIR /src/apps/server
RUN bun build --target=bun --bytecode --minify --sourcemap=linked \
      --public-path=/app/apps/server/dist/ --external '@firecrawl/anydoc-linux-*' \
      src/index.ts --outdir /out/app/dist \
 && printf '%s\n' '#!/bin/sh' 'exec /usr/local/bin/bun /app/apps/server/dist/index.js "$@"' > /out/app/runelay-bots-server \
 && cp -r bin /out/bin \
 && chmod -R u=rwX,go=rX /out \
 && chmod 0755 /out/app/runelay-bots-server

FROM deps AS runner-build
COPY packages/protocol/ packages/protocol/
COPY packages/runner/ packages/runner/
RUN bun build --target=bun --bytecode --minify packages/runner/src/main.ts --outdir /out/runner \
 && printf '%s\n' '#!/bin/sh' 'exec /usr/local/bin/bun /opt/rbots/runner/main.js "$@"' > /out/rbots-runner \
 && chmod -R u=rwX,go=rX /out \
 && chmod 0755 /out/rbots-runner

FROM deps AS box-agent-build
COPY packages/protocol/ packages/protocol/
COPY packages/providers/ packages/providers/
COPY packages/runner/ packages/runner/
RUN bun build --target=bun packages/runner/src/box-agent-main.ts --outfile /out/box-agent.js

FROM ${NODE_IMAGE} AS fetch-base
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl
WORKDIR /tmp/fetch

FROM fetch-base AS fetch
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG TARGETARCH
ARG GH_VERSION=2.105.0
ARG GH_SHA256_AMD64=79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f
ARG GH_SHA256_ARM64=b1278c75107423d818f1937fd92cafc9e5e9b606631568f68d7fb816f5885a02
ARG SUPABASE_VERSION=3.0.0
ARG SUPABASE_SHA256_AMD64=eeb61edcd59a4735fcb5e58596574f25d03d420efca779f43ddb307e1cc5c754
ARG SUPABASE_SHA256_ARM64=243474fb5b491a0df04682fc1941cc5519559a1178ae01c225c633eda2e8acb8
RUN case "${TARGETARCH}" in \
      amd64) gh_sha="${GH_SHA256_AMD64}"; supabase_sha="${SUPABASE_SHA256_AMD64}" ;; \
      arm64) gh_sha="${GH_SHA256_ARM64}"; supabase_sha="${SUPABASE_SHA256_ARM64}" ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSLo gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && echo "${gh_sha}  gh.tar.gz" | sha256sum -c - \
 && curl -fsSLo supabase.tar.gz "https://github.com/supabase/cli/releases/download/v${SUPABASE_VERSION}/supabase_${SUPABASE_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && echo "${supabase_sha}  supabase.tar.gz" | sha256sum -c - \
 && mkdir -p /out/bin \
 && tar -xzf gh.tar.gz -C /out/bin --strip-components=2 "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" \
 && tar -xzf supabase.tar.gz -C /out/bin supabase \
 && chown root:root /out/bin/* && chmod 0755 /out/bin/* \
 && rm -rf /tmp/fetch/*

FROM ${NODE_IMAGE}
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG TARGETARCH
ARG PG_MAJOR=17

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /etc/apt/keyrings/pgdg.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      wget git openssh-client jq ripgrep procps sudo less unzip xz-utils file bubblewrap age acl util-linux \
      python3 \
      ffmpeg poppler-utils xvfb xdotool openbox xterm x11-utils \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 \
      libgtk-3-0 libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libcairo-gobject2 libgdk-pixbuf-2.0-0 \
      libasound2 libfreetype6 libfontconfig1 libxkbcommon0 libxshmfence1 \
      libx11-6 libx11-xcb1 libxcb1 libxcb-shm0 libxext6 libxrandr2 libxcomposite1 libxcursor1 \
      libxdamage1 libxfixes3 libxi6 libxrender1 \
      "postgresql-client-${PG_MAJOR}" \
 && if [ "${TARGETARCH}" = arm64 ]; then apt-get install -y --no-install-recommends chromium; fi

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
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
 && install -d -o app -g app -m 0750 /data \
 && install -d -o root -g rbwork -m 2775 /cache \
 && install -d -o root -g root -m 0755 /etc/rb-sandbox /opt/rbots \
 && install -d -o app -g app -m 0755 /opt/rbots-tools \
 && echo 0 > /etc/rb-sandbox/bwrap \
 && mkdir -p /home/app/.agent-browser/browsers /home/app/.config/gh /home/app/.cache /home/app/.local/share \
      /home/app/.supabase /home/app/.config/.wrangler /home/app/.claude /home/app/.codex \
 && chown -R app:app /home/app \
 && install -d -o runelaytool -g runelaytool -m 0755 /home/runelaytool/.agent-browser /home/runelaytool/.agent-browser/browsers \
 && ln -s /opt/rbots/claude-agent /usr/local/bin/claude \
 && ln -s /usr/local/bin/bun /usr/local/bin/bunx

ARG CODEX_VERSION=0.170.0
ARG AGENT_BROWSER_VERSION=0.27.0
ARG PNPM_VERSION=12.18.0
ARG WRANGLER_VERSION=4.158.0
RUN --mount=type=cache,target=/root/.npm \
    npm install -g --no-audit --no-fund \
      "@openai/codex@${CODEX_VERSION}" \
      "agent-browser@${AGENT_BROWSER_VERSION}" \
      "pnpm@${PNPM_VERSION}" \
      "wrangler@${WRANGLER_VERSION}" \
 && native="$(readlink -f /usr/local/bin/agent-browser)" \
 && find /usr/local/lib/node_modules/agent-browser/bin -type f -name 'agent-browser-*' ! -path "${native}" -delete

ARG INSTALL_CURSOR=0
ARG GROK_NPM_PACKAGE=
ARG GROK_VERSION=
RUN --mount=type=cache,target=/root/.npm \
    if [ -n "${GROK_NPM_PACKAGE}" ]; then \
      [ -n "${GROK_VERSION}" ] || { echo "GROK_NPM_PACKAGE needs GROK_VERSION" >&2; exit 1; }; \
      npm install -g --no-audit --no-fund "${GROK_NPM_PACKAGE}@${GROK_VERSION}"; \
    fi \
 && if [ "${INSTALL_CURSOR}" = 1 ]; then \
      curl -fsSL https://cursor.com/install -o /tmp/cursor-install.sh \
      && HOME=/home/app su app -c "bash /tmp/cursor-install.sh" \
      && ln -sf /home/app/.local/bin/cursor-agent /usr/local/bin/cursor-agent \
      && rm /tmp/cursor-install.sh; \
    fi

COPY --from=fetch /out/bin/ /usr/local/bin/
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

ARG CHROME_VERSION=158.0.8127.36
RUN for dir in /etc/chromium/policies/managed /etc/opt/chrome/policies/managed /etc/opt/chrome_for_testing/policies/managed; do \
      install -d -o root -g root -m 0755 "$dir" \
      && printf '%s\n' \
           '{' \
           '  "URLBlocklist": ["file://*", "chrome://*", "view-source:*", "devtools://*", "chrome-extension://*"],' \
           '  "URLAllowlist": [],' \
           '  "DownloadRestrictions": 3' \
           '}' > "$dir/runelay.json" \
      && chmod 0644 "$dir/runelay.json"; \
    done \
 && chrome_dir=/opt/rbots-tools/chrome/current \
 && if [ "${TARGETARCH}" = arm64 ]; then \
      chrome_dir=/opt/rbots/chromium \
      && install -d -m 0755 "$chrome_dir" \
      && ln -s /usr/bin/chromium "$chrome_dir/chrome"; \
    fi \
 && for home in /home/app /home/runelaytool; do \
      ln -s "$chrome_dir" "$home/.agent-browser/browsers/chrome-${CHROME_VERSION}"; \
    done

COPY --from=sdk /out/claude-agent /opt/rbots/claude-agent
COPY --from=sdk /out/native/ /app/apps/server/native/

COPY --chmod=0755 apps/server/docker-entrypoint.sh /usr/local/bin/runelay-entrypoint
COPY --chmod=0755 apps/server/rb-sandbox-exec.sh /usr/local/bin/rb-sandbox-exec
COPY --chmod=0755 packages/runner/box/rbbox-init /usr/local/bin/rbbox-init

ENV HOME=/home/app \
    USER=app \
    LANG=C.UTF-8 \
    DISABLE_AUTOUPDATER=1 \
    BOTS_APP_DIR=/app/apps/server \
    BOTS_TOOL_SANDBOX=uid \
    CLAUDE_CODE_EXECUTABLE=/opt/rbots/claude-agent \
    NAPI_RS_NATIVE_LIBRARY_PATH=/app/apps/server/native/anydoc.node

WORKDIR /app/apps/server
COPY --from=server-build /out/bin/ /app/apps/server/bin/
COPY --from=box-agent-build --chmod=0644 /out/box-agent.js /opt/rbots/box-agent.js
COPY --from=runner-build /out/rbots-runner /usr/local/bin/rbots-runner
COPY --from=runner-build /out/runner/ /opt/rbots/runner/
COPY --from=server-build /out/app/ /app/apps/server/

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["sh", "-c", "curl -fsS -o /dev/null \"http://127.0.0.1:${GATEWAY_PORT:-2000}/health\" || exit 1"]

ARG RBOTS_VERSION=dev
ARG RBOTS_PROVIDERS=claude,codex
ENV RBOTS_VERSION=$RBOTS_VERSION
LABEL org.opencontainers.image.title="r-bots" \
      org.opencontainers.image.description="r/bots self-hosted: server, runner and per-bot box in one image" \
      org.opencontainers.image.source="https://github.com/runelay/r-bots" \
      org.opencontainers.image.vendor="runelay" \
      org.opencontainers.image.version="${RBOTS_VERSION}" \
      rbots.providers="${RBOTS_PROVIDERS}"

ENTRYPOINT ["/usr/local/bin/runelay-entrypoint"]
CMD ["./runelay-bots-server"]
