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

export type Tab = 'recipes' | 'drops' | 'about' | 'sdk'

/** Screen order. Recipes is first because it is what the page is for. */
export const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'recipes', label: 'Recipes' },
  { id: 'drops', label: 'Drops' },
  { id: 'about', label: 'About' },
  { id: 'sdk', label: 'SDK' },
]

export interface Route {
  tab: Tab
  /** The recipe the URL carries, or null. Only ever non-null on `recipes`. */
  recipe: DropRecipeJson | null
}

const TABS_BY_ID: Record<string, Tab> = {
  recipes: 'recipes',
  drops: 'drops',
  about: 'about',
  sdk: 'sdk',
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

  // Only the Recipes tab reads a payload. The others carry none by decision, so a second segment on
  // them is ignored rather than decoded.
  return { tab, recipe: tab === 'recipes' && rest ? recipeFromHash(rest) : null }
}

/**
 * The inverse. Always includes the leading `#`, so the result can be compared against
 * `location.hash` directly — which is how the writer avoids rewriting an unchanged fragment.
 *
 * Never emits a recipe for a tab other than Recipes. That is the invariant behind `Route.recipe`
 * being documented as "only on recipes", and the reason switching tabs drops the payload from the URL.
 */
export function routeHash(route: { tab: Tab; recipe?: DropRecipeJson | null }): string {
  if (route.tab === 'recipes' && route.recipe) return `#/recipes/${recipeToHash(route.recipe)}`
  return `#/${route.tab}`
}
