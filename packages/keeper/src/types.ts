import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import type { Address, Hex } from 'viem'

/**
 * Where a registered drop is in its life.
 *
 * `activating` is the one that matters: it is written *before* anything is broadcast, and nothing
 * re-simulates or re-sends a drop in that state. It is how a crash between "we decided to spend money"
 * and "we spent it" is ruled out rather than recovered from.
 */
export type DropStatus =
  /** The normal state: polling balances, simulating when a balance makes it plausible. */
  | 'watching'
  /** An activation is prepared or broadcast and not yet reconciled. */
  | 'activating'
  /**
   * Handed over to a conditional order and no longer polled.
   *
   * Only for a recipe that registers with ComposableCoW — see `selfDriving`. Those drops are driven by
   * CoW's own watch tower over a balance that keeps moving, and nothing here can tell an exhausted
   * schedule from a running one, so re-simulating would register a second schedule over the remainder
   * of the first. A drop whose recipe signs discrete orders goes back to `watching` instead, gated by
   * `committedDigest`.
   */
  | 'activated'
  /** The policy or the budget refused to pay. Re-examined at `blockedUntil`. */
  | 'blocked'
  /** No longer polled. The record — and the recipe — is kept. See `retiredReason`. */
  | 'retired'

export type RetiredReason = 'once-consumed' | 'expired' | 'never-funded' | 'terminal-revert' | 'unregistered'

/** Why the keeper declined to pay for an activation it could otherwise have sent. */
export type PolicyRefusal =
  | 'denylisted'
  | 'not-allowlisted'
  | 'cost-too-high'
  | 'fee-cap-exceeded'
  | 'daily-budget-exhausted'
  | 'owner-budget-exhausted'
  | 'payer-balance-low'
  /** `paying` mode: the recipe promises the keeper nothing. */
  | 'no-fee'
  /** It promises something, but less than `minFeeBps`. */
  | 'fee-too-small'
  /** The order book would not price the sell token, so the fee cannot be valued. */
  | 'unpriceable'
  /** The fee is real and does not cover the gas by `minRevenueRatio`. */
  | 'revenue-below-gas'

/**
 * What the recipe suggests is worth polling.
 *
 * **A hint, never a gate.** Guards are evaluated by simulating the activation, because a recipe can
 * express conditions no decoder can read — `requireCallResult` leaves its inner calldata undecoded and
 * a `raw` step is opaque entirely. So everything here only decides whether an `eth_call` is worth
 * spending, and being wrong costs latency rather than correctness.
 */
export interface WatchHints {
  /** ERC20 tokens a sell-side step names. What `balanceOf(drop)` gets called for. */
  tokens: Address[]
  /** Read the native balance too — a `wrapNative`, or a `requireMinBalance` on the zero address. */
  native: boolean
  /** Minimums by token, with the zero address meaning native. Advisory, as above. */
  minBalance: Record<Address, string>
  notBefore: number | null
  notAfter: number | null
  /**
   * Whether `notAfter` may retire the drop.
   *
   * True only when exactly one `requireTimeWindow` exists, it is not `allowFailure`, and every step
   * decoded. With two windows, or one behind `allowFailure`, or any step the SDK could not name,
   * `notAfter` is not a bound on the drop and retiring on it would stop watching a live one.
   */
  notAfterIsHard: boolean
  /** Nothing could be inferred — an all-`raw` recipe. Simulated on a slow timer instead. */
  blind: boolean
  /** Everything the decoder refused to name, surfaced to the operator and the UI. */
  warnings: string[]
}

/** A transaction the keeper has committed to, recorded before any bytes leave the process. */
export interface PendingActivation {
  /** The transaction hash, known from signing — see `Submitter`. */
  ref: Hex
  nonce: number
  gasLimit: string
  maxFeePerGas: string
  /** Debited from the budget at prepare time, settled from the receipt. */
  reservedWei: string
  sentAt: number
  /**
   * The head when it went out. The watch tower's cursor is rewound to this on restart, or a restart
   * between broadcast and scan skips the block the activation landed in and loses its orders.
   */
  sentAtBlock: string
  replacements: number
}

export interface ActivationRecord {
  ref: Hex
  status: 'confirmed' | 'reverted' | 'dropped'
  at: number
  blockNumber?: string
  costWei?: string
  revert?: string
  /** Order uids the watch tower later posted for this activation. */
  orderUids?: Hex[]
}

/**
 * One drop the keeper is looking after.
 *
 * Every wei-scale number is a decimal **string**, for the reason `fileCursor` gives: JSON has no
 * bigint, and a figure that decides how much money to spend must not round.
 */
