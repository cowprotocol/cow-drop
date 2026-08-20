# The demo page: a static bundle behind nginx.
#
# No VITE_* build args on purpose. The keeper URL and RPC are read at container start from
# $KEEPER_URL and $RPC_URL and written into /config.js by docker-entrypoint.d/10-runtime-config.sh,
# so one image is promotable across environments instead of being pinned to whichever URL it was
# built against. See apps/web/src/lib/runtimeConfig.ts.
#
# Build context is the repo root, because the page depends on the SDK through the workspace:
#   docker build -f apps/web/Dockerfile .
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Pinned to the native platform so `pnpm install` does not run under QEMU emulation on the arm64 leg
# of the multi-arch build. The output is static assets, so it is arch-independent.
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
COPY packages/bridging/ packages/bridging/
COPY apps/web/ apps/web/

# The `...` suffix builds the page's workspace dependencies first, in topological order. Both of them
# resolve to `dist/`, so naming only the page here would compile against packages that were never
# built — and this way a dependency added later needs no change to the line.
RUN pnpm --filter "@cowprotocol/cow-drop-web..." build

FROM nginx:stable-alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

# nginx's own entrypoint runs every executable /docker-entrypoint.d/*.sh before starting the server,
# which is where the runtime config gets written.
COPY apps/web/docker-entrypoint.d/10-runtime-config.sh /docker-entrypoint.d/10-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/10-runtime-config.sh

ARG COMMIT_HASH=unknown
ENV COMMIT_HASH=$COMMIT_HASH
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
