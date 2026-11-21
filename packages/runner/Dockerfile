# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a

ARG DOCKER_GID=999

WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/providers/package.json packages/providers/
COPY packages/runner/package.json packages/runner/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production --filter @runelay-bots/runner

COPY packages/protocol/ packages/protocol/
COPY packages/providers/ packages/providers/
COPY packages/runner/ packages/runner/

RUN group="$(awk -F: -v gid="${DOCKER_GID}" '$3 == gid { print $1 }' /etc/group)" \
 && if [ -z "${group}" ]; then addgroup -g "${DOCKER_GID}" docker && group=docker; fi \
 && addgroup bun "${group}"

ENV NODE_ENV=production \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ARG RBOTS_VERSION=dev
ENV RBOTS_VERSION=$RBOTS_VERSION
USER bun
CMD ["bun", "/app/packages/runner/src/main.ts"]
