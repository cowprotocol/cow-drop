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
      /**
       * Keepers by chain id, for a deployment that watches more than one.
       *
       * Either an object, or the `100=https://…,1=https://…` string the container entrypoint can
       * build from a single environment variable.
       */
      keeperUrls?: Record<string, string> | string
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

/**
 * The keepers this deployment talks to, by chain id.
 *
 * Bridging is what makes this necessary: a drop being funded across a bridge lives on the
 * *destination* chain, and it has to be registered with the keeper watching that chain — the one the
 * page is connected to is the source. A keeper rejects a recipe for a chain it does not watch, so
 * getting this wrong is loud rather than silent, but it is still a registration that did not happen.
 *
 * Unparseable entries are skipped rather than thrown: a malformed keeper URL should cost that one
 * chain its keeper, not blank the page.
 */
export function configuredKeeperUrls(): Record<number, string> {
  const raw = globalThis.window?.__COW_DROP_CONFIG__?.keeperUrls ?? import.meta.env.VITE_KEEPER_URLS

  const entries: Array<[string, string]> =
    typeof raw === 'string' ? parsePairs(raw) : raw && typeof raw === 'object' ? Object.entries(raw) : []

  const urls: Record<number, string> = {}
  for (const [key, value] of entries) {
    const chainId = Number(key)
    const url = clean(value)
    if (!Number.isInteger(chainId) || chainId <= 0 || url === undefined) continue
    urls[chainId] = url
  }
  return urls
}

/** `100=https://a,1=https://b` — the shape a single environment variable can carry. */
function parsePairs(raw: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const part of raw.split(',')) {
    // Split on the first `=` only: a URL may contain one in a query string.
    const at = part.indexOf('=')
    if (at === -1) continue
    pairs.push([part.slice(0, at).trim(), part.slice(at + 1).trim()])
  }
  return pairs
}

/** The RPC override for the default chain, if this deployment sets one. */
export function configuredRpcUrl(): string | undefined {
  return clean(globalThis.window?.__COW_DROP_CONFIG__?.rpcUrl) ?? clean(import.meta.env.VITE_RPC_URL)
}
