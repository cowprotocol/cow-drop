import {
  BungeeDropProvider,
  blockingSummary,
  checksFailingEverywhere,
  deliveryCapability,
  describeExecution,
  isUnsafeQuote,
  sendableTransaction,
  summarise,
  type BridgeProvider,
  type BridgeProviderInfo,
  type BridgeQuote,
  type BridgeRoutes,
  type BridgeToken,
  type CheckId,
  type CheckOutcome,
  type DeliveryCapability,
  type Verification,
} from '@cowprotocol/cow-drop-bridging'
import {
  compileRecipe,
  describeRecipe,
  directDelivery,
  bungeeDelivery,
  type CompiledRecipe,
  type DropRecipeJson,
  type OnFailure,
} from '@cowprotocol/cow-drop-sdk'
import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem'

import { chainLabel, getPublicClient, sendTransaction } from './chain.js'

/**
 * Funding a drop across a bridge.
 *
 * The drop end of this needs nothing special: a drop address is fundable before it exists, so a
 * bridge can simply pay it and a keeper activates when the money lands.
 *
 * What this module adds on top of the bridging package is the app's half of *verification*. A bridge
 * API's answer is untrusted input, and the sequence here reflects that: list every route with a
 * verdict, build only the one that was chosen, check the bytes that came back, and hand the wallet
 * nothing that has not passed. The library owns the checks it can make offline; a few can only be made
 * here, because they need an RPC or the wallet's own state.
 */

/**
 * Chains a bridge route can start from.
 *
 * Bungee's supported set, narrowed to chains cow-sdk can describe — `chainInfo` needs an entry to
 * build a viem chain from. Note these are *source* chains and need no cow-drop deployment: the drop
 * lives on the destination, and all the source chain does is send one transaction.
 */
export const BRIDGE_SOURCE_CHAINS: readonly number[] = [1, 10, 100, 137, 8453, 42161, 43114]

/**
 * The bridge providers this build can quote through.
 *
 * One today. It is a registry rather than a bare singleton because the seam is already in the library
 * — `BridgeProvider` describes a destination as "an address plus a payload", which is not Bungee-
 * specific — and because a person choosing a provider should be able to see that the choice exists.
 */
const PROVIDERS: readonly BridgeProvider[] = [new BungeeDropProvider()]

export const BRIDGE_PROVIDERS: readonly BridgeProviderInfo[] = PROVIDERS.map((provider) => provider.info)

export const DEFAULT_BRIDGE_PROVIDER = BRIDGE_PROVIDERS[0]?.key ?? 'bungee'

/** The provider for a key, falling back to the default rather than throwing inside a render. */
function providerFor(key: string): BridgeProvider {
  return PROVIDERS.find((provider) => provider.info.key === key) ?? (PROVIDERS[0] as BridgeProvider)
}

/** Provider metadata for a key, or null when a stored key names one this build no longer has. */
export function providerInfo(key: string): BridgeProviderInfo | null {
  return BRIDGE_PROVIDERS.find((info) => info.key === key) ?? null
}

export type {
  BridgeQuote,
  BridgeRoutes,
  BridgeToken,
  CheckOutcome,
  DeliveryCapability,
  Verification,
}
export { blockingSummary, checksFailingEverywhere, describeExecution, sendableTransaction, summarise }

/**
 * How the money is delivered on the destination chain.
 *
 * - `direct` — the bridge pays the drop address itself and nothing runs on arrival. Works with every
 *   bridge, and nothing can be stolen, because a drop address belongs to exactly one recipe. Somebody
 *   still has to activate it; that is the keeper's job.
 * - `atomic` — the bridge pays a shared receiver and carries the recipe as its payload, so the order
 *   goes live inside the fill. Only a bridge that has been *watched* running a destination payload can
 *   do this, and none has been, so this mode is currently offered by nothing.
 *
 * See `docs/BRIDGING.md`.
 */
