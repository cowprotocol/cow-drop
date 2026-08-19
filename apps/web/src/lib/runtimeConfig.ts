/**
 * Deployment configuration, resolved at container start rather than at build time.
 *
 * Vite inlines `import.meta.env.VITE_*` into the bundle, which is right for `pnpm dev` and wrong for
 * a published image: baking the keeper URL in would mean one image per environment, and an artifact
 * that cannot be promoted from staging to production is not really a release artifact.
 *
 * So the image ships a `config.js` that is rewritten from the environment every time the container
 * starts (see `apps/web/docker-entrypoint.d/10-runtime-config.sh`), setting
 * `window.__COW_DROP_CONFIG__`. That wins when it carries a value; otherwise the `VITE_*` build-time
 * values still apply, so `pnpm dev` and a plain `vite build` behave exactly as they did before.
 *
 * Both settings stay optional in both layers. No keeper URL anywhere means the page runs without a
 * keeper — see `keeperUrl()` in `./keeper.ts`.
 */

declare global {
  interface Window {
    __COW_DROP_CONFIG__?: {
      keeperUrl?: string
      rpcUrl?: string
    }
  }
}

/** A configured string, or undefined. Blank is "unset": the entrypoint emits "" for absent vars. */
function clean(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** The keeper this deployment talks to, unnormalised. Runtime first, then the build-time value. */
export function configuredKeeperUrl(): string | undefined {
  return clean(globalThis.window?.__COW_DROP_CONFIG__?.keeperUrl) ?? clean(import.meta.env.VITE_KEEPER_URL)
}

/** The RPC override for the default chain, if this deployment sets one. */
export function configuredRpcUrl(): string | undefined {
  return clean(globalThis.window?.__COW_DROP_CONFIG__?.rpcUrl) ?? clean(import.meta.env.VITE_RPC_URL)
}