export interface RegisteredDrop {
  /** Lowercased. Primary key with `chainId` — a checksum difference is not a different drop. */
  address: Address
  chainId: number
  generation: number
  owner: Address
  label: string
  /**
   * The recipe as registered.
   *
   * This is the only server-side copy of the bytes that can recover the funds, which is why a retired
   * record is kept rather than deleted — see `apps/web/src/lib/storage.ts` on why losing them loses
   * the money for everyone, the owner included.
   */
  recipe: DropRecipeJson
  /** `abi.encode(Recipe)`, recompiled here. Never accepted from a client. */
  setupData: Hex
  status: DropStatus
  hints: WatchHints
  /** Which SDK derived `hints`. Re-derived when it differs, so an old lossy inference is not pinned. */
  hintsVersion: string
  registeredAt: number
  updatedAt: number
  /** The last *successful* read. A failed read must never write this — see the tick loop. */
  lastPoll?: { at: number; native: string; tokens: Record<Address, string> }
  /** Ever seen a non-zero balance. Drives the never-funded retention rule. */
  everFunded: boolean
  lastSimulation?: {
    at: number
    ok: boolean
    gas?: string
    /** Unchanged balances mean no reason to re-run. This is the whole cost control. */
    balancesDigest: string
    revert?: string
  }
  /**
   * The balances that produced the last confirmed activation, while they are still committed to the
   * order it signed.
   *
   * A reusable drop's money does not leave at activation: the pre-signature is on-chain but the order
   * settles later, so the balance a `presignSellAll` was sized against is still sitting there. Set at
   * reconciliation and released the moment a poll sees a different digest — a latch rather than a
   * comparison, so that a refund of exactly the committed amount still counts as new money.
   */
  committedDigest?: string
  /** The last refusal, so `blocked` is emitted on a change of reason rather than every tick. */
  blockedReason?: PolicyRefusal
  blockedUntil?: number
  /**
   * The fee this recipe promises the keeper, verified against the committed `appData` hash when it
   * was registered. Absent means the recipe promises nothing.
   */
  fee?: { volumeBps: number; recipient: Address; appData: Hex; sellToken: Address }
  /**
   * The appData documents behind the recipe's committed hashes, keyed by hash.
   *
   * Held for two jobs at once: verifying the fee, and giving the watch tower something to upload —
   * the order book rejects an appData hash it has never seen, so an order with a custom document
   * cannot be posted without it.
   */
  appDataDocuments?: Record<Hex, string>
  pending?: PendingActivation
  /** Newest last. */
  activations: ActivationRecord[]
  retiredReason?: RetiredReason
  backoff: { failures: number; nextAttemptAt: number }
}

/**
 * Who the keeper will pay for.
 *
 * ## `perOwnerDailyBudgetWei` is close to decorative in `mode: 'all'`
 *
 * `owner` is a field of a recipe anyone may submit, and minting a fresh one per registration is free.
 * So in `all` mode the only cap that really binds is `dailyBudgetWei`. Keep it to a number you would
 * not mind losing daily. The per-owner cap earns its place in `allowlist` mode, where the owner set is
 * fixed by configuration rather than by the caller.
 */
export interface SubsidyPolicy {
  /**
   * Who gets subsidised.
   *
   * - `all` — everyone, bounded only by the budgets. The permissive demo posture.
   * - `allowlist` — a fixed set of owners, chosen by configuration rather than by the caller.
   * - `paying` — anyone whose recipe pays the keeper more than the activation costs. The only mode
   *   whose limit is economic rather than administrative, and so the only one that scales to
   *   strangers without an attacker being able to spend your budget on nothing.
   */
  mode: 'all' | 'allowlist' | 'paying'
  /** Paid for in `allowlist` mode. Lowercased at load. Ignored in `all`. */
  allowlist: Address[]
  /** Never paid for, in either mode. Checked first. */
  denylist: Address[]
  /**
   * The cap on one activation, in **wei** — `gasLimit × maxFeePerGas`.
   *
   * Deliberately not gas units. A units cap does not bound the spend: the same 300k gas costs thirty
   * times more in a fee spike, and a cap that moves with the gas price is not a cap.
   */
  maxCostPerActivationWei: bigint
  /** A fee spike should pause the keeper, not drain it one capped transaction at a time. */
  maxFeePerGasWei: bigint
  dailyBudgetWei: bigint
  perOwnerDailyBudgetWei: bigint
  /** Stop sending below this, so the key can be topped up before a run is left half-finished. */
  minPayerBalanceWei: bigint

  // --- `paying` mode ----------------------------------------------------------------------------

  /** The address a recipe's `partnerFee` must name. Defaults to the keeper's own payer. */
  feeRecipient?: Address
  /** Refuse a fee below this, so dust promises do not qualify. */
  minFeeBps: number
  /**
   * How many times the gas the fee must be worth.
   *
   * Above 1 because an estimate is an estimate: the sell amount can shrink before the order fills,
   * the price can move, and a fee that only just covers the gas covers nothing after either.
   */
  minRevenueRatio: number
}

export type PolicyVerdict =
  | { allowed: true; costWei: bigint }
  | { allowed: false; reason: PolicyRefusal; detail: string; retryAt?: number }
