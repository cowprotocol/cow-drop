import {
  compileRecipe,
  getDropChain,
  stopLossOnArrival,
  swapOnArrival,
  twapOnArrival,
  type DropRecipeJson,
} from '@cowprotocol/cow-drop-sdk'
import { formatUnits, isAddress, type Address } from 'viem'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  DEFAULT_CHAIN_ID,
  blockExplorer,
  cowExplorer,
  isUserRejection,
  onChainChanged,
  switchChain,
  walletChainId,
  wrappedNative,
} from '../lib/chain.js'
import { applySlippage, quoteMarketPrice, type MarketQuote } from '../lib/quote.js'
import {
  activateDrop,
  postPlacedOrders,
  forgetChainReadiness,
  probeChainReadiness,
  readDropStatus,
  type DropStatus,
} from '../lib/drop.js'
import { GNOSIS_TOKENS } from '../lib/tokens.js'
import { fetchTokenList, findToken, type TokenInfo } from '../lib/tokenList.js'
import { NetworkPicker } from '../components/NetworkPicker.js'
import { clearSentToKeeper, isSaved, listDrops, markSentToKeeper, saveDrop } from '../lib/storage.js'
import { keeperUrl, readKeeperDrop, registerWithKeeper, unregisterFromKeeper } from '../lib/keeper.js'
import { keeperTooltip } from '../lib/dropList.js'
import { routeHash } from '../lib/route.js'
import { writeHash } from '../lib/useRoute.js'
import { TokenPicker } from '../components/TokenPicker.js'
import { DropAddress } from '../components/DropAddress.js'
import { RecipeJson } from '../components/RecipeJson.js'
import { StepBuilder } from '../components/StepBuilder.js'
import { RescuePanel } from '../components/RescuePanel.js'
import { SavedDrops } from '../components/SavedDrops.js'
import { TerminalPanel } from '../components/TerminalPanel.js'
import { StepTable } from '../components/StepTable.js'

/**
 * Which recipe to build. Named for what the user sees: the SDK calls these templates, because
 * there a template is a function that produces a recipe — a distinction worth keeping in code and
 * not worth making a user learn.
 */
type RecipeKind = 'swap' | 'twap' | 'stoploss'

const PLACEHOLDER_OWNER: Address = '0x0000000000000000000000000000000000000001'

/**
 * Owners that make a drop unrecoverable, which the UI must never hand out an address for.
 *
 * Both rescue paths are `msg.sender == owner` checks, and nothing can transact as either of these:
 * `0x…0001` is the ecrecover precompile, `0x0` is nobody. A drop owned by one of them can only ever
 * run its recipe — no sweep, no hatch, not for anyone. And since the owner also defaults to being the
 * order's receiver, the bought tokens land there too.
 *
 * `compileRecipe` cannot catch this: both are well-formed addresses, indistinguishable at the SDK
 * layer from an owner the user meant. Only the form knows the field was left empty, so only the form
 * can refuse.
 */
const UNUSABLE_OWNERS: ReadonlySet<string> = new Set([
  PLACEHOLDER_OWNER.toLowerCase(),
  '0x0000000000000000000000000000000000000000',
])

interface FormState {
  chainId: number
  recipeKind: RecipeKind
  owner: string
  sellToken: Address
  buyToken: Address
  receiver: string
  limitPrice: string
  validityMinutes: string
  parts: string
  partMinutes: string
  wrapNative: boolean
  /** Guards. Blank means "no guard", which is why they are strings rather than numbers. */
  minAmount: string
  notBefore: string
  notAfter: string
  /** Oracle pricing, for the swap recipe and the stop-loss. */
  useOracle: boolean
  sellOracle: string
  buyOracle: string
  oracleMaxAgeMinutes: string
  oracleHaircutBps: string
  strike: string
  stopLossDays: string
}

const INITIAL: FormState = {
  chainId: DEFAULT_CHAIN_ID,
  recipeKind: 'swap',
  owner: '',
  sellToken: GNOSIS_TOKENS[0]!.address,
  buyToken: GNOSIS_TOKENS[2]!.address,
  receiver: '',
  limitPrice: '0.02',
  validityMinutes: '30',
  parts: '12',
  partMinutes: '60',
  wrapNative: false,
  minAmount: '',
  notBefore: '',
  notAfter: '',
  useOracle: false,
  sellOracle: '',
  buyOracle: '',
  oracleMaxAgeMinutes: '60',
  oracleHaircutBps: '50',
  strike: '',
  stopLossDays: '7',
}

/** A blank guard field means "no guard", not "zero". */
function optionalBigInt(value: string): bigint | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  try {
    const parsed = BigInt(trimmed)
    return parsed > 0n ? parsed : undefined
  } catch {
    return undefined
  }
}

/** A local datetime input to an absolute unix timestamp. */
function optionalTimestamp(value: string): bigint | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : BigInt(Math.floor(ms / 1000))
}

