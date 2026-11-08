import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Address } from 'viem'
import { useCallback, useEffect, useState } from 'react'

import { ActivityLog } from './components/ActivityLog.js'
import { BetaNotice } from './components/BetaNotice.js'
import { DropBadge } from './components/DropBadge.js'
import { BuildInfo } from './components/BuildInfo.js'
import { TOAST_MS, Toasts } from './components/Toasts.js'
import type { ActivityEntry } from './lib/activity.js'
import { useFillTracker, useKeeperActivity } from './lib/keeperStream.js'
import {
  DEFAULT_CHAIN_ID,
  connect,
  disconnect,
  isUserRejection,
  onAccountsChanged,
  readAccount,
} from './lib/chain.js'
import { watchModalAccount } from './lib/wallet.js'
import { TABS, parseRoute, routeHash } from './lib/route.js'
import { saveDrop } from './lib/storage.js'
import { useExternalRoute, useRoute, writeHash } from './lib/useRoute.js'
import { AboutTab } from './tabs/AboutTab.js'
import { BridgeTab } from './tabs/BridgeTab.js'
import { DropsTab } from './tabs/DropsTab.js'
import { RecipesTab } from './tabs/RecipesTab.js'
import { ShareTab } from './tabs/ShareTab.js'
import { SdkTab } from './tabs/SdkTab.js'