export type DeliveryMode = 'direct' | 'atomic'

/** What the selected provider can be trusted to run on arrival. Local, and cheap enough to call in a render. */
export function capabilityOf(providerKey: string): DeliveryCapability {
  return providerFor(providerKey).deliveryCapability()
}

/** Whether any bridge has been watched running a destination payload. Gates the atomic option. */
export function atomicAvailable(providerKey: string): boolean {
  return capabilityOf(providerKey).atomicAvailable
}

/**
 * The token the bridge has to deliver, read out of the recipe.
 *
 * This is the recipe's **sell** token, and the distinction matters: a bridge-and-swap has two legs,
 * and the bridge's output is the drop's input. Getting it from the compiled bytes rather than from a
 * form field means it is whatever the drop address actually commits to, however the recipe was
 * written — a hand-built `raw` step included.
 */
export function deliveredTokenOf(compiled: CompiledRecipe): Address | null {
  const described = describeRecipe(compiled.setupData, compiled.deployment)

  for (const step of described.steps) {
    const arg = step.known?.args.find((candidate) => candidate.name === 'sellToken')
    if (typeof arg?.value === 'string') return arg.value as Address
  }
  return null
}

export interface BridgePlan {
  compiled: CompiledRecipe
  /** Where the money lands. */
  drop: Address
  /** The chain the drop lives on — the recipe's, never the wallet's. */
  destinationChainId: number
  /** What the bridge must deliver for the recipe to have anything to sell. */
  deliveredToken: Address
}

/** Everything about the destination, derived from the recipe alone. Cheap, and never quotes. */
export function planFrom(recipe: DropRecipeJson): BridgePlan {
  const compiled = compileRecipe(recipe)
  const deliveredToken = deliveredTokenOf(compiled)

  if (!deliveredToken) {
    throw new Error('this recipe names no sell token, so there is nothing for a bridge to deliver into it')
  }

  return {
    compiled,
    drop: compiled.address,
    destinationChainId: compiled.deployment.chainId,
    deliveredToken,
  }
}

/**
 * The tokens a bridge can actually deliver on the destination chain.
 *
 * Asked before quoting, because the chain list is far more permissive than the routes behind it and
 * the first sign of an unreachable pair would otherwise be an empty route list — which reads like a
 * failure rather than like a pair that was never going to work. In direct mode the question is much
 * easier and almost everything answers yes.
 */
export async function deliverableTokens(params: {
  sellChainId: number
  sellToken: Address
  buyChainId: number
  mode: DeliveryMode
  providerKey: string
}): Promise<BridgeToken[] | null> {
  try {
    // Asked for the mode that will actually be quoted. Direct reaches far more pairs, so asking the
    // atomic question would report perfectly good routes as unreachable.
    return await providerFor(params.providerKey).getDeliverableTokens({
      sellChainId: params.sellChainId,
      sellToken: params.sellToken,
      buyChainId: params.buyChainId,
      executesPayload: params.mode === 'atomic',
    })
  } catch {
    // Advisory only. If the provider will not answer this, quoting is still allowed to try.
    return null
  }
}

/** The destination half of a delivery, which is cow-drop's business rather than the bridge's. */
function destinationFor(plan: BridgePlan, mode: DeliveryMode, onFailure: OnFailure) {
  // `onFailure` only exists in atomic mode — direct delivery has no failure branch, because there is
  // no receiver holding anything to fall back with.
  return mode === 'direct' ? directDelivery(plan.compiled) : bungeeDelivery(plan.compiled, { onFailure })
}

export interface RouteRequest {
  plan: BridgePlan
  sender: Address
  sellChainId: number
  sellToken: Address
  sellAmount: bigint
  mode: DeliveryMode
  onFailure: OnFailure
  providerKey: string
}

