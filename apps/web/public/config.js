// Runtime configuration, overwritten at container start from the environment — see
// apps/web/docker-entrypoint.d/10-runtime-config.sh. Empty here on purpose: `pnpm dev` and a plain
// `vite build` fall through to the VITE_* build-time values instead. See src/lib/runtimeConfig.ts.
window.__COW_DROP_CONFIG__ = {}