/** Build the recipe JSON from the form. Pure, so the address updates as the user types. */
function toRecipe(form: FormState, tokens: TokenInfo[]): DropRecipeJson {
  const owner = (isAddress(form.owner) ? form.owner : PLACEHOLDER_OWNER) as Address
  const receiver = isAddress(form.receiver) ? (form.receiver as Address) : undefined
  const sellDecimals = findToken(tokens, form.sellToken)?.decimals ?? 18
  const buyDecimals = findToken(tokens, form.buyToken)?.decimals ?? 18
  const limitPrice = { price: form.limitPrice, sellDecimals, buyDecimals }
  const wrapNative = form.wrapNative ? wrappedNative(form.chainId) : undefined

  // Blank guard fields drop out entirely, so an untouched form still compiles to the same address it
  // always did — adding a guard has to be a deliberate act, because it changes the address.
  const guards = {
    minAmount: optionalBigInt(form.minAmount)
      ? optionalBigInt(form.minAmount)! * 10n ** BigInt(sellDecimals)
      : undefined,
    notBefore: optionalTimestamp(form.notBefore),
    notAfter: optionalTimestamp(form.notAfter),
  }

  const oracle =
    form.useOracle && isAddress(form.sellOracle) && isAddress(form.buyOracle)
      ? {
          sellTokenPriceOracle: form.sellOracle as Address,
          buyTokenPriceOracle: form.buyOracle as Address,
          maxAge: Number(form.oracleMaxAgeMinutes) * 60,
          haircutBps: Number(form.oracleHaircutBps),
        }
      : undefined

  if (form.recipeKind === 'stoploss') {
    return stopLossOnArrival({
      chainId: form.chainId,
      owner,
      sellToken: form.sellToken,
      buyToken: form.buyToken,
      receiver,
      limitPrice,
      validitySeconds: Number(form.stopLossDays) * 24 * 3600,
      sellTokenPriceOracle: (isAddress(form.sellOracle) ? form.sellOracle : PLACEHOLDER_OWNER) as Address,
      buyTokenPriceOracle: (isAddress(form.buyOracle) ? form.buyOracle : PLACEHOLDER_OWNER) as Address,
      strike: optionalBigInt(form.strike) ?? 1n,
      maxTimeSinceLastOracleUpdate: Number(form.oracleMaxAgeMinutes) * 60,
      wrapNative,
      ...guards,
    })
  }

  if (form.recipeKind === 'twap') {
    return twapOnArrival({
      chainId: form.chainId,
      owner,
      sellToken: form.sellToken,
      buyToken: form.buyToken,
      receiver,
      parts: Number(form.parts),
      partDuration: Number(form.partMinutes) * 60,
      limitPrice,
      wrapNative,
      ...guards,
    })
  }

  return swapOnArrival({
    chainId: form.chainId,
    owner,
    sellToken: form.sellToken,
    buyToken: form.buyToken,
    receiver,
    validitySeconds: Number(form.validityMinutes) * 60,
    limitPrice,
    wrapNative,
    oracle,
    ...guards,
  })
}

/**
 * The builder: the form, and the recipe it builds.
 *
 * Everything about recipes lives here. The shell above owns only what is genuinely shared — the
 * wallet, the error banner and which tab is showing — so this component is the page it always was,
 * minus its header.
 *
 * Stays mounted while another tab is showing (see `App.tsx`), which is why `active` exists: a panel
 * nobody is looking at must not write the URL.
 */
