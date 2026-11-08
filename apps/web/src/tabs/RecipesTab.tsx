import {
  compileRecipe,
  convertOnArrival,
  getDropChain,
  paymentRequest,
  stopLossOnArrival,
  swapOnArrival,
  twapOnArrival,
  type DropRecipeJson,
  type DropStepJson,
  type LimitPriceJson,
} from '@cowprotocol/cow-drop-sdk'
import { formatUnits, isAddress, parseUnits, type Address } from 'viem'
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
import {
  keeperPayer,
  keeperUrl,
  readKeeperDrop,
  registerWithKeeper,
  unregisterFromKeeper,
} from '../lib/keeper.js'
import { keeperTooltip } from '../lib/dropList.js'
import { routeHash } from '../lib/route.js'
import { writeHash } from '../lib/useRoute.js'
import { TokenPicker } from '../components/TokenPicker.js'
import { DropAddress } from '../components/DropAddress.js'
import { RecipeJson } from '../components/RecipeJson.js'
import { StepBuilder } from '../components/StepBuilder.js'
import { RescuePanel } from '../components/RescuePanel.js'
import { TerminalPanel } from '../components/TerminalPanel.js'
import { StepTable } from '../components/StepTable.js'
import { ConvertPanel, convertStepOf } from '../components/ConvertPanel.js'
import { PaymentPanel, paymentStepOf } from '../components/PaymentPanel.js'
import { Section } from '../components/Section.js'
import { Select, type SelectOption } from '../components/Select.js'
import { Tooltip } from '../components/Tooltip.js'

/**
 * Which recipe to build. Named for what the user sees: the SDK calls these templates, because
 * there a template is a function that produces a recipe — a distinction worth keeping in code and
 * not worth making a user learn.
 */
type RecipeKind = 'swap' | 'twap' | 'stoploss' | 'payment' | 'convert'

/**
 * Recipes that commit to no sell token: whoever activates names it.
 *
 * They share a shape rather than a name — no sell-token box, nothing to wrap, no balance to guard —
 * so the form branches on this instead of on each kind.
 */
function namesSellToken(kind: RecipeKind): boolean {
  return kind !== 'payment' && kind !== 'convert'
}

/**
 * The five recipes, as the dropdown shows them.
 *
 * `description` is the one line under the name — what it does, not how. `detail` is the rest, which
 * the tooltip beside the picker holds: whether it drives itself, and what you still have to do.
 */
const RECIPE_KINDS: (SelectOption<RecipeKind> & { detail: string })[] = [
  {
    value: 'swap',
    label: 'Swap on arrival',
    description: 'Sells what lands here, once, at your price',
    detail: 'You post the order to CoW after activating. No watch tower needed.',
  },
  {
    value: 'payment',
    label: 'Payment request',
    description: 'Asks a fixed amount, payable in any token',
    detail:
      'The payer is quoted what to send; the keeper sells it for at least your price, and any surplus is yours. Reusable, so one address takes payment after payment.',
  },
  {
    value: 'convert',
    label: 'Convert on arrival',
    description: 'Sells whatever lands here into one token',
    detail:
      'No price is committed: whoever activates names the order\u2019s minimum, which is why the recipe names a pricer. Reusable, so one address converts arrival after arrival.',
  },
  {
    value: 'twap',
    label: 'TWAP on arrival',
    description: 'Sells what lands here in parts, over time',
    detail: 'Self-driving: after one activation the watch tower posts each part.',
  },
  {
    value: 'stoploss',
    label: 'Stop-loss on arrival',
    description: 'Sells when a price feed crosses your strike',
    detail: 'Self-driving: the watch tower polls the condition, so nobody has to watch.',
  },
]

const PLACEHOLDER_OWNER: Address = '0x0000000000000000000000000000000000000001'
/** "Anyone may activate", as the convert step reads it. */
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

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

/**
 * How many bytes a label may encode to.
 *
 * The contract stores it in one 32-byte word, and `encodeLabel` throws above that. UTF-8, not
 * characters: an emoji is four bytes and an accented letter is two, so counting characters would
 * let a short-looking name through and blow up at compile time.
 */
const LABEL_MAX_BYTES = 32

function labelBytes(label: string): number {
  return new TextEncoder().encode(label).length
}

interface FormState {
  chainId: number
  recipeKind: RecipeKind
  /**
   * What to call this drop. Blank means the template's own name for it.
   *
   * It is part of the recipe, and therefore part of the address: two drops differing only in their
   * label are two different addresses. That is why this is set here, with everything else that moves
   * the address, and why a drop cannot be renamed after it is funded.
   */
  label: string
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
  /** The payment recipe's price, in whole `buyToken` units as typed. */
  payAmount: string
  /**
   * Who may activate a convert drop, or blank for anyone.
   *
   * Blank compiles to the zero address, which the contract reads as "no gate" — so leaving it empty
   * is a decision, not an omission, and the form says so beside the field.
   */
  pricer: string
}