/**
 * Every route the provider offers, each with a verdict.
 *
 * Nothing is built here, so a disabled route costs one line in a list rather than a transaction in
 * memory. `expectedRecipe` is the assertion that matters most: it lets the library re-derive the drop
 * address from the payload's own bytes and refuse a destination that names a different one.
 */
export async function listBridgeRoutes(params: RouteRequest): Promise<BridgeRoutes> {
  const { plan } = params

  return providerFor(params.providerKey).getRoutes({
    sender: params.sender,
    sellChainId: params.sellChainId,
    sellToken: params.sellToken,
    sellAmount: params.sellAmount,
    buyChainId: plan.destinationChainId,
    buyToken: plan.deliveredToken,
    destination: destinationFor(plan, params.mode, params.onFailure),
    expectedRecipe: plan.compiled,
  })
}

/** One route, built and checked. Throws `unsafe-quote` before building if the route was disabled. */
export async function buildAndVerifyRoute(params: {
  routes: BridgeRoutes
  routeId: string
  providerKey: string
}): Promise<BridgeQuote> {
  return providerFor(params.providerKey).buildQuote(params.routes, params.routeId)
}

/** Where a person watches the bridge leg. */
export function bridgeExplorerUrl(hash: Hex, providerKey?: string): string {
  return providerFor(providerKey ?? DEFAULT_BRIDGE_PROVIDER).explorerUrl(hash)
}

/** Has the quoted price stopped being a quoted price? Seconds, because that is what bridges use. */
export function isQuoteExpired(quote: BridgeQuote, nowMs: number = Date.now()): boolean {
  return quote.expiresAt * 1000 <= nowMs
}

/**
 * What the app knows and the library cannot.
 *
 * Three of these need an RPC or the wallet, so they cannot live beside the offline checks — but they
 * belong in the *same list* on screen. A user reading one list of verdicts is being told the truth
 * once; a user reading a list plus three warnings scattered around a form is being asked to assemble
 * it themselves.
 */
export function walletChecks(params: {
  quote: BridgeQuote
  walletChainId: number | null
  balance: bigint | null
  sellAmount: bigint
  allowance: bigint | null
  symbol: string
}): CheckOutcome[] {
  const { quote, walletChainId, balance, sellAmount, allowance } = params
  const checks: CheckOutcome[] = []
  const target = quote.transactionSummary.chainId

  checks.push(
    walletChainId === null
      ? {
          check: 'tx-chain',
          severity: 'blocking',
          state: 'unknown',
          detail: 'your wallet did not report which network it is on',
        }
      : walletChainId === target
        ? {
            check: 'tx-chain',
            severity: 'blocking',
            state: 'pass',
            detail: `your wallet is on ${chainLabel(target)}, where this transaction has to be sent`,
          }
        : {
            check: 'tx-chain',
            severity: 'blocking',
            state: 'fail',
            detail: `your wallet is on ${chainLabel(walletChainId)} and this must be sent on ${chainLabel(target)}`,
            problem: { check: 'tx-chain', requested: target, built: walletChainId },
          },
  )

  // Unknown, never zero. An unreadable balance is not evidence of an empty account.
  checks.push(
    balance === null
      ? {
          check: 'sell-amount-in-calldata',
          severity: 'blocking',
          state: 'unknown',
          detail: `your ${params.symbol} balance could not be read, so whether you hold enough is unknown`,
        }
      : balance >= sellAmount
        ? {
            check: 'sell-amount-in-calldata',
            severity: 'blocking',
            state: 'pass',
            detail: `you hold enough ${params.symbol} to send this`,
          }
        : {
            check: 'sell-amount-in-calldata',
            severity: 'blocking',
            state: 'fail',
            detail: `this sends ${sellAmount} atoms and you hold ${balance}`,
            problem: { check: 'sell-amount-in-calldata', amount: sellAmount },
          },
  )

  if (quote.approval) {
    const needed = quote.approval.amount
    checks.push(
      allowance === null
        ? {
            check: 'approval-amount',
            severity: 'blocking',
            state: 'unknown',
            detail:
              `your allowance to ${quote.approval.spender} could not be read through the public RPC, so ` +
              `whether the router may move your ${params.symbol} is unknown — which is not the same as yes`,
          }
        : allowance >= needed
          ? {
              check: 'approval-amount',
              severity: 'blocking',
              state: 'pass',
              detail: `${quote.approval.spender} is already allowed to move this much ${params.symbol}`,
            }
          : {
              check: 'approval-amount',
              severity: 'blocking',
              state: 'fail',
              detail: `an approval is needed first: allowed ${allowance}, needs ${needed}`,
              problem: { check: 'approval-amount', expected: needed, actual: allowance },
            },
    )
  }

  return checks
}