/**
 * The shell: the error banner, the beta notice, the header and wallet, the tab bar. Nothing about
 * recipes.
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

  /** Keeper activity for this browser's drops, raised as toasts; the history lives in the Drops tab. */
  const [toasts, setToasts] = useState<ActivityEntry[]>([])
  const dismissToast = useCallback((id: string) => setToasts((current) => current.filter((t) => t.id !== id)), [])
  const showToast = useCallback(
    (entry: ActivityEntry) => {
      setToasts((current) => [...current.slice(-4), entry])
      if (entry.tone !== 'error') setTimeout(() => dismissToast(entry.id), TOAST_MS)
    },
    [dismissToast],
  )
  useKeeperActivity({ account, revision: dropsRevision, onNew: showToast })
  useFillTracker(showToast)
  /**
   * The recipe handed to the Bridge tab, which builds none of its own.
   *
   * Separate from `imported`, which flows the other way — Drops and the URL hand a recipe *to* the
   * builder, while this is the builder handing a finished one *on*. Sharing one slot would make
   * "fund this by bridging" overwrite the form it came from.
   *
   * Seeded from the URL for the same reason `imported` is: the recipe is the only way back to a
   * funded address, so a refresh half-way through a bridge must not lose which drop was being funded.
   */
  const [bridgeRecipe, setBridgeRecipe] = useState<DropRecipeJson | null>(() => {
    const initial = parseRoute(window.location.hash)
    return initial.tab === 'bridge' ? initial.recipe : null
  })
  /** Mirrors of builder state: the chain to connect on, and the drop the builder resolves to. */
  const [connectChainId, setConnectChainId] = useState(DEFAULT_CHAIN_ID)
  /**
   * The drop on the bench, shown in the header and marked in the Drops list.
   *
   * The recipe rides along with the address because the header's Share link *is* the recipe — an
   * address on its own is a page nobody can do anything with.
   */
  const [drop, setDrop] = useState<{ address: Address; recipe: DropRecipeJson } | null>(null)

  /**
   * Follow the wallet's account, so locking it does not leave a stale one on screen.
   *
   * Two sources, because there are two kinds of session. The injected provider announces its own
   * `accountsChanged`; a wallet connected through AppKit's modal is a different provider that this
   * one never hears from, and disconnecting from inside the modal has to reach the page too.
   */
  useEffect(() => onAccountsChanged(setAccount), [])
  useEffect(() => watchModalAccount(setAccount), [])

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
    if (!next.recipe) return
    // A `#/bridge/<recipe>` link is about the drop being funded, not about the form. It still reaches
    // the builder as well, so "Change it" on the Bridge tab lands on the recipe you were funding
    // rather than on an empty form.
    if (next.tab === 'bridge') setBridgeRecipe(next.recipe)
    setImported(next.recipe)
  })

  /**
   * Mirror the bridge recipe into the fragment, the same way the builder mirrors its own.
   *
   * Gated on the tab being on screen so it cannot rewrite another tab's fragment, and `replace` so it
   * does not fill the back button. This is also what re-attaches the recipe after a bare `#/bridge`
   * from the nav link, which carries no payload.
   */
  useEffect(() => {
    if (route.tab !== 'bridge') return
    writeHash(routeHash({ tab: 'bridge', recipe: bridgeRecipe }), 'replace')
  }, [route.tab, bridgeRecipe])

  const [connecting, setConnecting] = useState(false)

  const onConnect = async () => {
    setError(null)
    setConnecting(true)
    try {
      // The chain the user is looking at, not the default: connecting on the default and then letting
      // the wallet's `chainChanged` drag the page back would silently discard their network choice.
      setAccount(await connect(connectChainId))
    } catch (cause) {
      // Closing the modal is a decision, not a failure. Reporting it as an error banner would put a
      // red box on the page for choosing not to connect.
      if (!isUserRejection(cause)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setConnecting(false)
    }
  }

  const onDisconnect = async () => {
    setError(null)
    await disconnect()
    setAccount(null)
  }

  /*
   * The share card gets its own shell, and returns before the one below.
   *
   * Everything the normal shell provides — the wallet button, the tab bar, the heading and tagline —
   * is chrome belonging to someone who is *building* a drop. This page is read by someone who was
   * sent a link, often on a phone, and is frequently on a screen being shown across a room. So the
   * page is the card: one wordmark back into the app, and nothing else competing with the QR.
   *
   * It also keeps the builder from mounting at all on this route. Hidden, it is merely idle; absent,
   * it cannot put ~30 form controls in front of a reader who never asked for them.
   *
   * The beta notice stays. It is the one piece of chrome that earns its place on the most public
   * surface in the app, and dropping it from exactly the page strangers see would be the wrong way
   * round.
   */
  if (route.tab === 'share') {
    return (
      <>
        <BetaNotice />
        <main className="share-main">
          <a className="share-brand" href={routeHash({ tab: 'recipes' })}>
            <img src="/logo.png" alt="" width={44} height={44} />
            <span>cow-drop</span>
          </a>
          <ShareTab recipe={route.recipe} />
          <BuildInfo />
        </main>
        <Toasts toasts={toasts} onDismiss={dismissToast} />
      </>
    )
  }

  return (
    <>
      {/*
        Ahead of `main`, and so ahead of the error banner too: it is full-bleed, and the page column
        would otherwise clip it. Said once, in the shell, so it is on screen whichever tab the URL
        opens on rather than only on About — the one tab nobody funding a drop has to visit.
      */}
      <BetaNotice />

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
                Drop tokens into an address, triggering your predefined intent permissionlessly.
              </p>
            </div>
          </div>
          {/*
            The drop on the bench, kept in reach.

            Only on the builder's own tab: on Drops or Bridge it would be describing something the
            page in front of you is not about, and the Drops list already carries a Share per row.
          */}
          {drop && route.tab === 'recipes' && (
            <DropBadge
              recipe={drop.recipe}
              address={drop.address}
              revision={dropsRevision}
              onRemember={() => {
                saveDrop({ address: drop.address, recipe: drop.recipe })
                /*
                 * Announce it, or nothing re-reads. Saving from here is a real save — the same one
                 * the Drops tab lists and the switcher above offers — and without this the drop you
                 * just copied stayed absent from both until something else happened to bump them.
                 */
                setDropsRevision((n) => n + 1)
              }}
              onLoad={(next) => {
                setImported(next)
                setError(null)
              }}
              onViewAll={() => navigate('drops')}
            />
          )}

          {/*
            Centred under the name rather than parked at the edge, and the one filled button on the
            page. It is the only thing here anybody has to do before a drop can be activated, and it
            used to read as a utility control in the corner.
          */}
          <div className="wallet">
            {account ? (
              <>
                <span className="pill">{account}</span>
                {/*
                  Shown for both kinds of session, not just the modal's. An injected wallet has no
                  session to end, but the page can hand back the permission it was granted — and
                  either way there has to be a way out of a connected state the user did not want.
                */}
                <button className="link" onClick={() => void onDisconnect()}>
                  Disconnect
                </button>
              </>
            ) : (
              <button className="connect" onClick={() => void onConnect()} disabled={connecting}>
                {connecting ? 'Connecting…' : 'Connect wallet'}
              </button>
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
            onAddressChanged={setDrop}
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
        {/* Its own tab now: a feed of what happened, rather than a panel under the catalogue. */}
        {route.tab === 'activity' && <ActivityLog />}
        {route.tab === 'drops' && (
          <DropsTab
            account={account}
            revision={dropsRevision}
            currentAddress={drop?.address ?? null}
            onLoad={(recipe) => {
              setImported(recipe)
              setError(null)
              navigate('recipes')
            }}
          />
        )}
        {route.tab === 'about' && <AboutTab />}
        {route.tab === 'sdk' && <SdkTab />}
        <BuildInfo />
      </main>
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </>
  )
}
