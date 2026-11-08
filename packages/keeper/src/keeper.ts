import {
  buildActivateConvertTx,
  CONVERT_HAIRCUT_BPS,
  convertMinimum,
  buildActivatePaymentTx,
  buildActivateTx,
  requiredPayment,
  type DropDeployment,
  type DropRecipeJson,
  type EvmCall,
} from '@cowprotocol/cow-drop-sdk'
import { getWrappedTokenForChain, type SupportedChainId } from '@cowprotocol/cow-sdk'
import type { Logger } from '@cowprotocol/cow-drop-watch-tower'
import { silentLogger } from '@cowprotocol/cow-drop-watch-tower'
import type { Address } from 'viem'

import type { KeeperChain, Submitter } from './chain.js'
import type { EventBus } from './events.js'
import { balancesDigest, pollTargets, selfDriving } from './hints.js'
import { evaluatePolicy } from './policy.js'
import type { PaymentQuoter, PriceOracle } from './revenue.js'
import { feeValueWei } from './revenue.js'
import { classifyRevert } from './reverts.js'
import { utcDay, type KeeperStore } from './store.js'
import type { PolicyRefusal, RegisteredDrop, SubsidyPolicy } from './types.js'

export interface KeeperOptions {
  chain: KeeperChain
  submitter: Submitter
  store: KeeperStore
  deployment: DropDeployment
  policy: SubsidyPolicy
  events: EventBus
  /**
   * Values a drop's promised fee in the chain's own currency. Required by `paying` mode, ignored
   * by the others.
   */
  prices?: PriceOracle
  /**
   * Prices a payment drop's incoming token against the owner's price. Without it a payment drop is
   * never activated in any token but its own `buyToken`, since nothing else can be shown to cover it.
   */
  quoter?: PaymentQuoter
  /** How far back a payment drop's first `Transfer` scan reaches, in blocks. */
  transferLookbackBlocks?: bigint
  /** The widest block range one `eth_getLogs` asks for. Public RPCs refuse wide ones. */
  maxTransferRange?: bigint
  /** Ranges per tick, so a keeper that was down a long time catches up over several ticks. */
  maxTransferChunksPerTick?: number
  /** Injected, because the day a budget rolls over on is the thing most worth pinning in a test. */
  now?: () => number
  pollIntervalMs?: number
  /** Re-simulate a drop whose balances have not moved this often anyway. */
  resimulateIntervalMs?: number
  /** How often a `blind` recipe — nothing inferable to poll — is simulated regardless. */
  blindProbeIntervalMs?: number
  /** Cap per tick, so one crowded pass cannot starve the rest. Oldest poll goes first. */
  maxSimulationsPerTick?: number
  /**
   * How far under the market a convert activation sets its order minimum. Defaults to the SDK's 100
   * bps, which is what the web panel offers, so the keeper does not quietly undercut what a user saw.
   */
  convertHaircutBps?: number
  /** Multiply the simulated gas by this before sending. */
  gasBuffer?: number
  /** No receipt after this long means the transaction is stuck. */
  receiptTimeoutMs?: number
  /** Prepare everything, broadcast nothing. Exercises the whole pipeline for free. */
  dryRun?: boolean
  logger?: Logger
}

export interface KeeperTickResult {
  considered: number
  simulated: number
  ready: number
  blocked: number
  sent: number
  confirmed: number
  retired: number
}

export interface Keeper {
  tick(): Promise<KeeperTickResult>
  run(signal?: AbortSignal): Promise<void>
  /** The oldest in-flight activation's block, so the watch tower's cursor can be rewound to it. */
  oldestPendingBlock(): Promise<bigint | undefined>
}

/**
 * Watch registered drops, activate the ones that are ready, pay the gas.
 *
 * ## Readiness is decided by simulation, not by reading the recipe
 *
 * A recipe can express conditions nothing off-chain can evaluate — `requireCallResult` carries opaque
 * inner calldata, a `raw` step is opaque entirely — so the gate is an `eth_call` of the activation
 * itself. That gets every guard right, plus `NothingToSell`, `AlreadyConsumed` and
 * `NoCodeAtDelegateTarget`, without this file understanding any of them. The balance poll exists only
 * to keep that call cheap.
 *
 * ## A failed tick costs a tick
 *
 * `run` catches everything and sleeps. Nothing in a tick advances a cursor, so a retry redoes the same
 * work — and the one thing a failed read must never do is persist, because recording an unread balance
 * as zero looks exactly like the money leaving.
 */