/**
 * Does the source chain accept this transaction at all?
 *
 * Advisory, and the wording has to stay honest about two things: a public RPC failing to answer is not
 * evidence of a bad transaction, and a source chain accepting a bridge deposit says *nothing* about
 * what happens on the destination chain. This is the check most likely to be over-read.
 */
export async function simulationCheck(params: {
  quote: BridgeQuote
  account: Address
}): Promise<CheckOutcome> {
  const { to, data, value, chainId } = params.quote.transactionSummary

  try {
    await getPublicClient(chainId).estimateGas({ account: params.account, to, data, value })
    return {
      check: 'tx-chain',
      severity: 'advisory',
      state: 'pass',
      detail:
        'simulated from your account against the current head without reverting. That is the source ' +
        'chain only — it says nothing about what happens where the money lands.',
    }
  } catch (cause) {
    return {
      check: 'tx-chain',
      severity: 'advisory',
      state: 'unknown',
      detail:
        `the simulation did not complete (${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}). ` +
        `An RPC that will not answer is not evidence either way.`,
    }
  }
}

/**
 * What the bridge is already allowed to move.
 *
 * Returns null when it cannot be read. A source chain here needs no cow-drop deployment and may be
 * served by an RPC this app has no override for — and an unreadable allowance must be reported as
 * unknown rather than treated as zero *or* as sufficient. It used to silently enable the send.
 */
export async function readBridgeAllowance(params: {
  chainId: number
  token: Address
  owner: Address
  spender: Address
}): Promise<bigint | null> {
  try {
    return await getPublicClient(params.chainId).readContract({
      address: params.token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [params.owner, params.spender],
    })
  } catch {
    return null
  }
}

/**
 * The account's balance of the token it is about to bridge.
 *
 * Read through the public RPC, so it does not need the wallet on the source chain — the network only
 * has to match to *send*. Returns null when it cannot be read: a source chain needs no cow-drop
 * deployment and may be served by an endpoint this app has no override for, and an unreadable balance
 * should show as unknown rather than as zero.
 */
export async function readTokenBalance(params: {
  chainId: number
  token: Address
  owner: Address
}): Promise<bigint | null> {
  try {
    return await getPublicClient(params.chainId).readContract({
      address: params.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [params.owner],
    })
  } catch {
    return null
  }
}

/** Approve exactly what this bridge asked for, rather than an unlimited allowance. */
export async function approveBridge(params: {
  account: Address
  chainId: number
  approval: NonNullable<BridgeQuote['approval']>
}): Promise<Hex> {
  const { approval } = params

  return sendTransaction({
    chainId: params.chainId,
    account: params.account,
    to: approval.token,
    // Encoded from viem's own ERC20 ABI, which this file already imports and reads with. This was
    // hand-rolled hex for a while, on the stated grounds of avoiding an ABI import that was in fact
    // three lines above it.
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [approval.spender, approval.amount] }),
    value: 0n,
  })
}

