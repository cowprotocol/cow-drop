# The keeper: watches registered drops, activates them, and pays the gas. It runs a watch tower
# in-process, so do not deploy this alongside the standalone watch-tower image for the same chain.
#
# This one holds a funded hot key. It is read from a file or the environment, never an argument —
# mount a secret at /run/secrets/keeper-key and pass --private-key-file, or set $KEEPER_PRIVATE_KEY.
#
# Build context is the repo root:
#   docker build -f packages/keeper/Dockerfile .
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
COPY packages/bridging/package.json packages/bridging/
COPY packages/watch-tower/package.json packages/watch-tower/
COPY packages/keeper/package.json packages/keeper/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# `packages/sdk/src/generated/` is committed, so no foundry toolchain is needed to build the SDK
# here. CI is what guarantees the committed copy matches the contracts.
COPY packages/sdk/ packages/sdk/
COPY packages/watch-tower/ packages/watch-tower/
COPY packages/keeper/ packages/keeper/
RUN pnpm --filter @cowprotocol/cow-drop-sdk build && \
    pnpm --filter @cowprotocol/cow-drop-watch-tower build && \
    pnpm --filter @cowprotocol/cow-drop-keeper build

# --legacy: pnpm v10 wants inject-workspace-packages=true for deploy, which would change how
# workspace deps are linked during development. --legacy skips that without touching the workspace.
RUN pnpm deploy --filter @cowprotocol/cow-drop-keeper --prod --legacy /app/deployed

FROM base AS runtime
RUN groupadd --system app && useradd --system -g app app
WORKDIR /app
COPY --from=build --chown=app:app /app/deployed ./

# The registry of watched drops and the spend ledger live here, and unlike the watch tower's cursor
# they are not reconstructible from the chain: lose this and the keeper forgets which drops it agreed
# to watch, and forgets how much of today's budget it already spent. Back the volume with real disk.
RUN mkdir -p /data && chown app:app /data
VOLUME /data
USER app

ARG COMMIT_HASH=unknown
ENV NODE_ENV=production
ENV COMMIT_HASH=$COMMIT_HASH

EXPOSE 8787

# --rpc-url is deliberately not defaulted: it comes from $RPC_URL, and there is no sane fallback.
# Override CMD to add --policy (do that before pointing anything public at it), --dry-run, or --env.
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--state", "/data/state.json", "--cursor", "/data/cursor.json"]
