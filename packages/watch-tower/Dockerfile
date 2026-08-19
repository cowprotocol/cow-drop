# The watch tower: posts the orders drops place on-chain to the order book. No key, nothing
# privileged, so this image needs no secrets — only an RPC endpoint.
#
# Build context is the repo root, because the watch tower depends on the SDK through the workspace:
#   docker build -f packages/watch-tower/Dockerfile .
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Pinned to the native platform so `pnpm install` does not run under QEMU emulation on the arm64 leg
# of the multi-arch build. Everything produced here is plain JavaScript, so it is arch-independent.
FROM --platform=$BUILDPLATFORM base AS build
ENV CI=true
WORKDIR /app

# Manifests first, so the install layer is cached until a dependency actually changes. Every
# workspace member has to be present or the lockfile no longer matches the workspace and
# --frozen-lockfile fails, even for members this image does not build.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/watch-tower/package.json packages/watch-tower/
COPY packages/keeper/package.json packages/keeper/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# `packages/sdk/src/generated/` is committed, so no foundry toolchain is needed to build the SDK
# here. CI is what guarantees the committed copy matches the contracts.
COPY packages/sdk/ packages/sdk/
COPY packages/watch-tower/ packages/watch-tower/
RUN pnpm --filter @cowprotocol/cow-drop-sdk build && \
    pnpm --filter @cowprotocol/cow-drop-watch-tower build

# --legacy: pnpm v10 wants inject-workspace-packages=true for deploy, which would change how
# workspace deps are linked during development. --legacy skips that without touching the workspace.
RUN pnpm deploy --filter @cowprotocol/cow-drop-watch-tower --prod --legacy /app/deployed

FROM base AS runtime
RUN groupadd --system app && useradd --system -g app app
WORKDIR /app
COPY --from=build --chown=app:app /app/deployed ./

# The block cursor lives here. Losing it is recoverable — the tower restarts from the head, at the
# cost of not posting whatever was placed while it was down — but a volume makes restarts seamless.
RUN mkdir -p /data && chown app:app /data
VOLUME /data
USER app

ARG COMMIT_HASH=unknown
ENV NODE_ENV=production
ENV COMMIT_HASH=$COMMIT_HASH

# --rpc-url is deliberately not defaulted: it comes from $RPC_URL, and there is no sane fallback.
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--state", "/data/cursor.json"]
