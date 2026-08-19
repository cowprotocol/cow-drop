import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Address } from 'viem'
import { useEffect, useState } from 'react'

import { DEFAULT_CHAIN_ID, connect, onAccountsChanged, readAccount } from './lib/chain.js'
import { TABS, parseRoute, routeHash } from './lib/route.js'
import { useExternalRoute, useRoute } from './lib/useRoute.js'
import { AboutTab } from './tabs/AboutTab.js'
import { BridgeTab } from './tabs/BridgeTab.js'
import { DropsTab } from './tabs/DropsTab.js'
import { RecipesTab } from './tabs/RecipesTab.js'
import { SdkTab } from './tabs/SdkTab.js'

/**
 * The shell: the error banner, the header and wallet, the tab bar. Nothing about recipes.
 *
 * It owns only what is genuinely shared across tabs — the connected account, the page-level error, the
 * recipe handed between Drops and Recipes, and which tab the URL selects. Everything else lives in the
 * tab that uses it.
 */
export function App() {
  const { route, navigate } = useRoute()
  const [account, setAccount] = useState<Address | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * The recipe the URL carried on load, or the one the Drops tab handed over.
   *
   * **This must stay a lazy initialiser, read during render.** React flushes effects child-first, so
   * moving it into a `useEffect` would let the builder's URL mirror run first, see no recipe, and
   * `replaceState` the default form over a recipe someone shared — irrecoverably, since replace leaves
   * nothing for Back to return to and the payload is gone from the address bar before it can be copied.
   */
  const [imported, setImported] = useState<DropRecipeJson | null>(
    () => parseRoute(window.location.hash).recipe,
  )
  /**
   * Bumped whenever a drop is written, so both consumers re-read.
   *
   * Two of them, which is why it lives up here: the Drops tab re-reads `localStorage`, *and* the
   * builder's keeper check depends on it — pressing "Hand to keeper" is what fetches the answer that
   * then disables the button.
   */
  const [dropsRevision, setDropsRevision] = useState(0)
  /**
   * The recipe handed to the Bridge tab, which builds none of its own.
   *
   * Separate from `imported`, which flows the other way — Drops and the URL hand a recipe *to* the
   * builder, while this is the builder handing a finished one *on*. Sharing one slot would make
   * "fund this by bridging" overwrite the form it came from.
   */
  const [bridgeRecipe, setBridgeRecipe] = useState<DropRecipeJson | null>(null)
  /** Mirrors of builder state: the chain to connect on, and the address the Drops list marks. */
  const [connectChainId, setConnectChainId] = useState(DEFAULT_CHAIN_ID)
  const [dropAddress, setDropAddress] = useState<Address | null>(null)

  /** Follow the wallet's account, so locking it does not leave a stale one on screen. */
  useEffect(() => onAccountsChanged(setAccount), [])

  /**
   * Restore an already-authorised account on load, without prompting.
   *
   * The page read the wallet's chain on mount but never its account, so after a reload it looked
   * connected while `account` was null — and the only thing that depended on it, the activate button,
   * silently greyed out. `eth_accounts` answers from the permission the wallet already holds.
   */
  useEffect(() => {
    void readAccount().then((connected) => {
      if (connected) setAccount(connected)
    })
  }, [])

  /*
   * A fragment this page did not write: Back, Forward, or a link pasted into an already-open tab,
   * which now loads its recipe rather than needing a reload.
   *
   * Only ever *sets*, never clears. Clicking the already-active Recipes link, or Back onto a bare
   * `#/recipes`, yields no recipe — and clearing on that would wipe a form the user is halfway through.
   */
  useExternalRoute((next) => {
    if (next.recipe) setImported(next.recipe)
  })

  const onConnect = async () => {
    setError(null)
    try {
      // The chain the user is looking at, not the default: connecting on the default and then letting
      // the wallet's `chainChanged` drag the page back would silently discard their network choice.
      setAccount(await connect(connectChainId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <main>
      {/*
        Top level on purpose. This used to live inside the status section, which meant any gate that
        hid that section also swallowed every error it was supposed to explain.
      */}
      {error && (
        <p className="error banner" role="alert">
          {error}
        </p>
      )}

      <header>
        <div className="brand">
          {/* Served from public/ rather than imported, so index.html's icon tags point at the same set. */}
          <img src="/logo.png" alt="" width={96} height={96} className="brand-mark" />
          <div>
            <h1>cow-drop</h1>
            <p className="tagline">
              Drop your tokens into an address and the cow does the rest. The recipe is committed
              into the address itself, so anyone can trigger it and nobody has to sign anything.
            </p>
          </div>
        </div>
        <div className="wallet">
          {account ? (
            <span className="pill">{account}</span>
          ) : (
            <button onClick={onConnect}>Connect wallet</button>
          )}
        </div>
      </header>

      {/*
        Links rather than an ARIA tablist, because these really are pages: they change the URL, Back
        moves between them, and About and SDK are worth sending to someone. That also leaves the
        keyboard model the platform's instead of a roving tabindex reimplemented by hand — and it means
        a tab click needs no JavaScript at all, since the browser's own hash write is what we listen to.
      */}
      <nav className="tab-nav" aria-label="Sections">
        {TABS.map((tab) => (
          <a
            key={tab.id}
            href={routeHash({ tab: tab.id })}
            aria-current={route.tab === tab.id ? 'page' : undefined}
            // Already here: do nothing rather than push an entry the recipe mirror is about to rewrite
            // into a duplicate of the current one, which makes Back look broken.
            onClick={route.tab === tab.id ? (event) => event.preventDefault() : undefined}
          >
            {tab.label}
          </a>
        ))}
      </nav>

      {/*
        The builder stays mounted while another tab shows, so a trip to Drops does not throw away a
        half-filled form — `#/drops` carries no recipe, so the URL could not bring it back. It costs
        nothing to keep: nothing in this app polls, so every effect here is dependency-driven and a
        hidden panel is idle. `hidden` is what does the hiding, because it removes the subtree from the
        accessibility tree *and* the tab order; anything less leaves ~30 invisible focusable inputs.
      */}
      <div className="tab-panel" hidden={route.tab !== 'recipes'}>
        <RecipesTab
          active={route.tab === 'recipes'}
          account={account}
          imported={imported}
          setImported={setImported}
          setError={setError}
          dropsRevision={dropsRevision}
          onDropsChanged={() => setDropsRevision((n) => n + 1)}
          onChainSelected={setConnectChainId}
          onAddressChanged={setDropAddress}
          onSeeAll={() => navigate('drops')}
          onBridge={(recipe) => {
            setBridgeRecipe(recipe)
            setError(null)
            navigate('bridge')
          }}
        />
      </div>

      {/* The others unmount, because their state is better fresh — the Drops tab re-reads
          localStorage and re-asks the keeper on every open, which is exactly what you want from it,
          and a bridge quote goes stale within minutes so it should never survive a tab switch. */}
      {route.tab === 'bridge' && (
        <BridgeTab account={account} recipe={bridgeRecipe} onBuildRecipe={() => navigate('recipes')} />
      )}
      {route.tab === 'drops' && (
        <DropsTab
          account={account}
          revision={dropsRevision}
          currentAddress={dropAddress}
          onLoad={(recipe) => {
            setImported(recipe)
            setError(null)
            navigate('recipes')
          }}
        />
      )}
      {route.tab === 'about' && <AboutTab />}
      {route.tab === 'sdk' && <SdkTab />}
    </main>
  )
}