export function RecipesTab({
  active,
  account,
  imported,
  setImported,
  setError,
  dropsRevision,
  onDropsChanged,
  onChainSelected,
  onAddressChanged,
  onSeeAll,
}: {
  /** Whether this is the tab on screen. */
  active: boolean
  account: Address | null
  /**
   * Set when the JSON panel, the URL fragment, the Drops tab or the step builder supplies a recipe,
   * which then takes precedence over the form. Owned by the shell, because the URL is.
   */
  imported: DropRecipeJson | null
  setImported: (recipe: DropRecipeJson | null) => void
  /** The page-level banner, owned by the shell so no gate on any tab can hide it. */
  setError: (message: string | null) => void
  /** Bumped whenever a drop is written — see the keeper effect below, and the Drops tab. */
  dropsRevision: number
  onDropsChanged: () => void
  /** Reported up for the header's Connect button, which switches the wallet to the selected chain. */
  onChainSelected: (chainId: number) => void
  /** Reported up so the Drops tab can mark which saved drop is the one on screen. */
  onAddressChanged: (address: Address | null) => void
  /** Moves to the Drops tab, for the rows only the keeper knows about. */
  onSeeAll: () => void
}) {
  const [form, setForm] = useState<FormState>(INITIAL)
  const [status, setStatus] = useState<DropStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  /**
   * What the keeper says about the address on screen, or `null` when there is nothing to say.
   *
   * `null` covers three different situations on purpose — no keeper configured, this browser never
   * sent this drop, the answer has not arrived yet — because the button treats them identically:
   * offer to hand it over. Only a definite `watching` changes what it does, and that is the one thing
   * a claim has to be certain about.
   */
  const [keeperWatching, setKeeperWatching] = useState<boolean | null>(null)
  /**
   * Quote state. Deliberately *not* part of FormState: the reference amount exists only to get a
   * price out of the API and must never leak into the recipe, since a drop cannot commit to an amount.
   */
  const [referenceAmount, setReferenceAmount] = useState('100')
  const [quote, setQuote] = useState<MarketQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  /**
   * Beside the button rather than in the top banner. The banner is a screen away from the market-price
   * box on a filled-in form, so a failed quote looked like a button that did nothing at all.
   */
  const [quoteError, setQuoteError] = useState<string | null>(null)
  /** Loaded from CoW's token list; the built-in list is the offline fallback. */
  const [tokens, setTokens] = useState<TokenInfo[]>(GNOSIS_TOKENS)
  const [walletChain, setWalletChain] = useState<number | null>(null)
  /**
   * Which required contracts are missing on the selected chain — `null` while the answer is still
   * being fetched.
   *
   * Separate from `status`, which needs a compiled recipe and a sell token before it will read
   * anything. Readiness has to be known *before* we are willing to render an address, so it cannot
   * depend on the recipe being complete.
   */
  const [chainMissing, setChainMissing] = useState<string[] | null>(null)
  /**
   * Why the readiness probe failed, if it did.
   *
   * Without this an unreachable RPC is indistinguishable from a slow one, and the page sits on
   * "checking…" forever — which it did, because the only error output on the page lived inside a
   * section that this very check was hiding.
   */
  const [probeError, setProbeError] = useState<string | null>(null)
  /** Bumped by the retry button to re-run the probe after clearing its cached answer. */
  const [probeAttempt, setProbeAttempt] = useState(0)
  /**
   * Whether the guards panel is expanded.
   *
   * Collapsed to start: three fields that most drops leave blank, sitting between the parameters and
   * the address. Seeded from the initial form rather than hard-coded shut, so a starting state that
   * *does* carry a guard still shows it — a hidden guard is a hidden reason the address moved.
   */
  const [guardsOpen, setGuardsOpen] = useState(
    () => INITIAL.minAmount !== '' || INITIAL.notBefore !== '' || INITIAL.notAfter !== '',
  )

  const recipe = useMemo(() => imported ?? toRecipe(form, tokens), [imported, form, tokens])

  const compiled = useMemo(() => {
    try {
      return { ok: true as const, value: compileRecipe(recipe) }
    } catch (cause) {
      return { ok: false as const, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [recipe])

  /**
   * The chain the drop actually resolves on.
   *
   * Not always `form.chainId`: an imported recipe carries its own, and it is the recipe that decides
   * where the address lives. Readiness must follow the recipe, or we could vet one chain and show an
   * address for another.
   */
  const dropChainId = compiled.ok ? compiled.value.deployment.chainId : form.chainId
  const chainName = getDropChain(dropChainId)?.name ?? `chain ${dropChainId}`

  /**
   * Whether the recipe's owner is one nobody can act as.
   *
   * Read off the *recipe*, not the form, so an imported file is checked too — this is exactly how the
   * first bad recipe would come back if it were re-opened.
   */
  const ownerUnusable = UNUSABLE_OWNERS.has(recipe.owner.toLowerCase())
  /**
   * A stop-loss cannot be priced without both feeds, and the form has nothing sensible to fall back on
   * — so this is the same situation as an empty owner: withhold the address and say what is missing,
   * rather than surfacing whatever the SDK threw.
   */
  const feedsMissing =
    form.recipeKind === 'stoploss' && !(isAddress(form.sellOracle) && isAddress(form.buyOracle))

  /** Counted for the collapsed summary, so a set guard is never silently folded away. */
  const guardsSet = [form.minAmount, form.notBefore, form.notAfter].filter((value) => value !== '').length

  /**
   * What is wrong with the owner *field*, as opposed to with the recipe.
   *
   * The section-3 gate is the backstop that stops the money moving; this is the part that says which
   * input caused it. Reported against `form.owner` rather than the recipe, because an imported recipe
   * does not come from this field and blaming it would be wrong.
   */
  const ownerError = imported
    ? null
    : form.owner.trim() === ''
      ? 'Required. Without it the drop has no owner, and an unowned drop can never be recovered by anyone.'
      : !isAddress(form.owner)
        ? 'Not a valid address.'
        : UNUSABLE_OWNERS.has(form.owner.toLowerCase())
          ? 'Nobody can transact as this address, so a drop owned by it could never be recovered.'
          : null

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setImported(null)
    setForm((previous) => ({ ...previous, [key]: value }))
  }

  /**
   * Change network, and ask the wallet to come along.
   *
   * The selection changes either way: the page is useful without a wallet, since computing an address
   * needs nothing on-chain. A declined prompt is not an error — the mismatch banner already says the
   * wallet is elsewhere — so only real failures surface.
   */
  const onNetworkChange = async (chainId: number) => {
    set('chainId', chainId)
    setError(null)
    if (!account) return

    try {
      await switchChain(chainId)
      setWalletChain(chainId)
    } catch (cause) {
      if (isUserRejection(cause)) return
      setError(`Could not switch the wallet's network: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const refresh = useCallback(async () => {
    if (!compiled.ok) return
    const sellStep = recipe.steps.find((step) => 'sellToken' in step)
    const sellToken = sellStep && 'sellToken' in sellStep ? sellStep.sellToken : undefined
    if (!sellToken) return
    try {
      setStatus(await readDropStatus(compiled.value, sellToken))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [compiled, recipe])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    let cancelled = false
    setChainMissing(null)
    setProbeError(null)
    probeChainReadiness(dropChainId)
      .then((missing) => {
        if (!cancelled) setChainMissing(missing)
      })
      .catch((cause) => {
        if (!cancelled) setProbeError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [dropChainId, probeAttempt])

  const retryProbe = () => {
    forgetChainReadiness(dropChainId)
    setProbeAttempt((attempt) => attempt + 1)
  }

  /**
   * Keep the form in step with an imported recipe.
   *
   * The recipe is mirrored into the URL, so a reload comes back as an import while the form is still
   * at its initial values — which showed an empty owner field next to an address derived from the
   * owner you had set before the reload. Only the fields the form can represent faithfully are
   * hydrated; the rest is why `imported` overrides the form in the first place.
   */
  useEffect(() => {
    if (!imported) return
    setForm((previous) => ({ ...previous, owner: imported.owner, chainId: imported.chainId }))
  }, [imported])

  /*
   * The recipe lives in the URL, so a bookmark, a pasted link or a plain reload is enough to get it
   * back. Replace rather than push, to avoid filling the back button with every keystroke.
   *
   * Gated on this being the tab on screen: the panel stays mounted behind the others, and `#/drops`
   * must not be rewritten by a form nobody is looking at. Returning here re-runs it, which upgrades
   * the pushed `#/recipes` to `#/recipes/<recipe>` in place — one history entry, not two.
   */
  useEffect(() => {
    if (!active) return
    writeHash(routeHash({ tab: 'recipes', recipe }), 'replace')
  }, [recipe, active])

  useEffect(() => {
    if (compiled.ok) setSaved(isSaved(compiled.value.address, form.chainId))
  }, [compiled, form.chainId])

  /**
   * Ask the keeper whether it is watching *this* drop, so the button can stop offering what is done.
   *
   * Gated on the local "we sent it" flag, exactly as the saved list is: the address recompiles on
   * every keystroke, and without the gate this would be a request per character for an address nobody
   * has ever registered. Re-runs on `dropsRevision`, which is bumped by the registration itself — so
   * pressing the button is what fetches the answer that then disables it.
   *
   * Any failure leaves this `null`. A keeper that is down must not be reported as one that is
   * watching, and must not block the retry either.
   */
  useEffect(() => {
    if (!compiled.ok || keeperUrl() === null) {
      setKeeperWatching(null)
      return
    }

    const address = compiled.value.address
    const chainId = compiled.value.deployment.chainId
    const sent = listDrops().some(
      (drop) => drop.chainId === chainId && drop.address.toLowerCase() === address.toLowerCase() && drop.keeper,
    )
    if (!sent) {
      setKeeperWatching(null)
      return
    }

    let cancelled = false
    void readKeeperDrop(address)
      .then((remote) => {
        if (!cancelled) setKeeperWatching(remote?.watching ?? false)
      })
      .catch(() => {
        if (!cancelled) setKeeperWatching(null)
      })

    return () => {
      cancelled = true
    }
  }, [compiled, dropsRevision])

  useEffect(() => {
    const chainId = form.chainId
    let cancelled = false

    void fetchTokenList(chainId).then((loaded) => {
      // Two loads are in flight whenever the chain changes mid-fetch, and the slower one is not the
      // older one: Gnosis pulls four lists where Sepolia pulls one. Without this guard the late answer
      // wins, so the page settled with the network selector on one chain and the token pickers holding
      // another chain's addresses — which is what a page load does, since the initial chain is the
      // default and the wallet's chain arrives a tick later.
      if (cancelled) return

      setTokens(loaded)

      // Token addresses are chain-specific, so the previous chain's selection is meaningless here.
      // Left alone, the picker would read blank while the recipe silently compiled with an address
      // that does not exist on this chain — a valid-looking order for a token that isn't there.
      setForm((previous) => {
        if (loaded.length === 0) return previous

        const known = (address: string) => loaded.some((t) => t.address.toLowerCase() === address.toLowerCase())
        if (known(previous.sellToken) && known(previous.buyToken)) return previous

        const sell = findToken(loaded, wrappedNative(chainId)) ?? loaded[0]!
        const buy = loaded.find((t) => t.address !== sell.address) ?? sell
        return { ...previous, sellToken: sell.address, buyToken: buy.address }
      })
    })

    return () => {
      cancelled = true
    }
  }, [form.chainId])

  /**
   * Default the owner to the connected account, so the user keeps the recovery escape hatch.
   *
   * One effect for what used to be two near-identical branches — the restore-on-load path and the
   * connect-by-hand path were the same rule written twice. `account` now arrives as a prop, so the
   * rule can be stated once: never over an owner already hydrated from a recipe, which is what the
   * `isAddress` guard is for.
   *
   * Declared *after* the `imported` hydrate above, so that if the two ever land in one commit the
   * recipe's owner wins.
   */
  useEffect(() => {
    if (!account) return
    setForm((previous) => (isAddress(previous.owner) ? previous : { ...previous, owner: account }))
  }, [account])

  // Default to whatever network the wallet is already on, when we support it.
  useEffect(() => {
    void walletChainId().then((chain) => {
      setWalletChain(chain)
      if (chain !== null && getDropChain(chain)) {
        setForm((previous) => (previous.chainId === DEFAULT_CHAIN_ID ? { ...previous, chainId: chain } : previous))
      }
    })
  }, [])

  // And keep following it, so switching in the wallet moves the page rather than leaving the two
  // disagreeing. Switching here asks the wallet too, so this closes the loop from both directions.
  useEffect(
    () =>
      onChainChanged((chain) => {
        setWalletChain(chain)
        if (getDropChain(chain)) setForm((previous) => ({ ...previous, chainId: chain }))
      }),
    [],
  )

  /*
   * Two mirrors reported upward. Both are one-way: the shell holds them so the header and the Drops
   * tab can read them, and neither is ever read back here — the form still owns the selection.
   *
   * They exist because `connect()` switches the wallet to the chain the user is looking at, and the
   * Drops list marks which saved drop is the one on screen; both facts are derived down here. The
   * deps are scalars, and the setters are `useState`'s own, so neither effect churns.
   */
  useEffect(() => onChainSelected(form.chainId), [form.chainId, onChainSelected])

  useEffect(
    () => onAddressChanged(compiled.ok ? compiled.value.address : null),
    [compiled, onAddressChanged],
  )

  /**
   * Remember a recipe, since its address is useless without it.
   *
   * Called wherever the next step might plausibly be sending money — copying the address, downloading
   * the file, activating — rather than only on an explicit save, because the failure this prevents is
   * someone funding an address and closing the tab.
   */
  const remember = () => {
    if (!compiled.ok) return
    saveDrop({ address: compiled.value.address, recipe })
    setSaved(true)
    onDropsChanged()
  }

  /**
   * Hand the recipe to the keeper so it activates unattended.
   *
   * Saved locally first, and only flagged as sent once the keeper has answered — a flag written
   * optimistically would claim the drop is watched when the POST failed.
   */
  const onRegisterKeeper = async () => {
    if (!compiled.ok) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      saveDrop({ address: compiled.value.address, recipe })
      const drop = await registerWithKeeper({ recipe, address: compiled.value.address })
      markSentToKeeper({
        address: compiled.value.address,
        chainId: compiled.value.deployment.chainId,
        url: keeperUrl() ?? '',
      })
      setSaved(true)
      onDropsChanged()
      // The keeper's own answer, so the button settles immediately rather than after the re-read that
      // `dropsRevision` triggers.
      setKeeperWatching(drop.watching)
      /*
       * A registration that comes back not-watching is always terminal: the one retired reason that
       * revives — `unregistered` — is resumed by this very call, so anything still retired here cannot be
       * resumed by trying again. Saying *why*, in the same words the drop list uses, is the difference
       * between that and a status code the reader has to go and look up.
       */
      const held = `The keeper holds ${drop.address} but is not watching it (${drop.status}).`
      setMessage(
        drop.watching
          ? `The keeper is watching ${drop.address}`
          : `${held} ${keeperTooltip('held', drop.retiredReason)}`,
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Tell the keeper to stop watching.
   *
   * The recipe is the whole authorisation — the keeper recompiles it and checks it derives the address
   * it is being asked about — so no token has to be stored anywhere for this to work.
   *
   * Nothing on-chain changes and nothing is lost: the drop keeps whatever it holds, activation stays
   * permissionless, and handing the same recipe back resumes the keeper's watch. The only thing given
   * up is the subsidy, which is why this needs no confirmation step.
   *
   * The local flag is cleared only after the keeper agrees. Clearing it first would leave the saved
   * list saying "local only" about a drop still being watched — the one direction of this that is
   * actually misleading, since it is the state that stops the user from asking again.
   */
  const onUnregisterKeeper = async () => {
    if (!compiled.ok) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await unregisterFromKeeper(recipe)
      clearSentToKeeper(compiled.value.address, compiled.value.deployment.chainId)
      setKeeperWatching(false)
      onDropsChanged()
      setMessage(
        `The keeper has stopped watching ${compiled.value.address}. Nothing on-chain changed, and you can hand it back at any time.`,
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const onActivate = async () => {
    if (!account || !compiled.ok) return
    remember()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const { hash, receipt } = await activateDrop({ account, recipe })
      setMessage(`Activated in ${hash}`)

      const posted = await postPlacedOrders(
        receipt,
        compiled.value.address,
        form.chainId,
        compiled.value.deployment.settlement,
      )
      if (posted.length > 0) {
        setMessage(`Activated, and posted ${posted.length} order(s): ${posted.join(', ')}`)
      }
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const sellToken = findToken(tokens, form.sellToken)
  const buyToken = findToken(tokens, form.buyToken)

  const onQuote = async () => {
    setQuoting(true)
    setQuoteError(null)
    setQuote(null)
    try {
      const decimals = sellToken?.decimals ?? 18
      const [whole, fraction = ''] = referenceAmount.trim().split('.')
      const atomic = BigInt(`${whole || '0'}${fraction.padEnd(decimals, '0').slice(0, decimals)}`)
      if (atomic <= 0n) throw new Error('Reference amount must be greater than zero')

      setQuote(
        await quoteMarketPrice({
          sellToken: form.sellToken,
          buyToken: form.buyToken,
          sellAmount: atomic,
          sellDecimals: decimals,
          buyDecimals: buyToken?.decimals ?? 18,
          // The drop is the order's owner, so quote it as the drop.
          from: compiled.ok ? compiled.value.address : PLACEHOLDER_OWNER,
          chainId: form.chainId,
        }),
      )
    } catch (cause) {
      setQuoteError(`Quote failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setQuoting(false)
    }
  }

  // The banner, the header and the saved list all moved up to the shell, so this returns the panels
  // themselves and nothing that frames them.
  return (
    <>
      <SavedDrops
        account={account}
        revision={dropsRevision}
        currentAddress={compiled.ok ? compiled.value.address : null}
        onLoad={(loaded) => {
          setImported(loaded)
          setError(null)
        }}
        onSeeAll={onSeeAll}
      />

      <section>
        <h2>1 &middot; Pick a recipe</h2>
        <div className="tabs">
          <button
            className={form.recipeKind === 'swap' ? 'active' : ''}
            onClick={() => set('recipeKind', 'swap')}
          >
            Swap on arrival
          </button>
          <button
            className={form.recipeKind === 'twap' ? 'active' : ''}
            onClick={() => set('recipeKind', 'twap')}
          >
            TWAP on arrival
          </button>
          <button
            className={form.recipeKind === 'stoploss' ? 'active' : ''}
            onClick={() => set('recipeKind', 'stoploss')}
          >
            Stop-loss on arrival
          </button>
        </div>
        <p className="hint">
          {form.recipeKind === 'swap'
            ? 'Sells whatever lands here once, at your limit price. No watch tower needed, but you post the order to the API after activation.'
            : form.recipeKind === 'twap'
              ? 'Splits whatever lands here into parts and sells them over time. Self-driving: after one activation the watch tower posts each part.'
              : 'Sells whatever lands here once a price feed pair crosses your strike. Self-driving: the watch tower polls the condition, so nobody has to be watching.'}
        </p>
      </section>

      <section>
        <h2>2 &middot; Parameters</h2>
        <NetworkPicker
          chainId={form.chainId}
          walletChainId={walletChain}
          onChange={(chainId) => void onNetworkChange(chainId)}
        />
        <div className="grid">
          <label>
            Owner (can always recover the funds)
            <input
              placeholder="Paste your address, or connect a wallet"
              value={form.owner}
              onChange={(event) => set('owner', event.target.value)}
              aria-invalid={ownerError !== null}
              aria-describedby={ownerError ? 'owner-error' : undefined}
            />
            {ownerError && (
              <span className="field-error" id="owner-error">
                {ownerError}
              </span>
            )}
          </label>
          <TokenPicker
            label="Sell token"
            tokens={tokens}
            value={form.sellToken}
            chainId={form.chainId}
            onChange={(address) => set('sellToken', address)}
          />
          <TokenPicker
            label="Buy token"
            tokens={tokens}
            value={form.buyToken}
            chainId={form.chainId}
            onChange={(address) => set('buyToken', address)}
          />
          <label>
            Limit price (buy per sell)
            <input value={form.limitPrice} onChange={(event) => set('limitPrice', event.target.value)} />
          </label>
          <label>
            Receiver (blank = the owner)
            <input
              placeholder="0x…"
              value={form.receiver}
              onChange={(event) => set('receiver', event.target.value)}
            />
          </label>
          {form.recipeKind === 'swap' && (
            <label>
              Order validity (minutes)
              <input value={form.validityMinutes} onChange={(event) => set('validityMinutes', event.target.value)} />
            </label>
          )}
          {form.recipeKind === 'twap' && (
            <>
              <label>
                Parts
                <input value={form.parts} onChange={(event) => set('parts', event.target.value)} />
              </label>
              <label>
                Minutes per part
                <input value={form.partMinutes} onChange={(event) => set('partMinutes', event.target.value)} />
              </label>
            </>
          )}
          {form.recipeKind === 'stoploss' && (
            <>
              <label>
                Strike (buy per sell, 18 decimals)
                <input value={form.strike} onChange={(event) => set('strike', event.target.value)} />
              </label>
              <label>
                Order validity (days)
                <input value={form.stopLossDays} onChange={(event) => set('stopLossDays', event.target.value)} />
              </label>
            </>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.wrapNative}
              onChange={(event) => set('wrapNative', event.target.checked)}
            />
            Wrap the native token first
          </label>
          {form.recipeKind === 'swap' && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.useOracle}
                onChange={(event) => set('useOracle', event.target.checked)}
              />
              Improve the limit with a price feed at activation
            </label>
          )}
        </div>

        {(form.recipeKind === 'stoploss' || (form.recipeKind === 'swap' && form.useOracle)) && (
          <fieldset className="subsection">
            <legend>Price feeds</legend>
            <div className="grid">
              <label>
                Sell token feed
                <input
                  placeholder="0x… Chainlink aggregator"
                  value={form.sellOracle}
                  onChange={(event) => set('sellOracle', event.target.value)}
                />
              </label>
              <label>
                Buy token feed
                <input
                  placeholder="0x… same quote currency"
                  value={form.buyOracle}
                  onChange={(event) => set('buyOracle', event.target.value)}
                />
              </label>
              <label>
                Max feed age (minutes)
                <input
                  value={form.oracleMaxAgeMinutes}
                  onChange={(event) => set('oracleMaxAgeMinutes', event.target.value)}
                />
              </label>
              {form.recipeKind === 'swap' && (
                <label>
                  Haircut (bps below the feed)
                  <input
                    value={form.oracleHaircutBps}
                    onChange={(event) => set('oracleHaircutBps', event.target.value)}
                  />
                </label>
              )}
            </div>
            <p className="hint">
              Both feeds must quote the <em>same currency</em> — nothing on-chain checks it.{' '}
              {form.recipeKind === 'swap' ? (
                <>
                  Your limit price becomes a <strong>floor</strong> the feed may only tighten, so whoever
                  activates cannot pick your price.
                </>
              ) : (
                <>
                  The strike fires when one sell token is worth <em>at most</em> that many buy tokens, at
                  18 decimals; the limit price says how bad a fill you refuse.
                </>
              )}
            </p>
          </fieldset>
        )}

        {/*
          * Its own box, above the guards: this is a tool for filling in the limit price, so it belongs
          * next to the parameters that set the price rather than after the optional panels.
          */}
        <fieldset className="subsection quote">
          <legend>Market price</legend>
          <label>
            Reference amount (for the quote only, never part of the recipe)
            <input value={referenceAmount} onChange={(event) => setReferenceAmount(event.target.value)} />
          </label>
          <div className="actions">
            <button onClick={() => void onQuote()} disabled={quoting}>
              {quoting ? 'Quoting…' : 'Get market price'}
            </button>
            {quote && (
              <>
                <span className="quote-price">
                  market <strong>{quote.price}</strong> {buyToken?.symbol ?? ''} per {sellToken?.symbol ?? ''}
                </span>
                {[0.5, 1, 5].map((slippage) => (
                  <button key={slippage} onClick={() => set('limitPrice', applySlippage(quote.price, slippage))}>
                    −{slippage}%
                  </button>
                ))}
              </>
            )}
          </div>
          {quoteError && (
            <p className="error" role="alert">
              {quoteError}
            </p>
          )}
          <p className="hint">
            Only the <em>price</em> is used — a drop cannot know its amount in advance. The amount still
            matters: quote too little and the fee dominates, making the market look worse than it is.
          </p>
        </fieldset>

        <details
          className="subsection guards"
          open={guardsOpen}
          onToggle={(event) => setGuardsOpen(event.currentTarget.open)}
        >
          <summary>
            Guards (optional)
            {guardsSet > 0 && <span className="guard-count"> — {guardsSet} set</span>}
          </summary>
          <div className="grid">
            <label>
              Minimum amount before activating
              <input
                placeholder={`whole ${findToken(tokens, form.sellToken)?.symbol ?? 'tokens'}`}
                value={form.minAmount}
                onChange={(event) => set('minAmount', event.target.value)}
              />
            </label>
            <label>
              Not before
              <input
                type="datetime-local"
                value={form.notBefore}
                onChange={(event) => set('notBefore', event.target.value)}
              />
            </label>
            <label>
              Not after
              <input
                type="datetime-local"
                value={form.notAfter}
                onChange={(event) => set('notAfter', event.target.value)}
              />
            </label>
          </div>
          <p className="hint">
            Anyone can activate, so &ldquo;not yet&rdquo; must be committed into the address, not promised.
            Guards <em>refuse</em> rather than trigger — nothing watches for one to turn true — and they
            are part of the address, so adding one moves it.
          </p>
        </details>
        {/*
          * Outside the collapsed panel on purpose: a warning nobody can see is not a warning, and this
          * one is about the guard the user has *not* set.
          */}
        {form.recipeKind !== 'swap' && !form.minAmount && (
          <p className="hint warn-note">
            This recipe is one-shot. Without a minimum, anyone can activate on the first wei and the order
            gets sized from a part-delivered balance — what a bridge paying in tranches does.
          </p>
        )}
        <p className="hint">
          Bought tokens go to the <strong>receiver</strong>, defaulting to the owner; the zero address
          leaves them in the drop. It cannot default to the drop itself — that address is derived from
          these fields.
        </p>
      </section>

      {feedsMissing ? (
        <section>
          <h2>3 &middot; Add the price feeds</h2>
          <p className="warn">A stop-loss needs both feeds before it has an address.</p>
          <p className="hint">
            The strike compares one against the other, so neither has a sensible default. Fill in the two
            aggregators above — they must quote the same currency — and the address appears.
          </p>
        </section>
      ) : compiled.ok ? (
        <>
          {probeError !== null ? (
            <section>
              <h2>3 &middot; Could not check {chainName}</h2>
              <p className="warn">
                The address is withheld because we could not confirm the contracts are there, not
                because they are missing. Unverified is not the same as unsafe, but it is not a good
                enough reason to show you somewhere to send money.
              </p>
              <p className="error">{probeError}</p>
              <div className="actions">
                <button onClick={retryProbe}>Try again</button>
              </div>
            </section>
          ) : chainMissing === null ? (
            <section>
              <h2>3 &middot; Your drop address</h2>
              <p className="hint">
                Checking whether {chainName} has the contracts a drop needs&hellip;
              </p>
            </section>
          ) : chainMissing.length > 0 ? (
            <section>
              <h2>3 &middot; Not available on {chainName} yet</h2>
              <p className="warn">
                <strong>{chainMissing.join(', ')}</strong>{' '}
                {chainMissing.length > 1 ? 'are' : 'is'} not deployed on {chainName}, so the drop
                address is withheld here rather than shown.
              </p>
              <p className="hint">
                An address is only worth having if something can act on it: activation needs{' '}
                <code>DropExecutor</code> and the step contracts, and rescue needs{' '}
                <code>COWShedExecutorFactory</code>. With those missing there is no path out, not even
                for you.
              </p>
              <p className="hint">
                The recipe is fine, and resolves to the same address on every chain — so it will not
                move once the contracts land. Switch to a chain without this label to fund it.
              </p>
            </section>
          ) : ownerUnusable ? (
            <section>
              <h2>3 &middot; Set an owner first</h2>
              <p className="warn">
                The owner field is empty, so the drop address is withheld until you fill it in.
              </p>
              <p className="hint">
                Only the owner can recover a funded drop — both rescue paths check{' '}
                <code>msg.sender == owner</code>. Left empty it falls back to the ecrecover precompile,{' '}
                <code>{PLACEHOLDER_OWNER}</code>, which nobody holds the key to. Such a drop still funds
                and activates; the money is just unreachable.
              </p>
              <p className="hint">
                Paste an address, or connect a wallet. The owner is part of the derivation, so setting
                it produces a <em>different</em> address — it cannot be added to one already funded.
              </p>
            </section>
          ) : (
            <>
              <section>
                <h2>3 &middot; Your drop address</h2>
                <DropAddress
                  address={compiled.value.address}
                  saved={saved}
                  onRemember={remember}
                  recipe={recipe}
                />
              </section>

              <section>
                <h2>4 &middot; What the address commits to</h2>
                <StepTable setupData={compiled.value.setupData} deployment={compiled.value.deployment} />
              </section>

              <section>
                <h2>5 &middot; Status</h2>
                {status ? (
                  <ul className="status">
                    <li>
                      Balance at drop:{' '}
                      <strong>
                        {formatUnits(status.balance, sellToken?.decimals ?? 18)} {sellToken?.symbol ?? ''}
                      </strong>
                      {status.nativeBalance > 0n ? ` (+ ${formatUnits(status.nativeBalance, 18)} xDAI)` : ''}
                    </li>
                    <li>Drop deployed: <strong>{status.deployed ? 'yes' : 'not yet'}</strong></li>
                    {status.missing.length > 0 && (
                      <li className="warn">
                        {status.missing.join(' and ')} {status.missing.length > 1 ? 'are' : 'is'} not
                        deployed on {getDropChain(form.chainId)?.name ?? form.chainId} yet, so activation
                        will revert. The cow-shed contracts a drop is derived from are already live, and
                        the addresses are deterministic — so this drop address is correct now and will not
                        change once the missing pieces are deployed.
                      </li>
                    )}
                  </ul>
                ) : (
                  <p className="hint">Reading chain state…</p>
                )}

                <div className="actions">
                  <button onClick={() => void refresh()}>Refresh</button>
                  <button
                    onClick={() => void onActivate()}
                    disabled={!account || busy || (status?.missing.length ?? 0) > 0}
                  >
                    {busy ? 'Activating…' : 'Activate drop'}
                  </button>
                  {keeperUrl() !== null &&
                    /*
                     * One button, both directions. It reads as state as much as an action: a "Hand to
                     * keeper" that stays on offer after being pressed looks like a button that did
                     * nothing, which is exactly how this behaved before.
                     *
                     * No confirmation on the stop side. It costs the subsidy and nothing else — the
                     * drop keeps its funds, activation stays permissionless, and pressing the other
                     * half of this button puts the keeper back on it.
                     */
                    (keeperWatching === true ? (
                      <button onClick={() => void onUnregisterKeeper()} disabled={busy}>
                        Stop keeper watching
                      </button>
                    ) : (
                      <button onClick={() => void onRegisterKeeper()} disabled={busy}>
                        Hand to keeper
                      </button>
                    ))}
                  <a
                    href={`${cowExplorer(dropChainId)}/address/${compiled.value.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View in Explorer
                  </a>
                  <a
                    href={`${blockExplorer(dropChainId).url}/address/${compiled.value.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on {blockExplorer(dropChainId).name}
                  </a>
                </div>

                {/*
                  * The keeper sentence is gated on the same condition as the button it describes, or the
                  * explainer names an action that is not on the page.
                  */}
                <ul className="hint hint-list">
                  <li>
                    <strong>Activate drop</strong> — deploy the drop and run its setup yourself, now. Safe
                    to press again: an already-deployed drop just re-runs the setup.
                  </li>
                  {keeperUrl() !== null && (
                    <li>
                      {keeperWatching === true ? (
                        <>
                          <strong>Stop keeper watching</strong> — this keeper is watching the drop and will
                          activate it once it has a balance. Stopping only ends that: the drop keeps
                          whatever it holds, anyone can still activate it, and handing it back later
                          resumes the watch.
                        </>
                      ) : (
                        <>
                          <strong>Hand to keeper</strong> — have the keeper do that for you instead. It waits
                          until the drop has a balance, then activates it unattended.
                        </>
                      )}
                    </li>
                  )}
                </ul>

                {!account && (
                  <p className="hint">
                    <strong>Activate needs a connected wallet</strong> — only to pay the gas. Activation
                    is permissionless, so the transaction authorises nothing and any account could send
                    it.
                  </p>
                )}

                {message && <p className="ok">{message}</p>}

                <TerminalPanel compiled={compiled.value} />
              </section>

              {/*
                * Collapsed behind its heading, like section 7: the rescue paths are the wrong answer to
                * almost every question, and the panel used to fold itself away *inside* this already
                * titled section — two things to click, and two different names for one panel.
                */}
              <section>
                <details className="collapsed-section rescue">
                  <summary>
                    <h2>6 &middot; If something goes wrong</h2>
                  </summary>
                  <RescuePanel
                    compiled={compiled.value}
                    account={account}
                    deployed={status?.deployed ?? false}
                    sellToken={form.sellToken}
                    tokens={tokens}
                  />
                </details>
              </section>

              {/*
                * Collapsed by default: an escape hatch for calls the recipe types do not cover, which is
                * to say almost never — and open it costs a screenful of ABI fields between the rescue
                * panel and the recipe file.
                */}
              <section>
                <details className="collapsed-section">
                  <summary>
                    <h2>7 &middot; Add a custom step</h2>
                  </summary>
                  <p className="hint">
                    For calling something the recipe types do not cover. Every argument is a literal
                    committed into the address, so it cannot depend on the amount that arrives.
                  </p>
                  <StepBuilder
                    onAddStep={(step) => {
                      setImported({ ...recipe, steps: [...recipe.steps, step] })
                      setError(null)
                    }}
                    onError={setError}
                  />
                </details>
              </section>

              <section>
                <h2>8 &middot; Recipe file</h2>
                <RecipeJson
                  recipe={recipe}
                  address={compiled.value.address}
                  onImport={(next) => {
                    setImported(next)
                    setError(null)
                  }}
                  onError={setError}
                  onRemember={remember}
                />
              </section>
            </>
          )}
        </>
      ) : (
        <section>
          <p className="error">{compiled.error}</p>
        </section>
      )}
    </>
  )
}
