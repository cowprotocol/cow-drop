import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'

import { recipeFromHash, recipeToHash } from './storage.js'

/**
 * Which tab the fragment selects, and the recipe it carries.
 *
 * The fragment was already carrying the recipe before there were tabs — see `storage.ts` — and it
 * never reaches a server, so the tab rides the same private channel for free: no server rewrite, no
 * deploy-path assumption, and no router dependency in an app that deliberately has none.
 *
 * Pure on purpose. Every decision about what a fragment means lives here and can be reasoned about
 * without a browser; `useRoute.ts` owns the reading and writing.
 */

export type Tab = 'recipes' | 'activity' | 'bridge' | 'drops' | 'about' | 'sdk' | 'share'

/**
 * Screen order in the tab bar.
 *
 * Recipes is first because it is what the page is for. **`share` is deliberately absent**: it is a
 * destination, not a section — somewhere a link lands, never somewhere you navigate to from the nav.
 * Listing it would also put a tab on screen that is blank without a recipe.
 */
export const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'recipes', label: 'Recipes' },
  /*
   * Second, and its own tab rather than a panel on Drops.
   *
   * It answers a different question from the list beside it. Drops is a catalogue — what exists, and
   * what can I do with it. Activity is a feed — what has happened since I last looked, which is the
   * thing you come back for and the thing nothing else on the page tells you. Buried under Drops it
   * was below four other panels and nobody opening the app would find it.
   */
  { id: 'activity', label: 'Activity' },
  { id: 'drops', label: 'Drops' },
  { id: 'bridge', label: 'Bridge to Drop' },
  { id: 'about', label: 'About' },
  { id: 'sdk', label: 'SDK' },
]

export interface Route {
  tab: Tab
  /** The recipe the URL carries, or null. Only ever non-null on a tab in `RECIPE_TABS`. */
  recipe: DropRecipeJson | null
}

/**
 * The tabs whose fragment carries a recipe.
 *
 * Both of them work on one, and neither can reconstruct it from anywhere else — the recipe is the
 * key, not a convenience, and a drop funded against a recipe nobody kept is unrecoverable. So the
 * Bridge tab has to survive a refresh exactly as the builder does, and the fragment it already shares
 * is the obvious place. `share` carries one for the same reason and more bluntly: the recipe is the
 * entire content of that page, so a share link without it is a blank card.
 *
 * Activity, Drops, About and SDK carry none because they need none.
 */
const RECIPE_TABS: ReadonlySet<Tab> = new Set<Tab>(['recipes', 'bridge', 'share'])

const TABS_BY_ID: Record<string, Tab> = {
  recipes: 'recipes',
  activity: 'activity',
  bridge: 'bridge',
  drops: 'drops',
  about: 'about',
  sdk: 'sdk',
  share: 'share',
}

/**
 * A fragment to a tab and, on the Recipes tab, the recipe it holds.
 *
 * Never throws and never returns null: an unreadable fragment lands on the default tab with an empty
 * form rather than on a blank page, because that is the only failure a user can act on.
 *
 * The scheme:
 *
 * | fragment | means |
 * |---|---|
 * | `#/recipes/<base64url>` | the builder, carrying a recipe |
 * | `#/recipes` | the builder, nothing in the URL yet |
 * | `#/bridge/<base64url>` | the bridge tab, carrying the recipe being funded |
 * | `#/share/<base64url>` | the share card for that recipe — the link you hand someone |
 * | `#/drops`, `#/about`, `#/sdk` | those tabs, which never carry a recipe |
 * | `#<base64url>` | **legacy** — every link shared before there were tabs |
 * | anything else | the builder, empty |
 *
 * A leading `/` is what tells a route from a recipe, and it is unambiguous rather than a heuristic:
 * `recipeToHash` maps `/` to `_` and `+` to `-`, so the payload alphabet is exactly `[A-Za-z0-9_-]`
 * and **every `/` in a fragment is structural**. That invariant is what makes old links free to keep
 * working instead of a compatibility layer to maintain. (Every legacy hash also happens to begin
 * `eyJ`, since the JSON always starts `{"` — a second guarantee this deliberately does not lean on.)
 */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '').trim()
  if (raw === '') return { tab: 'recipes', recipe: null }

  // Not a route, so it is a fragment from before the tabs existed: the whole thing is the recipe.
  if (!raw.startsWith('/')) return { tab: 'recipes', recipe: recipeFromHash(raw) }

  const cut = raw.indexOf('/', 1)
  const head = cut === -1 ? raw.slice(1) : raw.slice(1, cut)
  const rest = cut === -1 ? '' : raw.slice(cut + 1)

  const tab = TABS_BY_ID[head]
  // An unknown tab is the default one rather than a 404: there is nothing useful to say about a
  // fragment somebody mistyped, and a blank page says it worse.
  if (!tab) return { tab: 'recipes', recipe: null }

  // The other tabs carry no payload by decision, so a second segment on them is ignored rather than
  // decoded.
  return { tab, recipe: RECIPE_TABS.has(tab) && rest ? recipeFromHash(rest) : null }
}

/**
 * The inverse. Always includes the leading `#`, so the result can be compared against
 * `location.hash` directly — which is how the writer avoids rewriting an unchanged fragment.
 *
 * Never emits a recipe for a tab that does not carry one. That is the invariant behind
 * `Route.recipe`, and the reason switching to Drops drops the payload from the URL.
 */
export function routeHash(route: { tab: Tab; recipe?: DropRecipeJson | null }): string {
  if (RECIPE_TABS.has(route.tab) && route.recipe) return `#/${route.tab}/${recipeToHash(route.recipe)}`
  return `#/${route.tab}`
}