/**
 * Send the bridge transaction the provider built.
 *
 * Two refusals stand between a quote and a wallet, and neither is a UI concern:
 *
 * `sendableTransaction` throws unless every blocking check passed. It is the only way to get calldata
 * out of a quote, so no caller — including one written later, by someone who never read this — can
 * hand a wallet bytes that failed verification.
 *
 * The expiry check is here rather than only in a component because a built transaction can sit in
 * memory indefinitely while somebody reads the page, switches network and approves a token. A stale
 * quote is a stale price.
 */
export async function sendBridge(params: { account: Address; quote: BridgeQuote }): Promise<Hex> {
  if (isQuoteExpired(params.quote)) {
    throw new BridgeExpired()
  }

  const transaction = sendableTransaction(params.quote)

  return sendTransaction({
    chainId: transaction.chainId,
    account: params.account,
    to: transaction.to,
    data: transaction.data,
    value: transaction.value,
  })
}

/** Thrown rather than returned, so an expired quote cannot be sent by ignoring a boolean. */
class BridgeExpired extends Error {
  readonly code = 'expired'

  constructor() {
    super('this transaction was built against a quote that has expired and must be rebuilt')
  }
}

/**
 * A bridge failure, as a sentence.
 *
 * Lives here beside the codes rather than in the tab, because the mapping is about the library's
 * vocabulary and because `unsafe-quote` must render the library's own wording — a route disabled in a
 * list and a send refused at the button are the same fact, and wording them differently makes them
 * read as two separate problems.
 */
export function describeBridgeError(cause: unknown): string {
  if (isUnsafeQuote(cause)) {
    return blockingSummary(cause.details) ?? 'this route did not pass verification'
  }

  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code: unknown }).code

    // The provider answering "no routes" is a successful response, not a failed one — say so, or the
    // next move looks like "retry" when it is actually "pick a different chain or token".
    if (code === 'no-routes') {
      return 'the bridge answered, with nothing to offer: no route it has covers this pair at this amount. Try another source chain, another token, or a larger amount.'
    }
    if (code === 'no-eligible-routes') {
      return 'every route offered for this delivery is disabled. Deliver straight to the drop instead — that works through any bridge.'
    }
    if (code === 'route-expired') return 'that route’s quote expired before it could be built — get fresh routes'
    if (code === 'route-not-found') return 'that route is no longer in the list — get fresh routes and pick again'
    if (code === 'expired') return 'the quote expired before this was sent — rebuild it and check it again'
    if (code === 'quote-failed') return 'the bridge rejected the quote request — the pair or amount may be unsupported'
    if (code === 'build-failed') return 'the quote expired before it could be built — get a fresh one'
    if (code === 'unreachable') return 'the bridge API could not be reached'
  }
  return cause instanceof Error ? cause.message : String(cause)
}

/** The check ids the app renders a title for. Keeps the titles in one place rather than per row. */
export const CHECK_TITLES: Readonly<Record<CheckId, string>> = {
  'destination-execution': 'This bridge can run the recipe on arrival',
  'output-token': 'Delivers the token the recipe sells',
  'output-chain': 'Delivers on the drop’s chain',
  'input-token': 'Sends the token you chose',
  'input-amount': 'Sends the amount you chose',
  'receiver-echo': 'The bridge will pay the address we named',
  'user-echo': 'Quoted for your account',
  'route-expiry': 'The quoted price is still current',
  'tx-chain': 'Sent on the right network',
  'receiver-in-calldata': 'The destination is in the bytes you sign',
  'payload-in-calldata': 'The recipe travels with the money',
  'calldata-length': 'The transaction is big enough to carry the recipe',
  'sell-amount-in-calldata': 'The amount is in the bytes you sign',
  'approval-token': 'Approves the token being bridged',
  'approval-user': 'The approval is yours to give',
  'approval-amount': 'Approves no more than is being bridged',
  'route-identity': 'Built for the route you selected',
  'direct-receiver': 'Pays the drop and nothing in between',
  'delivery-target': 'The destination belongs to this recipe',
}
