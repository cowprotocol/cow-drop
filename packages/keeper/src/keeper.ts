import { buildActivateTx, type DropDeployment, type DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Logger } from '@cowprotocol/cow-drop-watch-tower'
import { silentLogger } from '@cowprotocol/cow-drop-watch-tower'
import type { Address } from 'viem'

import type { KeeperChain, Submitter } from './chain.js'
import type { EventBus } from './events.js'
import { balancesDigest, pollTargets, selfDriving } from './hints.js'
import { evaluatePolicy } from './policy.js'
import type { PriceOracle } from './revenue.js'
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
  /** Injected, because the day a budget rolls over on is the thing most worth pinning in a test. */
  now?: () => number
  pollIntervalMs?: number
  /** Re-simulate a drop whose balances have not moved this often anyway. */
  resimulateIntervalMs?: number
  /** How often a `blind` recipe — nothing inferable to poll — is simulated regardless. */
  blindProbeIntervalMs?: number
  /** Cap per tick, so one crowded pass cannot starve the rest. Oldest poll goes first. */
  maxSimulationsPerTick?: number
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
    now = Date.now,
    pollIntervalMs = 12_000,
    resimulateIntervalMs = 5 * 60_000,
    blindProbeIntervalMs = 5 * 60_000,
    maxSimulationsPerTick = 25,
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

    // 3. One batched read for every balance this tick needs. A throw here aborts the tick with
    //    nothing written — see the note above on why an unread balance must not become a zero.
    const requests = live.flatMap((drop) =>
      pollTargets(drop.hints).map((token) => ({ token, holder: drop.address })),
    )
    const balances = await chain.getBalances(requests)

    // 4. Attribute the results, record them, and decide who is worth simulating.
    const candidates: { drop: RegisteredDrop; digest: string; balances: Record<string, bigint> }[] = []
    let cursor = 0

    for (const drop of live) {
      const targets = pollTargets(drop.hints)
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

      if (shouldSimulate(drop, digest, funded)) candidates.push({ drop, digest, balances: byToken })
    }

    // 5. Simulate, in staleness order, up to the cap.
    for (const { drop, digest, balances } of candidates.slice(0, maxSimulationsPerTick)) {
      await consider(drop, digest, balances, result)
    }

    return result
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
  ): Promise<void> {
    result.simulated++

    const call = buildActivateTx({ deployment, owner: drop.recipe.owner, setupData: drop.setupData })
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
    const revenueWei = await priceFee(drop, balances)

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

    await send(drop, { call, gasLimit, ...fees, costWei: verdict.costWei }, result)
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

      await store.update(chainId, drop.address, (current) => ({
        ...current,
        // A reusable drop goes back to watching: running again on the next arrival is the point of it.
        // Unless the activation registered a conditional order, which nothing here can see the end of.
        status: confirmed && once ? 'retired' : confirmed && parked ? 'activated' : 'watching',
        retiredReason: confirmed && once ? 'once-consumed' : current.retiredReason,
        // Those balances are committed to the order this activation signed, and they stay in the drop
        // until a solver settles it. Recorded so the next tick does not sign a second order for the
        // same money — see `shouldSimulate`.
        committedDigest: confirmed && !once && !parked ? current.lastSimulation?.balancesDigest : undefined,
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
  async function priceFee(drop: RegisteredDrop, balances: Record<string, bigint>): Promise<bigint | undefined> {
    if (!drop.fee || !prices) return undefined

    const sellAmount = balances[drop.fee.sellToken] ?? 0n
    if (sellAmount === 0n) return 0n

    const nativePrice = await prices.nativePrice(drop.fee.sellToken)
    if (nativePrice === undefined) return undefined

    return feeValueWei({ sellAmount, volumeBps: drop.fee.volumeBps, nativePrice })
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