export function createKeeper(options: KeeperOptions): Keeper {
  const {
    chain,
    submitter,
    store,
    deployment,
    policy,
    events,
    prices,
    quoter,
    transferLookbackBlocks = 10_000n,
    maxTransferRange = 5_000n,
    maxTransferChunksPerTick = 10,
    now = Date.now,
    pollIntervalMs = 12_000,
    resimulateIntervalMs = 5 * 60_000,
    blindProbeIntervalMs = 5 * 60_000,
    maxSimulationsPerTick = 25,
    convertHaircutBps = CONVERT_HAIRCUT_BPS,
    gasBuffer = 1.25,
    receiptTimeoutMs = 3 * 60_000,
    dryRun = false,
    logger = silentLogger,
  } = options

  const chainId = deployment.chainId
  /** Belt to the store's braces: two ticks must never both act on one drop. */
  const inFlight = new Set<string>()

  /**
   * One pass over every active drop on this chain.
   *
   * The order matters: reconcile first (it frees budget and nonces), then retire the expired, then
   * one batched balance read for everyone left, and only then simulate — capped, staleness first.
   */
  async function tick(): Promise<KeeperTickResult> {
    const result: KeeperTickResult = {
      considered: 0,
      simulated: 0,
      ready: 0,
      blocked: 0,
      sent: 0,
      confirmed: 0,
      retired: 0,
    }

    const active = await store.active(chainId)
    result.considered = active.length

    // 1. Reconcile anything already in flight. Always first: it frees budget and nonces.
    for (const drop of active.filter((d) => d.pending)) {
      if (await reconcile(drop, result)) continue
    }

    const watching = (await store.active(chainId)).filter(
      (drop) => drop.status === 'watching' && !drop.pending && !inFlight.has(drop.address),
    )
    if (watching.length === 0) return result

    // 2. Retire anything whose committed deadline has genuinely passed.
    const live: RegisteredDrop[] = []
    for (const drop of watching) {
      if (drop.hints.notAfterIsHard && drop.hints.notAfter !== null && now() > drop.hints.notAfter * 1000) {
        await retire(drop, 'expired')
        result.retired++
        continue
      }
      live.push(drop)
    }
    if (live.length === 0) return result

    // 3. Payment drops name no sell token, so learn theirs from `Transfer` logs before polling.
    const paymentTokens = await discoverPayments(live)
    const targetsOf = (drop: RegisteredDrop) =>
      pollTargets(drop.hints, paymentTokens.get(drop.address) ?? drop.payment?.tokens ?? [])

    // 4. One batched read for every balance this tick needs. A throw here aborts the tick with
    //    nothing written — see the note above on why an unread balance must not become a zero.
    const requests = live.flatMap((drop) => targetsOf(drop).map((token) => ({ token, holder: drop.address })))
    const balances = await chain.getBalances(requests)

    // 5. Attribute the results, record them, and decide who is worth simulating.
    const candidates: {
      drop: RegisteredDrop
      digest: string
      balances: Record<string, bigint>
      paymentTokens: Address[]
    }[] = []
    let cursor = 0

    for (const drop of live) {
      const targets = targetsOf(drop)
      const mine = balances.slice(cursor, cursor + targets.length)
      cursor += targets.length

      const digest = balancesDigest(mine)
      const funded = mine.some((balance) => balance > 0n)
      const tokens: Record<Address, string> = {}
      const byToken: Record<string, bigint> = {}
      let native = '0'
      targets.forEach((token, index) => {
        const balance = mine[index] ?? 0n
        if (token === null) native = String(balance)
        else tokens[token] = String(balance)
        byToken[token ?? 'native'] = balance
      })

      const firstMoney = funded && !drop.everFunded
      await store.update(chainId, drop.address, (current) => ({
        ...current,
        lastPoll: { at: now(), native, tokens },
        everFunded: current.everFunded || funded,
        // A latch, not a comparison: any movement at all releases it, including the fill that empties
        // the drop. That is what lets a refund of exactly the committed amount read as new money.
        committedDigest: current.committedDigest === digest ? current.committedDigest : undefined,
        updatedAt: now(),
      }))

      if (firstMoney) {
        events.emit({ type: 'funded', chainId, drop: drop.address, owner: drop.owner, native, tokens })
      }

      if (shouldSimulate(drop, digest, funded)) {
        candidates.push({ drop, digest, balances: byToken, paymentTokens: paymentTokens.get(drop.address) ?? [] })
      }
    }

    // 5. Simulate, in staleness order, up to the cap.
    for (const { drop, digest, balances, paymentTokens: tokens } of candidates.slice(0, maxSimulationsPerTick)) {
      await consider(drop, digest, balances, result, tokens)
    }

    return result
  }

  /**
   * Read `Transfer` logs into payment drops, and remember every token seen arriving.
   *
   * A payment recipe names no sell token, so its hints cannot say what to poll. The logs can: whatever
   * a payer sent shows up as a `Transfer` to the drop. Each drop keeps its own `scannedTo`, but the
   * scan is one request per range for all of them, from the oldest cursor — a drop further ahead just
   * sees logs it has seen before, which only re-adds a token it already holds.
   *
   * A failed read throws out of the tick before anything is written, so a cursor never advances past
   * logs that were not read.
   *
   * @returns Each payment drop's tokens after this scan, by address.
   */
  async function discoverPayments(live: RegisteredDrop[]): Promise<Map<Address, Address[]>> {
    const tokensByDrop = new Map<Address, Address[]>()
    // Both open-ended recipes: neither names a sell token, so both learn it from `Transfer` logs.
    const payers = live.filter((drop) => openEnded(drop))
    if (payers.length === 0) return tokensByDrop

    const head = await chain.getBlockNumber()
    const firstScan = head > transferLookbackBlocks ? head - transferLookbackBlocks : 0n
    const startOf = (drop: RegisteredDrop) =>
      drop.payment?.scannedTo === undefined ? firstScan : BigInt(drop.payment.scannedTo) + 1n

    let from = payers.map(startOf).reduce((a, b) => (a < b ? a : b))
    let scannedTo: bigint | undefined
    const found = new Map<Address, Set<Address>>()

    for (let chunk = 0; chunk < maxTransferChunksPerTick && from <= head; chunk++) {
      const to = from + maxTransferRange - 1n < head ? from + maxTransferRange - 1n : head
      const transfers = await chain.getIncomingTransfers({
        to: payers.map((drop) => drop.address),
        fromBlock: from,
        toBlock: to,
      })
      for (const transfer of transfers) {
        const set = found.get(transfer.to) ?? new Set<Address>()
        set.add(transfer.token)
        found.set(transfer.to, set)
      }
      scannedTo = to
      from = to + 1n
    }

    for (const drop of payers) {
      const known = drop.payment?.tokens ?? []
      const fresh = [...(found.get(drop.address) ?? [])].filter((token) => !known.includes(token))
      const tokens = [...known, ...fresh]
      tokensByDrop.set(drop.address, tokens)

      const previous = drop.payment?.scannedTo === undefined ? undefined : BigInt(drop.payment.scannedTo)
      const advanced = scannedTo !== undefined && (previous === undefined || scannedTo > previous)
      if (fresh.length === 0 && !advanced) continue

      await store.update(chainId, drop.address, (current) => ({
        ...current,
        payment: {
          committed: {},
          ...current.payment,
          tokens,
          scannedTo: advanced ? String(scannedTo) : current.payment?.scannedTo,
        },
        updatedAt: now(),
      }))
      for (const token of fresh) {
        events.emit({ type: 'payment-detected', chainId, drop: drop.address, owner: drop.owner, token })
        logger.info(`payment drop ${drop.address} received ${token}`)
      }
    }

    return tokensByDrop
  }

  /**
   * The token a payment drop should be activated with this tick, or `undefined` if none pays.
   *
   * A token qualifies when its balance covers the owner's price at the market — a buy quote for
   * `buyAmount`, with the fee added since the drop's order is fee-less — and no live order already
   * holds that balance. The payer was asked for 50 bps more than the quote, which is what absorbs the
   * market moving between their quote and this one. A token the order book will not quote never
   * qualifies: spam sent to a payment address costs the keeper a quote, not a transaction.
   *
   * `drop` is the record as loaded at the start of the tick, so its `payment.tokens` may predate this
   * tick's scan — `tokens` is passed in for that reason.
   */
  /**
   * Whether a recipe leaves its sell token to whoever funds it.
   *
   * `payment` and `convert` differ in what they commit — a price, or nothing — but they poll, scan
   * and latch identically, because the thing neither can name in advance is the same thing.
   */
  function openEnded(drop: RegisteredDrop): boolean {
    return drop.hints.payment !== undefined || drop.hints.convert !== undefined
  }

  /**
   * Price one arrival at a convert drop: the balance, and the least the keeper will take for it.
   *
   * The whole of a convert drop's price protection. The recipe commits nothing, so a quote is not an
   * optimisation here — without one there is no number to put in the order, and the activation is
   * refused rather than sent at a price nobody checked.
   */
  async function chooseConvert(
    drop: RegisteredDrop,
    tokens: readonly Address[],
    balances: Record<string, bigint>,
  ): Promise<{ sellToken: Address; balance: bigint; minBuyAmount: bigint } | undefined> {
    const convert = drop.hints.convert
    if (!convert) return undefined
    const committedByToken = drop.payment?.committed ?? {}

    /*
     * Native, folded into the wrapper.
     *
     * `ConvertSteps` wraps the drop's native balance when the wrapper is the token being sold, so to
     * this keeper native *is* the wrapper: it is offered as a candidate even though no `Transfer`
     * announced it, and quoted at the combined amount, because that is the balance the order will
     * sell once the step has wrapped.
     */
    const nativeBalance = balances['native'] ?? 0n
    const wrapper = nativeBalance > 0n ? wrappedNativeOf(chainId) : undefined
    const candidates = wrapper && !tokens.includes(wrapper) ? [wrapper, ...tokens] : tokens
    const heldOf = (token: Address) => (balances[token] ?? 0n) + (token === wrapper ? nativeBalance : 0n)

    for (const token of candidates) {
      const balance = heldOf(token)
      if (balance === 0n) continue

      // Already sold at this balance and not yet settled: see `choosePayment` for why this latches
      // per token rather than on the whole digest.
      const committed = committedByToken[token]
      if (committed && committed.balance === String(balance) && now() < committed.until) continue

      if (token === convert.buyToken) {
        // Already in the buy token: the step forwards it untraded, so any positive minimum does.
        return { sellToken: token, balance, minBuyAmount: balance }
      }

      if (!quoter) continue
      const quote = await quoter.quoteSell({
        sellToken: token,
        buyToken: convert.buyToken,
        sellAmount: balance,
        from: drop.address,
        receiver: receiverOf(drop),
      })
      if (!quote || quote.buyAmount === 0n) continue

      try {
        return { sellToken: token, balance, minBuyAmount: convertMinimum(quote.buyAmount, convertHaircutBps) }
      } catch {
        // A quote so small the haircut rounds it to nothing. Not sellable at any honest price.
        continue
      }
    }
    return undefined
  }

  async function choosePayment(
    drop: RegisteredDrop,
    tokens: readonly Address[],
    balances: Record<string, bigint>,
  ): Promise<{ sellToken: Address; balance: bigint } | undefined> {
    const payment = drop.hints.payment
    if (!payment) return undefined
    const committedByToken = drop.payment?.committed ?? {}

    for (const token of tokens) {
      const balance = balances[token] ?? 0n
      if (balance === 0n) continue

      const committed = committedByToken[token]
      if (committed && committed.balance === String(balance) && now() < committed.until) continue

      let required: bigint | undefined
      if (token === payment.buyToken) {
        // Paid in the token the owner wants: nothing to trade, the step forwards it.
        required = BigInt(payment.buyAmount)
      } else if (quoter) {
        const quote = await quoter.quoteBuy({
          sellToken: token,
          buyToken: payment.buyToken,
          buyAmount: BigInt(payment.buyAmount),
          from: drop.address,
          receiver: receiverOf(drop),
        })
        required = quote ? requiredPayment(quote, 0) : undefined
      }

      if (required !== undefined && balance >= required) return { sellToken: token, balance }
      await reportUnderpaid(drop, token, balance, required)
    }
    return undefined
  }

  /** Emit `payment-underpaid` when what is known about a token's shortfall changes. */
  async function reportUnderpaid(
    drop: RegisteredDrop,
    token: Address,
    balance: bigint,
    required: bigint | undefined,
  ): Promise<void> {
    const key = `${balance}:${required ?? 'unquotable'}`
    if (drop.payment?.underpaid?.[token] === key) return

    await store.update(chainId, drop.address, (current) => ({
      ...current,
      payment: {
        tokens: [],
        committed: {},
        ...current.payment,
        underpaid: { ...current.payment?.underpaid, [token]: key },
      },
      updatedAt: now(),
    }))
    events.emit({
      type: 'payment-underpaid',
      chainId,
      drop: drop.address,
      owner: drop.owner,
      token,
      balance: String(balance),
      ...(required !== undefined ? { required: String(required) } : {}),
    })
    logger.info(
      required === undefined
        ? `payment drop ${drop.address} holds ${balance} of ${token}, which the order book will not quote`
        : `payment drop ${drop.address} holds ${balance} of ${token}; the price needs ${required}`,
    )
  }

  /**
   * Whether this drop is worth an `eth_call` this tick.
   *
   * This is the whole cost control: without it a funded-but-not-ready drop would be simulated every
   * tick forever. Money moving is the main trigger; time is the fallback, and the only one a blind
   * recipe has.
   */
  function shouldSimulate(drop: RegisteredDrop, digest: string, funded: boolean): boolean {
    if (drop.backoff.nextAttemptAt > now()) return false
    if (drop.hints.notBefore !== null && now() < drop.hints.notBefore * 1000) return false
    // Money already committed to a live order. `presignSellAll` sizes an order at whatever balance it
    // finds, so activating again on the same funds signs a second order that the first one's fill makes
    // unfillable — bought with the keeper's gas. Once that order can no longer fill the balance is free
    // again, whether or not anything moved.
    if (drop.committedDigest === digest && !lastOrderDead(drop)) return false

    const last = drop.lastSimulation
    // A blind recipe has nothing to watch, so time is the only trigger it has.
    if (drop.hints.blind) return !last || now() - last.at >= blindProbeIntervalMs
    if (!funded) return false

    // The whole cost control. Without it a funded-but-not-ready drop — one waiting on a time window
    // or a `requireCallResult` — costs an `eth_call` every tick, forever.
    if (!last) return true
    if (last.balancesDigest !== digest) return true
    return now() - last.at >= resimulateIntervalMs
  }

  /**
   * Whether the order the last activation signed can no longer fill.
   *
   * `validTo` is the last four bytes of the uid, and `activations[].orderUids` already holds it — so
   * the deadline costs no request and no new state. Before the watch tower has posted there is no uid
   * to read, and the recipe's own validity window stands in; it is measured from the receipt rather
   * than from the block the contract measured it in, which errs late, which is the safe direction for
   * a gate that stops money being committed twice.
   *
   * Without this half, an order that expires unfilled would leave a drop holding an untouched balance
   * that nothing releases — the latch only opens on movement, and nothing moved.
   */
  function lastOrderDead(drop: RegisteredDrop): boolean {
    const activation = drop.activations.at(-1)
    if (!activation) return true

    // The latest deadline of the lot, not the last one recorded: a recipe with two presign steps posts
    // two orders, and the commitment lasts as long as any of them can still fill.
    const posted = (activation.orderUids ?? []).map((uid) => Number.parseInt(uid.slice(-8), 16) * 1000)
    const deadline =
      posted.length > 0
        ? Math.max(...posted)
        : activation.at + committedValiditySeconds(drop.recipe) * 1000

    return now() >= deadline
  }

  /**
   * Simulate one drop, and if it passes, decide whether to pay for it.
   *
   * `balances` is what *this tick* read, not what the record says. The record was loaded before the
   * poll wrote to it, so reading `lastPoll` here would see the previous tick's numbers — or none at
   * all on the first pass, which would price every fee at zero.
   */
  async function consider(
    drop: RegisteredDrop,
    digest: string,
    balances: Record<string, bigint>,
    result: KeeperTickResult,
    /** For a payment drop, the tokens this tick's scan knows it received. */
    paymentTokens: readonly Address[] = [],
  ): Promise<void> {
    result.simulated++

    let call: EvmCall
    let paying: { sellToken: Address; balance: bigint } | undefined
    if (drop.hints.convert) {
      const converting = await chooseConvert(drop, paymentTokens, balances)
      if (!converting) {
        // Same shape as the payment miss: recorded as a failed simulation so the digest gate holds
        // the drop until a balance moves or `resimulateIntervalMs` passes, which re-quotes it.
        await store.update(chainId, drop.address, (current) => ({
          ...current,
          lastSimulation: {
            at: now(),
            ok: false,
            balancesDigest: digest,
            revert: 'nothing here can be priced into an order',
          },
          updatedAt: now(),
        }))
        return
      }
      paying = { sellToken: converting.sellToken, balance: converting.balance }
      call = buildActivateConvertTx({
        deployment,
        owner: drop.recipe.owner,
        setupData: drop.setupData,
        sellToken: converting.sellToken,
        minBuyAmount: converting.minBuyAmount,
      })
    } else if (drop.hints.payment) {
      paying = await choosePayment(drop, paymentTokens, balances)
      if (!paying) {
        // Recorded like a failed simulation, so the digest gate holds the drop until a balance moves
        // or `resimulateIntervalMs` passes — which is also how often an underpaid token is re-quoted.
        await store.update(chainId, drop.address, (current) => ({
          ...current,
          lastSimulation: { at: now(), ok: false, balancesDigest: digest, revert: 'no payment covers the price' },
          updatedAt: now(),
        }))
        return
      }
      call = buildActivatePaymentTx({
        deployment,
        owner: drop.recipe.owner,
        setupData: drop.setupData,
        sellToken: paying.sellToken,
      })
    } else {
      call = buildActivateTx({ deployment, owner: drop.recipe.owner, setupData: drop.setupData })
    }

    const payer = await submitter.payer()
    const simulation = await chain.simulateActivation({ call, from: payer })

    if (!simulation.ok) {
      const revert = classifyRevert(simulation.revertData, simulation.message)

      await store.update(chainId, drop.address, (current) => ({
        ...current,
        lastSimulation: { at: now(), ok: false, balancesDigest: digest, revert: revert.detail },
        updatedAt: now(),
      }))

      if (revert.class === 'terminal') {
        await retire(drop, 'terminal-revert')
        result.retired++
      } else if (revert.class === 'blocked') {
        await block(drop, 'cost-too-high', revert.detail, now() + 60 * 60_000)
        result.blocked++
      } else if (drop.lastSimulation?.revert !== revert.detail) {
        // Only log a *change* of reason, or a drop waiting on a time window fills the log.
        logger.info(`drop ${drop.address} not ready: ${revert.detail}`)
      }
      return
    }

    await store.update(chainId, drop.address, (current) => ({
      ...current,
      lastSimulation: { at: now(), ok: true, gas: String(simulation.gas), balancesDigest: digest },
      updatedAt: now(),
    }))
    result.ready++

    const fees = await chain.getFees()
    const gasLimit = (simulation.gas * BigInt(Math.round(gasBuffer * 1000))) / 1000n
    const day = utcDay(now())
    const spend = await store.spendOn(day)
    const revenueWei = await priceFee(drop, balances, paying)

    const verdict = evaluatePolicy({
      policy,
      owner: drop.owner,
      fee: drop.fee,
      revenueWei,
      gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      payerBalanceWei: await submitter.balance(),
      spentTodayWei: spend.totalWei,
      spentTodayByOwnerWei: spend.byOwner.get(drop.owner) ?? 0n,
      now: now(),
    })

    events.emit({
      type: 'ready',
      chainId,
      drop: drop.address,
      owner: drop.owner,
      gas: String(simulation.gas),
      estimatedCostWei: String(gasLimit * fees.maxFeePerGas),
    })

    if (!verdict.allowed) {
      await block(drop, verdict.reason, verdict.detail, verdict.retryAt)
      result.blocked++
      return
    }

    await send(drop, { call, gasLimit, ...fees, costWei: verdict.costWei, paying }, result)
  }

  /**
   * Broadcast an activation and record it.
   *
   * Signs first so the hash exists before anything leaves the process, which is what makes the
   * write-ahead ordering possible: record, debit the budget, then broadcast. A broadcast that throws
   * refunds the debit and backs the drop off.
   */
  async function send(
    drop: RegisteredDrop,
    plan: {
      call: ReturnType<typeof buildActivateTx>
      gasLimit: bigint
      maxFeePerGas: bigint
      maxPriorityFeePerGas: bigint
      costWei: bigint
      /** For a payment drop, the token and balance this activation commits. */
      paying?: { sellToken: Address; balance: bigint }
    },
    result: KeeperTickResult,
  ): Promise<void> {
    if (dryRun) {
      logger.info(`[dry run] would activate drop ${drop.address} for ~${plan.costWei} wei`)
      return
    }

    // Check *and* set, synchronously: two ticks can both reach here having each read the drop as
    // `watching`, and nothing between them has awaited yet.
    if (inFlight.has(drop.address)) return
    inFlight.add(drop.address)

    try {
      const payer = await submitter.payer()
      const nonce = await chain.getTransactionCount(payer)
      const head = await chain.getBlockNumber()

      // Sign first: this yields the hash before anything leaves the process, which is what lets the
      // record be written *before* the broadcast rather than after it.
      const prepared = await submitter.prepare({
        call: plan.call,
        gasLimit: plan.gasLimit,
        maxFeePerGas: plan.maxFeePerGas,
        maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
        nonce,
      })

      // Write ahead, then debit, then broadcast. Over-counting a transaction that never goes out is
      // the safe direction — reconciliation refunds it — whereas under-counting means a crash loop
      // can spend past the daily budget.
      await store.update(chainId, drop.address, (current) => ({
        ...current,
        status: 'activating',
        blockedReason: undefined,
        blockedUntil: undefined,
        pending: {
          ref: prepared.ref,
          nonce,
          gasLimit: String(plan.gasLimit),
          maxFeePerGas: String(plan.maxFeePerGas),
          reservedWei: String(plan.costWei),
          sentAt: now(),
          sentAtBlock: String(head),
          replacements: 0,
          ...(plan.paying
            ? { sellToken: plan.paying.sellToken, sellBalance: String(plan.paying.balance) }
            : {}),
        },
        updatedAt: now(),
      }))
      await store.record(utcDay(now()), drop.owner, plan.costWei)

      try {
        await submitter.broadcast(prepared)
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        await store.record(utcDay(now()), drop.owner, -plan.costWei)
        await store.update(chainId, drop.address, (current) => ({
          ...current,
          status: 'watching',
          pending: undefined,
          backoff: { failures: current.backoff.failures + 1, nextAttemptAt: backoffUntil(current) },
          updatedAt: now(),
        }))
        events.emit({ type: 'activation-failed', chainId, drop: drop.address, owner: drop.owner, stage: 'send', detail })
        logger.error(`could not broadcast for drop ${drop.address}: ${detail}`)
        return
      }

      result.sent++
      events.emit({
        type: 'activation-sent',
        chainId,
        drop: drop.address,
        owner: drop.owner,
        hash: prepared.ref,
        estimatedCostWei: String(plan.costWei),
      })
      logger.info(`activating drop ${drop.address} in tx ${prepared.ref}`)
    } finally {
      inFlight.delete(drop.address)
    }
  }

  /** Resolve an in-flight activation. Returns true when the drop still has one. */
  async function reconcile(drop: RegisteredDrop, result: KeeperTickResult): Promise<boolean> {
    const pending = drop.pending
    if (!pending) return false

    const receipt = await chain.getReceipt(pending.ref)

    if (receipt) {
      // Settle the reservation against what it actually cost.
      const actual = receipt.costWei
      await store.record(utcDay(now()), drop.owner, actual - BigInt(pending.reservedWei))

      const confirmed = receipt.status === 'success'
      const once = drop.recipe.once === true
      const parked = selfDriving(drop.recipe)
      // An open-ended drop latches per token rather than on the whole digest: a second token arriving
      // must not release the first token's order, and the first must not hold the second back.
      const paidWith = confirmed && openEnded(drop) ? pending.sellToken : undefined

      await store.update(chainId, drop.address, (current) => ({
        ...current,
        // A reusable drop goes back to watching: running again on the next arrival is the point of it.
        // Unless the activation registered a conditional order, which nothing here can see the end of.
        status: confirmed && once ? 'retired' : confirmed && parked ? 'activated' : 'watching',
        retiredReason: confirmed && once ? 'once-consumed' : current.retiredReason,
        // Those balances are committed to the order this activation signed, and they stay in the drop
        // until a solver settles it. Recorded so the next tick does not sign a second order for the
        // same money — see `shouldSimulate`.
        committedDigest:
          confirmed && !once && !parked && !openEnded(drop) ? current.lastSimulation?.balancesDigest : undefined,
        ...(paidWith && current.payment
          ? {
              payment: {
                ...current.payment,
                committed: {
                  ...current.payment.committed,
                  [paidWith]: {
                    balance: pending.sellBalance ?? '0',
                    // Measured from the receipt, which errs late — the safe direction for a gate that
                    // stops one payment being sold twice.
                    until: now() + committedValiditySeconds(drop.recipe) * 1000,
                  },
                },
              },
            }
          : {}),
        pending: undefined,
        backoff: { failures: 0, nextAttemptAt: 0 },
        activations: [
          ...current.activations,
          {
            ref: pending.ref,
            status: confirmed ? 'confirmed' : 'reverted',
            at: now(),
            blockNumber: String(receipt.blockNumber),
            costWei: String(actual),
          },
        ],
        updatedAt: now(),
      }))

      if (confirmed) {
        result.confirmed++
        events.emit({
          type: 'activation-confirmed',
          chainId,
          drop: drop.address,
          owner: drop.owner,
          hash: pending.ref,
          blockNumber: String(receipt.blockNumber),
          costWei: String(actual),
        })
        if (once) {
          result.retired++
          events.emit({ type: 'retired', chainId, drop: drop.address, owner: drop.owner, reason: 'once-consumed' })
        }
      } else {
        // A revert after a passing simulation means the state moved in between — somebody else
        // activated it, or an oracle rolled. Normal, and the gas was still spent.
        events.emit({
          type: 'activation-failed',
          chainId,
          drop: drop.address,
          owner: drop.owner,
          hash: pending.ref,
          stage: 'receipt',
          detail: 'the activation reverted on chain',
        })
      }
      return true
    }

    if (now() - pending.sentAt < receiptTimeoutMs) return true

    // Past the timeout with no receipt. If the nonce has moved on, something else used it and this
    // transaction is dead; otherwise it is genuinely stuck and this build gives up rather than
    // fee-bumping, which is the honest limit of a first version.
    const payer = await submitter.payer()
    const nonce = await chain.getTransactionCount(payer)
    const dead = nonce > pending.nonce

    await store.record(utcDay(now()), drop.owner, -BigInt(pending.reservedWei))
    await store.update(chainId, drop.address, (current) => ({
      ...current,
      status: 'watching',
      pending: undefined,
      activations: [...current.activations, { ref: pending.ref, status: 'dropped', at: now() }],
      backoff: { failures: current.backoff.failures + 1, nextAttemptAt: backoffUntil(current) },
      updatedAt: now(),
    }))
    events.emit({
      type: 'activation-failed',
      chainId,
      drop: drop.address,
      owner: drop.owner,
      hash: pending.ref,
      stage: 'stuck',
      detail: dead ? 'the nonce was used by another transaction' : 'no receipt before the timeout',
    })
    return true
  }

  /** Take a drop out of the rotation for good — expired, consumed, or reverting terminally. */
  async function retire(drop: RegisteredDrop, reason: RegisteredDrop['retiredReason']): Promise<void> {
    await store.update(chainId, drop.address, (current) => ({
      ...current,
      status: 'retired',
      retiredReason: reason,
      updatedAt: now(),
    }))
    events.emit({ type: 'retired', chainId, drop: drop.address, owner: drop.owner, reason: reason ?? 'expired' })
  }

  /** Park a drop we could activate but will not pay for, and say why. */
  async function block(
    drop: RegisteredDrop,
    reason: PolicyRefusal,
    detail: string,
    retryAt?: number,
  ): Promise<void> {
    const changed = drop.blockedReason !== reason
    await store.update(chainId, drop.address, (current) => ({
      ...current,
      status: 'watching',
      blockedReason: reason,
      blockedUntil: retryAt,
      updatedAt: now(),
    }))

    // Only on a change of reason. This is the UI's cue to say "activate it yourself", not a heartbeat.
    if (changed) {
      events.emit({
        type: 'blocked',
        chainId,
        drop: drop.address,
        owner: drop.owner,
        reason,
        detail,
        retryAt,
      })
      logger.warn(`not paying for drop ${drop.address}: ${detail}`)
    }
  }

  /**
   * What the drop's promised fee is worth right now, in wei.
   *
   * `undefined` means it could not be valued, which `paying` mode treats as a refusal rather than a
   * zero: a token the order book will not price is one we cannot say is worth subsidising, not one we
   * know is worthless.
   *
   * The volume is the balance this tick read. That is the sell amount only approximately — the order
   * is sized at activation and the balance can move in between — which is exactly why
   * `minRevenueRatio` sits above 1 rather than at it.
   */
  async function priceFee(
    drop: RegisteredDrop,
    balances: Record<string, bigint>,
    /** The token and amount this activation settled on, for a recipe that names neither in advance. */
    chosen?: { sellToken: Address; balance: bigint },
  ): Promise<bigint | undefined> {
    if (!drop.fee || !prices) return undefined

    /*
     * Which token carries the volume depends on what the recipe committed.
     *
     * A payment drop fixes the price, so its own `buyAmount` is the volume whatever pays for it. A
     * convert drop fixes nothing — the volume is only known once a balance has been chosen — so it is
     * valued against that balance, in the token actually being sold. Everything else sells a token
     * the recipe names, and the balance of it is the volume.
     */
    const valued = drop.hints.payment
      ? { token: drop.fee.sellToken, amount: BigInt(drop.hints.payment.buyAmount) }
      : drop.hints.convert && chosen
        ? { token: chosen.sellToken, amount: chosen.balance }
        : { token: drop.fee.sellToken, amount: balances[drop.fee.sellToken] ?? 0n }

    if (valued.amount === 0n) return 0n

    const nativePrice = await prices.nativePrice(valued.token)
    if (nativePrice === undefined) return undefined

    return feeValueWei({ sellAmount: valued.amount, volumeBps: drop.fee.volumeBps, nativePrice })
  }

  /** Exponential backoff after a failed send, capped at ten minutes. */
  function backoffUntil(drop: RegisteredDrop): number {
    const failures = Math.min(drop.backoff.failures + 1, 8)
    return now() + Math.min(2 ** failures * 1000, 10 * 60_000)
  }

  return {
    tick,

    async run(signal) {
      logger.info(`watching for drops ready to activate${dryRun ? ' (dry run)' : ''}`)

      while (!signal?.aborted) {
        try {
          await tick()
        } catch (error) {
          // Kept alive on purpose: an RPC outage should cost a tick, not the process. Nothing was
          // persisted, so the next pass redoes the same work.
          logger.error(`tick failed, retrying: ${error instanceof Error ? error.message : String(error)}`)
        }
        await sleep(pollIntervalMs, signal)
      }
    },

    async oldestPendingBlock() {
      const blocks = (await store.active(chainId))
        .map((drop) => drop.pending?.sentAtBlock)
        .filter((block): block is string => block !== undefined)
        .map(BigInt)
      return blocks.length === 0 ? undefined : blocks.reduce((a, b) => (a < b ? a : b))
    },
  }
}