const INITIAL: FormState = {
  chainId: DEFAULT_CHAIN_ID,
  recipeKind: 'swap',
  label: '',
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
  payAmount: '100',
  pricer: '',
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

/** The reusable recipes, which never read as "activated" because each arrival activates again. */
type ReusableKind = 'payment' | 'convert' | null

/**
 * Where the drop has got to, as one line.
 *
 * The question this panel exists to answer is "can it run yet", and the balance and the deployed flag
 * are only the evidence for it. Ordered by what blocks what: a chain with no contracts beats a drop
 * with no funds, which beats a drop that has not been activated.
 */
function DropState({ status, reusable }: { status: DropStatus; reusable: ReusableKind }) {
  const state = (() => {
    if (status.missing.length > 0) {
      return { tone: 'warn', label: 'Cannot activate here', detail: 'The chain is missing contracts a drop needs.' } as const
    }
    if (status.deployed) {
      if (reusable === 'payment') {
        return { tone: 'ok', label: 'Taking payments', detail: 'Deployed. Each payment is activated on its own.' } as const
      }
      if (reusable === 'convert') {
        return { tone: 'ok', label: 'Converting arrivals', detail: 'Deployed. Each arrival is activated on its own.' } as const
      }
      return { tone: 'ok', label: 'Activated', detail: 'Deployed and its recipe has run.' } as const
    }
    if (status.balance > 0n || status.nativeBalance > 0n) {
      return { tone: 'ok', label: 'Funded, ready to activate', detail: 'Money has arrived. Anyone can run the recipe now.' } as const
    }
    return reusable === 'payment'
      ? { tone: 'info', label: 'Waiting for a payment', detail: 'Nothing has arrived at this address yet.' } as const
      : { tone: 'info', label: 'Waiting for funds', detail: 'Nothing has arrived at this address yet.' } as const
  })()

  return (
    <div className="drop-state">
      <span className={`state-pill ${state.tone}`}>{state.label}</span>
      <p className="hint">{state.detail}</p>
    </div>
  )
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

  /*
   * Blank means "whatever the template calls it", which is how the label behaved before this field
   * existed — so an untouched form still compiles to the address it always did. Over-long is treated
   * the same: `encodeLabel` throws above 32 bytes, and the form withholds the address rather than
   * letting that reach `compileRecipe` as a page-level crash.
   */
  const label =
    form.label.trim() !== '' && labelBytes(form.label.trim()) <= LABEL_MAX_BYTES
      ? form.label.trim()
      : undefined

  if (form.recipeKind === 'payment') {
    // No sell token, no limit price, no balance guard: the payer picks the token, and the price — a
    // fixed amount of the buy token — is the only thing the address commits to.
    return paymentRequest({
      chainId: form.chainId,
      label,
      owner,
      buyToken: form.buyToken,
      buyAmount: parsePayAmount(form.payAmount, buyDecimals),
      receiver,
      validitySeconds: Number(form.validityMinutes) * 60,
      notBefore: guards.notBefore,
      notAfter: guards.notAfter,
    })
  }

  if (form.recipeKind === 'convert') {
    // No sell token and no price: the activator names both. Only the pricer is committed here.
    return convertOnArrival({
      chainId: form.chainId,
      label,
      owner,
      buyToken: form.buyToken,
      receiver,
      pricer: (isAddress(form.pricer) ? form.pricer : ZERO_ADDRESS) as Address,
      validitySeconds: Number(form.validityMinutes) * 60,
      notBefore: guards.notBefore,
      notAfter: guards.notAfter,
    })
  }

  if (form.recipeKind === 'stoploss') {
    return stopLossOnArrival({
      chainId: form.chainId,
      label,
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
      label,
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
    label,
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
 * The typed price in atoms, or zero when it is not a number yet — which `compileRecipe` refuses with a
 * message about the price, rather than this throwing on every half-typed keystroke.
 */
function parsePayAmount(value: string, decimals: number): bigint {
  try {
    return parseUnits(value.trim() || '0', decimals)
  } catch {
    return 0n
  }
}

/** A unix timestamp back into the local `datetime-local` value that produces it. */
function toLocalDateTime(seconds: number | string): string {
  const date = new Date(Number(seconds) * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A limit price the form can hold. It stores a decimal, so an exact fraction is out of reach. */
function humanPrice(price: LimitPriceJson): string | null {
  return 'price' in price ? price.price : null
}

/**
 * The reverse of `toRecipe`: the form that rebuilds this recipe, or `null` when the form cannot
 * express it.
 *
 * Only the shape the templates emit is recognised — the time guard, an optional wrap, the balance
 * guard, then exactly one trade step. A file with anything else in it, or with a field the form has
 * no box for (a salt, a TWAP span), falls out here or fails the caller's address check, and the
 * recipe goes on overriding the form as before. The label does have a box now, so a custom-named
 * recipe hydrates instead of being refused.
 *
 * Correctness is not this function's job: it proposes, and `matchingForm` compiles the proposal and
 * refuses it unless it derives the very same address. That is what makes hydrating safe — every way
 * this could misread a recipe moves the address, and a moved address is not the drop that was
 * loaded.
 */
function toForm(recipe: DropRecipeJson, tokens: TokenInfo[]): FormState | null {
  const rest = [...recipe.steps]
  const base: FormState = { ...INITIAL, chainId: recipe.chainId, label: recipe.label, owner: recipe.owner }

  if (rest[0]?.type === 'requireTimeWindow') {
    const guard = rest.shift() as Extract<DropStepJson, { type: 'requireTimeWindow' }>
    base.notBefore = guard.notBefore === undefined ? '' : toLocalDateTime(guard.notBefore)
    base.notAfter = guard.notAfter === undefined ? '' : toLocalDateTime(guard.notAfter)
  }

  if (rest[0]?.type === 'wrapNative') {
    rest.shift()
    base.wrapNative = true
  }

  const balanceGuard = rest[0]?.type === 'requireMinBalance' ? rest.shift() : undefined

  if (rest.length !== 1) return null
  const trade = rest[0]!

  if (trade.type === 'convert') {
    if (base.wrapNative || balanceGuard) return null
    base.recipeKind = 'convert'
    base.buyToken = trade.buyToken
    base.validityMinutes = String(Number(trade.validitySeconds) / 60)
    base.pricer = trade.pricer && trade.pricer !== ZERO_ADDRESS ? trade.pricer : ''
    base.receiver =
      trade.receiver && trade.receiver.toLowerCase() !== recipe.owner.toLowerCase() ? trade.receiver : ''
    return base
  }

  if (trade.type === 'payment') {
    if (base.wrapNative || balanceGuard) return null
    base.recipeKind = 'payment'
    base.buyToken = trade.buyToken
    base.payAmount = formatUnits(BigInt(trade.buyAmount), findToken(tokens, trade.buyToken)?.decimals ?? 18)
    base.validityMinutes = String(Number(trade.validitySeconds) / 60)
    base.receiver =
      trade.receiver && trade.receiver.toLowerCase() !== recipe.owner.toLowerCase() ? trade.receiver : ''
    return base
  }

  if (balanceGuard?.type === 'requireMinBalance') {
    // The form's box is in whole tokens, so a guard that is not a whole number of them has no value
    // to put in it — and half a token showing as none would move the address without saying so.
    const unit = 10n ** BigInt(findToken(tokens, balanceGuard.token)?.decimals ?? 18)
    const amount = BigInt(balanceGuard.minAmount)
    if (amount % unit !== 0n) return null
    base.minAmount = (amount / unit).toString()
  }

  switch (trade.type) {
    case 'presignSellAll': {
      const price = humanPrice(trade.limitPrice)
      if (price === null) return null
      base.recipeKind = 'swap'
      base.useOracle = false
      base.limitPrice = price
      base.validityMinutes = String(Number(trade.validitySeconds) / 60)
      break
    }

    case 'presignSellAllAtOracle': {
      const price = humanPrice(trade.floorPrice)
      if (price === null) return null
      base.recipeKind = 'swap'
      base.useOracle = true
      base.limitPrice = price
      base.validityMinutes = String(Number(trade.validitySeconds) / 60)
      base.sellOracle = trade.oracle.sellTokenPriceOracle
      base.buyOracle = trade.oracle.buyTokenPriceOracle
      base.oracleMaxAgeMinutes = String(Number(trade.oracle.maxAge) / 60)
      base.oracleHaircutBps = String(trade.oracle.haircutBps)
      break
    }

    case 'twapFromBalance': {
      const price = humanPrice(trade.limitPrice)
      if (price === null) return null
      base.recipeKind = 'twap'
      base.limitPrice = price
      base.parts = String(trade.parts)
      base.partMinutes = String(Number(trade.partDuration) / 60)
      break
    }

    case 'stopLossFromBalance': {
      const price = humanPrice(trade.limitPrice)
      if (price === null) return null
      base.recipeKind = 'stoploss'
      base.limitPrice = price
      base.stopLossDays = String(Number(trade.validitySeconds) / (24 * 3600))
      base.sellOracle = trade.trigger.sellTokenPriceOracle
      base.buyOracle = trade.trigger.buyTokenPriceOracle
      base.strike = String(trade.trigger.strike)
      base.oracleMaxAgeMinutes = String(Number(trade.trigger.maxTimeSinceLastOracleUpdate) / 60)
      break
    }

    default:
      return null
  }

  base.sellToken = trade.sellToken
  base.buyToken = trade.buyToken
  // The templates always write a receiver, defaulting it to the owner; blank is how the form says
  // that, and saying it any other way would be a difference the user never typed.
  base.receiver =
    trade.receiver && trade.receiver.toLowerCase() !== recipe.owner.toLowerCase() ? trade.receiver : ''

  return base
}

/**
 * The form that rebuilds this recipe *exactly*, or `null`.
 *
 * The check is the compiled address, because that is the only thing about a drop that has to be
 * right: it is what the money is sent to. Two recipes that derive it are the same drop whatever
 * their JSON looks like, and a candidate that derives anything else is a different drop wearing the
 * loaded one's name.
 */
function matchingForm(recipe: DropRecipeJson, tokens: TokenInfo[]): FormState | null {
  const candidate = toForm(recipe, tokens)
  if (!candidate) return null
  try {
    const rebuilt = compileRecipe(toRecipe(candidate, tokens))
    return rebuilt.address === compileRecipe(recipe).address ? candidate : null
  } catch {
    return null
  }
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
  onBridge,
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
  /**
   * The drop the builder currently resolves to, for the header badge and the Drops list's marker.
   *
   * The recipe travels with the address because the two are inseparable downstream: a share link is
   * the recipe, and an address without one is a page nobody can act on.
   */
  onAddressChanged: (drop: { address: Address; recipe: DropRecipeJson } | null) => void
  /** Moves to the Drops tab, for the rows only the keeper knows about. */
  /**
   * Hands this recipe to the Bridge tab, to be funded from another chain.
   *
   * The recipe travels rather than being rebuilt there: bridging is a way of funding a drop, so every
   * recipe kind is fundable that way and none of this form needs duplicating.
   */
  onBridge: (recipe: DropRecipeJson) => void
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
   * The keeper's own address, offered as the convert recipe's pricer.
   *
   * Fetched while the form is still being filled in, because the pricer is part of the derivation:
   * a drop that names the wrong one cannot be handed over later, only rebuilt at a new address.
   */
  const [keeperAddress, setKeeperAddress] = useState<Address | null>(null)
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
  /**
   * Which chain `tokens` was *fetched* for, or `null` while it is still the built-in fallback.
   *
   * Only the hydrate below needs it, and it needs it badly. Decimals decide what a limit price
   * compiles to, so judging a recipe against another chain's list would either reject a drop that is
   * fine or — worse — accept a form that derives a different address. Null until a list has actually
   * arrived, for the same reason: the fetch that follows drops any selected token the list does not
   * know, and a hydrate that raced ahead of it would be quietly undone.
   */
  const [tokensChainId, setTokensChainId] = useState<number | null>(null)
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
  const guardsSet = [
    ...(namesSellToken(form.recipeKind) ? [form.minAmount] : []),
    form.notBefore,
    form.notAfter,
  ].filter((value) => value !== '').length

  /**
   * What is wrong with the owner *field*, as opposed to with the recipe.
   *
   * The section-3 gate is the backstop that stops the money moving; this is the part that says which
   * input caused it. Reported against `form.owner` rather than the recipe, because an imported recipe
   * does not come from this field and blaming it would be wrong.
   */
  /**
   * Whether the typed label is too long to encode.
   *
   * Checked here rather than left to `encodeLabel`, which throws — and a throw inside `toRecipe`
   * takes the whole address section down with a stack trace instead of saying which field is wrong.
   */
  const labelTooLong = labelBytes(form.label.trim()) > LABEL_MAX_BYTES

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
    // A payment or convert recipe has no sell token; the status reads the buy token instead, which is
    // what an arrival already in that token would leave behind.
    const sellToken =
      sellStep && 'sellToken' in sellStep
        ? sellStep.sellToken
        : (paymentStepOf(recipe) ?? convertStepOf(recipe))?.buyToken
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
   * Take an imported recipe into the form, and let the form own it from then on.
   *
   * A recipe arrives whole — from the URL, a file, the Drops list — while the form is still at its
   * initial values, and an import *overrides* the form. So the page showed one drop's address above
   * another drop's parameters, and the first keystroke anywhere dropped the override and jumped the
   * address to whatever that stale form happened to compile to.
   *
   * Filling the form in is what fixes both: once the fields say what the recipe says, the override
   * has nothing left to do and is cleared, so editing a field moves the address by that field alone.
   * Cleared only on an exact match — `matchingForm` compiles its candidate and compares addresses —
   * because a form that *nearly* reproduces the recipe is a quieter version of the same bug.
   *
   * A recipe the form cannot hold (a hand-written file, anything the step builder added) still falls
   * back to hydrating the two fields that are always faithful, and goes on overriding the form.
   *
   * Re-runs as the token list arrives: decimals are half of what a limit price compiles to, so a
   * recipe for a chain whose list is still loading cannot be judged yet. The partial hydrate below
   * sets the chain, which is what fetches that list and brings us back here.
   */
  useEffect(() => {
    if (!imported) return

    if (tokensChainId === imported.chainId) {
      const hydrated = matchingForm(imported, tokens)
      if (hydrated) {
        setForm(hydrated)
        setImported(null)
        // A guard is a reason the address is where it is, so it must not arrive collapsed.
        if (hydrated.minAmount || hydrated.notBefore || hydrated.notAfter) setGuardsOpen(true)
        return
      }
    }

    setForm((previous) =>
      previous.owner === imported.owner && previous.chainId === imported.chainId
        ? previous
        : { ...previous, owner: imported.owner, chainId: imported.chainId },
    )
  }, [imported, tokens, tokensChainId, setImported])

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
    if (!compiled.ok || keeperUrl(compiled.value.deployment.chainId) === null) {
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
    void readKeeperDrop(address, chainId)
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
      setTokensChainId(chainId)

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
  // A placeholder owner (e.g. restored from the URL of an empty form) counts as unset.
  const placeholderOwner = UNUSABLE_OWNERS.has(form.owner.toLowerCase())
  useEffect(() => {
    if (!account) return
    setForm((previous) =>
      isAddress(previous.owner) && !UNUSABLE_OWNERS.has(previous.owner.toLowerCase())
        ? previous
        : { ...previous, owner: account },
    )
  }, [account, placeholderOwner])

  /*
   * Default to whatever network the wallet is already on, when we support it.
   *
   * Re-read whenever the account changes, not only on mount. Connecting happens after mount by
   * definition — it takes a click — so a mount-only read answered `null` for every wallet anyone
   * ever connected, and `NetworkPicker`'s "your wallet is on X" banner could not appear.
   *
   * That was survivable while a failed chain switch also failed the connection. It is not now: a
   * wallet that refuses to move stays connected on its own chain, and this banner is the only thing
   * that says so.
   */
  useEffect(() => {
    void walletChainId().then((chain) => {
      setWalletChain(chain)
      if (chain !== null && getDropChain(chain)) {
        setForm((previous) => (previous.chainId === DEFAULT_CHAIN_ID ? { ...previous, chainId: chain } : previous))
      }
    })
  }, [account])

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

  /**
   * Reported only when the page is willing to *show* the address, not merely able to compute one.
   *
   * Those are different questions, and conflating them is dangerous. A recipe with an empty owner
   * still compiles — it derives against the ecrecover precompile — and step 3 refuses to print that
   * address precisely because a drop owned by it can be funded and never recovered. A header badge
   * that showed it anyway would hand out, with a QR code and a Share button, the one address nobody
   * must ever send money to. The same holds on a chain whose contracts are missing and for a
   * stop-loss with no feeds.
   */
  const addressIsShown =
    compiled.ok &&
    !feedsMissing &&
    !ownerUnusable &&
    !labelTooLong &&
    probeError === null &&
    chainMissing?.length === 0

  useEffect(
    () =>
      onAddressChanged(
        addressIsShown && compiled.ok ? { address: compiled.value.address, recipe } : null,
      ),
    [addressIsShown, compiled, recipe, onAddressChanged],
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
  useEffect(() => {
    if (form.recipeKind !== 'convert') {
      setKeeperAddress(null)
      return
    }
    let cancelled = false
    void keeperPayer(form.chainId).then((payer) => {
      if (!cancelled) setKeeperAddress(payer)
    })
    return () => {
      cancelled = true
    }
  }, [form.recipeKind, form.chainId])

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
        url: keeperUrl(compiled.value.deployment.chainId) ?? '',
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
  /** Read off the recipe, so an imported one gets its panel too. */
  const isPayment = paymentStepOf(recipe) !== undefined
  const isConvert = convertStepOf(recipe) !== undefined
  const reusable: ReusableKind = isPayment ? 'payment' : isConvert ? 'convert' : null

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
      <Section title={<>1 &middot; Pick a recipe</>}>
        <Select
          className="recipe-picker"
          label={
            <>
              Recipe
              <Tooltip title={RECIPE_KINDS.find((kind) => kind.value === form.recipeKind)!.label}>
                {RECIPE_KINDS.find((kind) => kind.value === form.recipeKind)!.detail}
              </Tooltip>
            </>
          }
          value={form.recipeKind}
          options={RECIPE_KINDS}
          onChange={(kind) => set('recipeKind', kind)}
        />
      </Section>

      <Section title={<>2 &middot; Set parameters</>}>
        <NetworkPicker
          chainId={form.chainId}
          walletChainId={walletChain}
          onChange={(chainId) => void onNetworkChange(chainId)}
        />
        <div className="grid">
          <label>
            <span className="label-text">
              Name
              <Tooltip title="Name">
                Optional — without one the drop is called after its recipe. It is part of the
                address, like every other field here, so two drops differing only in their name are
                two different drops. A funded drop cannot be renamed.
              </Tooltip>
            </span>
            <input
              placeholder={RECIPE_KINDS.find((kind) => kind.value === form.recipeKind)!.label.toLowerCase()}
              value={form.label}
              onChange={(event) => set('label', event.target.value)}
              aria-invalid={labelTooLong}
              aria-describedby={labelTooLong ? 'label-error' : undefined}
            />
            {labelTooLong && (
              <span className="field-error" id="label-error">
                Too long: {labelBytes(form.label.trim())} bytes, and the drop stores {LABEL_MAX_BYTES}.
              </span>
            )}
          </label>

          <label>
            <span className="label-text">
              Owner
              <Tooltip title="Owner">
                The only account that can recover a funded drop, through either rescue path. It is part
                of the derivation, so changing it changes the address.
              </Tooltip>
            </span>
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
          {namesSellToken(form.recipeKind) && (
            <TokenPicker
              label="Sell token"
              tokens={tokens}
              value={form.sellToken}
              chainId={form.chainId}
              onChange={(address) => set('sellToken', address)}
            />
          )}
          <TokenPicker
            label={
              form.recipeKind === 'payment'
                ? 'Get paid in'
                : form.recipeKind === 'convert'
                  ? 'Convert into'
                  : 'Buy token'
            }
            tokens={tokens}
            value={form.buyToken}
            chainId={form.chainId}
            onChange={(address) => set('buyToken', address)}
          />
          {form.recipeKind === 'payment' ? (
            <label>
              <span className="label-text">
                Price per payment
                <Tooltip title="Price">The least you accept. Any surplus is yours too.</Tooltip>
              </span>
              <input
                inputMode="decimal"
                value={form.payAmount}
                onChange={(event) => set('payAmount', event.target.value)}
              />
            </label>
          ) : form.recipeKind === 'convert' ? (
            <label>
              <span className="label-text">
                Pricer
                <Tooltip title="Pricer">
                  <span>
                    The only address allowed to activate. Blank means anyone can — and since nothing
                    in the recipe fixes a price, anyone could then name one atom.
                  </span>
                  <span>
                    For the keeper to run this drop unattended, name the keeper here. It is part of
                    the address, so it cannot be changed afterwards.
                  </span>
                </Tooltip>
              </span>
              <input
                placeholder="0x… — blank means anyone"
                value={form.pricer}
                onChange={(event) => set('pricer', event.target.value)}
              />
              {keeperAddress && form.pricer.toLowerCase() !== keeperAddress.toLowerCase() && (
                <button type="button" className="link" onClick={() => set('pricer', keeperAddress)}>
                  Use the keeper
                </button>
              )}
            </label>
          ) : (
            <label>
              Limit price (buy per sell)
              <input value={form.limitPrice} onChange={(event) => set('limitPrice', event.target.value)} />
            </label>
          )}
          <label>
            <span className="label-text">
              Receiver
              <Tooltip title="Receiver">Blank means the owner.</Tooltip>
            </span>
            <input
              placeholder="0x…"
              value={form.receiver}
              onChange={(event) => set('receiver', event.target.value)}
            />
          </label>
          {(form.recipeKind === 'swap' ||
            form.recipeKind === 'payment' ||
            form.recipeKind === 'convert') && (
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
          {namesSellToken(form.recipeKind) && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.wrapNative}
                onChange={(event) => set('wrapNative', event.target.checked)}
              />
              Wrap the native token first
            </label>
          )}
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
              Both feeds must quote the same currency — nothing on-chain checks it.
              <Tooltip title="Using the feeds">
                {form.recipeKind === 'swap' ? (
                  <>
                    Your limit price becomes a floor the feed may only tighten, so whoever activates
                    cannot pick your price.
                  </>
                ) : (
                  <>
                    The strike fires when one sell token is worth at most that many buy tokens, at 18
                    decimals. The limit price says how bad a fill you refuse.
                  </>
                )}
              </Tooltip>
            </p>
          </fieldset>
        )}

        {/*
          * Its own box, above the guards: this is a tool for filling in the limit price, so it belongs
          * next to the parameters that set the price rather than after the optional panels.
          */}
        {namesSellToken(form.recipeKind) && (
          <fieldset className="subsection quote">
            <legend>Market price</legend>
            <label>
              <span className="label-text">
                Reference amount
                <Tooltip title="Reference amount">For the quote only; it never enters the recipe.</Tooltip>
              </span>
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
              Only the price is used, never the amount.
              <Tooltip title="Reference amount">
                A drop cannot know in advance how much will arrive, so the amount never enters the
                recipe. It still matters here: quote too little and the fee dominates, making the market
                look worse than it is.
              </Tooltip>
            </p>
          </fieldset>
        )}

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
            {namesSellToken(form.recipeKind) && (
              <label>
                Minimum amount before activating
                <input
                  placeholder={`whole ${findToken(tokens, form.sellToken)?.symbol ?? 'tokens'}`}
                  value={form.minAmount}
                  onChange={(event) => set('minAmount', event.target.value)}
                />
              </label>
            )}
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
            Guards refuse an activation. They never trigger one.
            <Tooltip title="Guards">
              Anyone can activate, so &ldquo;not yet&rdquo; has to be committed into the address rather
              than promised. Nothing watches for a guard to turn true, and a guard is part of the
              derivation — so adding one moves the address.
            </Tooltip>
          </p>
        </details>
        {/*
          * Outside the collapsed panel on purpose: a warning nobody can see is not a warning, and this
          * one is about the guard the user has *not* set.
          */}
        {(form.recipeKind === 'twap' || form.recipeKind === 'stoploss') && !form.minAmount && (
          <p className="hint warn-note">
            One-shot recipe with no minimum: anyone can activate on the first wei, and the order is then
            sized from a part-delivered balance — which is what a bridge paying in tranches sends.
          </p>
        )}
        {form.recipeKind === 'convert' && !isAddress(form.pricer) && (
          <p className="hint warn-note">
            No pricer: anyone can activate this drop and name the order&rsquo;s minimum, down to one atom.
            Nothing on-chain stops them — only CoW&rsquo;s solver competition, which is protection enough
            for amounts solvers compete over and thin cover for a large one.
          </p>
        )}
        <p className="hint">
          Bought tokens go to the receiver, which defaults to the owner.
          <Tooltip title="Receiver">
            The zero address leaves them in the drop. It cannot default to the drop itself, because that
            address is derived from these fields.
          </Tooltip>
        </p>
      </Section>

      {feedsMissing ? (
        <Section title={<>3 &middot; Add the price feeds</>}>
          <p className="warn">A stop-loss needs both feeds before it has an address.</p>
          <p className="hint">
            Fill in the two aggregators above, quoting the same currency, and the address appears. The
            strike compares one against the other, so neither has a default.
          </p>
        </Section>
      ) : compiled.ok ? (
        <>
          {probeError !== null ? (
            <Section title={<>3 &middot; Could not check {chainName}</>}>
              <p className="warn">
                The address is withheld because we could not confirm the contracts are there, not
                because they are missing. Unverified is not the same as unsafe, but it is not a good
                enough reason to show you somewhere to send money.
              </p>
              <p className="error">{probeError}</p>
              <div className="actions">
                <button onClick={retryProbe}>Try again</button>
              </div>
            </Section>
          ) : chainMissing === null ? (
            <Section title={<>3 &middot; Fund your drop address</>}>
              <p className="hint">
                Checking whether {chainName} has the contracts a drop needs&hellip;
              </p>
            </Section>
          ) : chainMissing.length > 0 ? (
            <Section title={<>3 &middot; Not available on {chainName} yet</>}>
              <p className="warn">
                <strong>{chainMissing.join(', ')}</strong>{' '}
                {chainMissing.length > 1 ? 'are' : 'is'} not deployed on {chainName}, so the drop
                address is withheld here rather than shown.
              </p>
              <p className="hint">
                The recipe is fine, and resolves to this same address on every chain — so it will not
                move once the contracts land. Switch to a chain without this label to fund it.
                <Tooltip title="Why the address is withheld">
                  An address is only worth having if something can act on it. Activation needs{' '}
                  <code>DropExecutor</code> and the step contracts; rescue needs{' '}
                  <code>COWShedExecutorFactory</code>. With those missing there is no path out, not even
                  for you.
                </Tooltip>
              </p>
            </Section>
          ) : labelTooLong ? (
            <Section title={<>3 &middot; Shorten the name</>}>
              <p className="warn">
                The name is {labelBytes(form.label.trim())} bytes and a drop stores{' '}
                {LABEL_MAX_BYTES}, so the address is withheld until it fits.
              </p>
              <p className="hint">
                Counted in UTF-8, not characters: an emoji is four bytes and an accented letter two.
                The name is part of the address, so this is not a display limit that could be relaxed
                later — the contract has one word to keep it in.
              </p>
            </Section>
          ) : ownerUnusable ? (
            <Section title={<>3 &middot; Set an owner first</>}>
              <p className="warn">
                The owner field is empty, so the drop address is withheld until you fill it in.
              </p>
              <p className="hint">
                Paste an address, or connect a wallet. The owner is part of the derivation, so setting it
                produces a different address — it cannot be added to a drop already funded.
                <Tooltip title="Why an owner is required">
                  Only the owner can recover a funded drop: both rescue paths check{' '}
                  <code>msg.sender == owner</code>. Left empty it falls back to the ecrecover precompile,{' '}
                  <code>{PLACEHOLDER_OWNER}</code>, which nobody holds the key to. Such a drop still funds
                  and activates — the money is simply unreachable.
                </Tooltip>
              </p>
            </Section>
          ) : (
            <>
              <Section title={<>3 &middot; Fund your drop address</>}>
                <DropAddress
                  address={compiled.value.address}
                  saved={saved}
                  onRemember={remember}
                  recipe={recipe}
                />
                {/*
                  * The pointer that pays for moving the step table to the end. Before funding is
                  * exactly when to read what you are funding, and the panel is now eight headings
                  * down — so the moment says where it is rather than relying on the number.
                  */}
                <p className="hint">
                  Before you send anything, step 8 shows what this address commits to.
                </p>
              </Section>

              <Section title={<>4 &middot; Monitor activation</>}>
                {isPayment && (
                  <PaymentPanel
                    recipe={recipe}
                    address={compiled.value.address}
                    deployment={compiled.value.deployment}
                    tokens={tokens}
                    account={account}
                    onMessage={setMessage}
                    onError={setError}
                  />
                )}
                {isConvert && (
                  <ConvertPanel
                    recipe={recipe}
                    address={compiled.value.address}
                    deployment={compiled.value.deployment}
                    tokens={tokens}
                    account={account}
                    onMessage={setMessage}
                    onError={setError}
                  />
                )}
                {status ? (
                  <>
                    {/*
                      * The verdict first, then the numbers behind it.
                      *
                      * This panel used to be three `label: value` lines, which made the reader derive
                      * the one thing they came for — can this run yet — from a balance and a boolean.
                      * The pill states it; the facts below are the evidence, not the answer.
                      */}
                    <DropState status={status} reusable={reusable} />

                    <dl className="facts">
                      {reusable === null && (
                        <>
                          <dt>Balance</dt>
                          <dd>
                            {formatUnits(status.balance, sellToken?.decimals ?? 18)}{' '}
                            {sellToken?.symbol ?? ''}
                            {status.nativeBalance > 0n && (
                              <span className="hint">
                                {' '}
                                + {formatUnits(status.nativeBalance, 18)} native
                              </span>
                            )}
                          </dd>
                        </>
                      )}

                      <dt>Deployed</dt>
                      <dd>{status.deployed ? 'yes' : 'not yet'}</dd>

                      {keeperUrl() !== null && (
                        <>
                          <dt>Keeper</dt>
                          <dd>
                            {keeperWatching === true
                              ? 'watching — it will activate once funded'
                              : keeperWatching === false
                                ? 'not handed over'
                                : 'unknown'}
                          </dd>
                        </>
                      )}
                    </dl>

                    {status.missing.length > 0 && (
                      <p className="hint warn-box">
                        {status.missing.join(' and ')} {status.missing.length > 1 ? 'are' : 'is'} not
                        deployed on {getDropChain(form.chainId)?.name ?? form.chainId} yet, so activation
                        will revert.
                        <Tooltip title="The address is still correct">
                          The cow-shed contracts a drop is derived from are already live and the
                          addresses are deterministic, so this drop address will not change once the
                          missing pieces are deployed.
                        </Tooltip>
                      </p>
                    )}
                  </>
                ) : (
                  <p className="hint">Reading chain state…</p>
                )}

                {/*
                  * Actions, then the places to go and look.
                  *
                  * Two rows rather than one, because they are two kinds of thing: a button changes
                  * something, a link leaves the page. Mixed together, "View on Gnosisscan" sat in the
                  * same row as "Activate drop" at the same weight, which is the wrong weight for both.
                  *
                  * What each button does hangs off the button, not off a list underneath it. The list
                  * repeated every button's name to say one sentence about it, so the panel carried its
                  * controls twice — once to press and once to read.
                  */}
                <div className="actions">
                  <Tooltip
                    title="Refresh"
                    trigger={<button onClick={() => void refresh()}>Refresh</button>}
                  >
                    Re-reads the balance and whether the drop is deployed, from the chain.
                  </Tooltip>

                  {/*
                    * A payment drop activates *with a token* and a convert drop *with a price*, both
                    * from the panel above. Plain activate reverts for either.
                    */}
                  {reusable === null && (
                    <Tooltip
                      title="Activate drop"
                      trigger={
                        <button
                          onClick={() => void onActivate()}
                          disabled={!account || busy || (status?.missing.length ?? 0) > 0}
                        >
                          {busy ? 'Activating…' : 'Activate drop'}
                        </button>
                      }
                    >
                      <span>
                        Deploys the drop and runs its recipe, now. Safe to press again: an
                        already-deployed drop simply re-runs its setup.
                      </span>
                      {/*
                        * Gated on the keeper existing, or this points at a button that is not on the
                        * page — the same rule the old explainer list had to follow.
                        */}
                      {keeperUrl() !== null && (
                        <span>
                          Or hand it to the keeper instead, and it activates on its own once the money
                          arrives.
                        </span>
                      )}
                    </Tooltip>
                  )}

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
                      <Tooltip
                        title="Stop keeper watching"
                        trigger={
                          <button onClick={() => void onUnregisterKeeper()} disabled={busy}>
                            Stop keeper watching
                          </button>
                        }
                      >
                        Only the watch ends. The drop keeps whatever it holds, anyone can still
                        activate it, and handing it back later resumes the watch.
                      </Tooltip>
                    ) : (
                      <Tooltip
                        title="Hand to keeper"
                        trigger={
                          <button onClick={() => void onRegisterKeeper()} disabled={busy}>
                            Hand to keeper
                          </button>
                        }
                      >
                        <span>
                          The keeper waits until the drop has a balance, then activates it unattended.
                        </span>
                        <span>
                          Or do it yourself, when you choose:{' '}
                          {isPayment
                            ? 'activate with a token, in the panel above.'
                            : isConvert
                              ? 'name a price and activate, in the panel above.'
                              : 'press Activate drop.'}
                        </span>
                      </Tooltip>
                    ))}

                  {/*
                    * Funding from another chain, as an alternative to sending to the address above. Not for
                    * a payment or convert request: the bridge receiver calls plain `activate`, which both
                    * refuse — neither can say which token arrived, and convert has no price either.
                    */}
                  {reusable === null && (
                    <Tooltip
                      title="Fund by bridging"
                      trigger={
                        <button onClick={() => onBridge(recipe)} disabled={busy}>
                          Fund by bridging
                        </button>
                      }
                    >
                      Send tokens from another chain. The bridge delivers into this address and runs
                      the recipe in the same transaction, so the order is live as soon as it lands.
                    </Tooltip>
                  )}
                </div>

                <div className="action-links">
                  {/* This panel is a snapshot; the feed of what has happened lives on its own tab. */}
                  <a href={routeHash({ tab: 'activity' })}>Activity</a>
                  <a
                    href={`${cowExplorer(dropChainId)}/address/${compiled.value.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Orders in CoW Explorer ↗
                  </a>
                  <a
                    href={`${blockExplorer(dropChainId).url}/address/${compiled.value.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {blockExplorer(dropChainId).name} ↗
                  </a>
                </div>

                {!account && (
                  <p className="hint">
                    <strong>Activating needs a connected wallet</strong>, only to pay the gas.
                    <Tooltip title="Activation">
                      It is permissionless: the transaction authorises nothing, and any account could
                      send it.
                    </Tooltip>
                  </p>
                )}

                {message && <p className="ok">{message}</p>}

                <TerminalPanel compiled={compiled.value} />
              </Section>


              {/*
                * Collapsed by default: an escape hatch for calls the recipe types do not cover, which
                * is to say almost never, and open it costs a screenful of ABI fields.
                */}
              <Section title={<>5 &middot; Add a custom step</>} open={false} optional>
                <p className="hint">
                  For calls the recipes above do not cover.
                  <Tooltip title="Custom step">
                    Every argument is a literal committed into the address, so it cannot depend on the
                    amount that arrives.
                  </Tooltip>
                </p>
                <StepBuilder
                  onAddStep={(step) => {
                    setImported({ ...recipe, steps: [...recipe.steps, step] })
                    setError(null)
                  }}
                  onError={setError}
                />
              </Section>

              {/*
                * Collapsed behind its heading, like the panels around it: the rescue paths are the
                * wrong answer to almost every question, and the panel used to fold itself away
                * *inside* this already titled section — two things to click, and two names for one
                * panel.
                */}
              <Section title={<>6 &middot; Recover your funds</>} open={false} optional className="rescue">
                <RescuePanel
                  compiled={compiled.value}
                  account={account}
                  deployed={status?.deployed ?? false}
                  sellToken={form.sellToken}
                  tokens={tokens}
                />
              </Section>

              <Section title={<>7 &middot; Manage the recipe</>} open={false} optional>
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
              </Section>

              {/*
                * Last, so the numbered run reads as the path: 1-4 are what everyone does, and
                * everything after is there when you want it.
                *
                * It sat at 4 because that is where it belongs in a careful reading — between getting
                * the address and funding it is exactly when you should check what you are funding —
                * but putting an optional panel in the middle of the mandatory run made all eight look
                * compulsory. The pointer from step 3 is what keeps the reading available.
                */}
              <Section title={<>8 &middot; Understand what the activation does</>} open={false} optional>
                <StepTable setupData={compiled.value.setupData} deployment={compiled.value.deployment} />
              </Section>
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