/** Who a payment drop pays: the step's receiver, defaulting to the owner as `compileRecipe` does. */
function receiverOf(drop: RegisteredDrop): Address {
  const step = drop.recipe.steps.find((candidate) => candidate.type === 'payment')
  return ((step?.type === 'payment' ? step.receiver : undefined) ?? drop.recipe.owner) as Address
}

/** What the SDK's own templates default an order's lifetime to, and the fallback below with it. */
const DEFAULT_ORDER_VALIDITY_SECONDS = 30 * 60

/**
 * The longest order lifetime the recipe commits to, in seconds.
 *
 * Only ever the fallback for `lastOrderDead`, and only until a uid exists to read the real deadline
 * from. A recipe naming no validity has no presign step and therefore no order to wait out, so the
 * default here bounds nothing more than how long such a drop stays gated after an activation whose
 * order the watch tower never managed to post.
 */
function committedValiditySeconds(recipe: DropRecipeJson): number {
  const committed = recipe.steps
    // A recipe's numbers are `number | string` — it is JSON a client wrote, and a seconds figure that
    // arrived as `"1800"` commits exactly as long as one that arrived as `1800`.
    .map((step) => Number((step as { validitySeconds?: number | string }).validitySeconds))
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0)

  return committed.length > 0 ? Math.max(...committed) : DEFAULT_ORDER_VALIDITY_SECONDS
}

/** A sleep that wakes early when the signal aborts, so shutdown does not wait out a poll interval. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // Already aborted means the `abort` event has fired and will not fire again — without this the
  // loop would sit out a whole poll interval before noticing it had been asked to stop.
  if (signal?.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })

    /** Resolves once, whichever of the timer or the abort gets there first. */
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
  })
}

/**
 * The token that wraps this chain's native currency, lowercased.
 *
 * Read from cow-sdk, which is the same data `ConvertSteps` reads on-chain from CoW's ETH Flow. They
 * agree on every chain CoW serves; if they ever did not, the keeper would name a sell token the step
 * declines to wrap and the activation would simply find nothing to sell — a missed activation, never
 * a wrong one.
 */
function wrappedNativeOf(chainId: number): Address | undefined {
  const token = getWrappedTokenForChain(chainId as SupportedChainId)
  return token ? (token.address.toLowerCase() as Address) : undefined
}
