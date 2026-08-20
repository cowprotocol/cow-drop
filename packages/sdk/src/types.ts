import type { Address, Hex } from 'viem'

/**
 * One call in a recipe. Mirrors cow-shed's `Call` struct exactly, including field order — the abi
 * encoding of these is what a drop address commits to, so the order is not ours to choose.
 */
export interface DropCall {
  target: Address
  value: bigint
  callData: Hex
  /** Let the recipe continue if this call reverts. */
  allowFailure: boolean
  /**
   * Run the target's code in the drop's context. Required for every step-contract primitive: that
   * is what makes `address(this)` the drop, so a step can read the balance that actually arrived.
   */
  isDelegateCall: boolean
}

/**
 * A compiled recipe. Its abi encoding is the `setupData` committed into the drop address.
 */
export interface Recipe {
  /** Free-form human tag, encoded as a right-padded bytes32. */
  label: string
  /**
   * The factory's user salt. Zero is the ordinary case; set it to get a second drop from an
   * otherwise identical recipe, or as a grinding space for a vanity address.
   */
  salt: Hex
  /** Run at most once per drop. Leave false for a reusable deposit address. */
  once: boolean
  calls: DropCall[]
}

/**
 * The four addresses that collectively define what a drop address is. Changing any of them
 * changes every drop address, which is why they travel together as one object rather than being
 * read from ambient config — and why they are versioned as a *generation* rather than updated in
 * place. See `GENERATIONS` in `generated/deployments.ts`.
 */
export interface DropAddresses {
  /** `COWShedExecutorFactory` — the CREATE2 deployer of every drop. */
  factory: Address
  /** `DropExecutor` — both the `trustedExecutor` and the `setupTarget` of every drop. */
  executor: Address
  /**
   * The step contracts, each the delegatecall target of the steps it hosts.
   *
   * Four rather than one because a step's target sits inside the committed bytes, so its address is
   * part of every drop address that reaches it. Splitting them by what they actually depend on means
   * adding a ComposableCoW handler no longer moves the guards or the rescue sweep. `guards` and
   * `tokenOps` take no constructor arguments at all, so their addresses track nothing but their own
   * code — which matters most for `tokenOps`, since it hosts `sweep`, the rescue primitive.
   */
  guardSteps: Address
  tokenSteps: Address
  presignSteps: Address
  twapSteps: Address
  stopLossSteps: Address
  /**
   * `CowOrderPoster` — the deployed helper a third-party contract uses to place a discrete order
   * and have `packages/watch-tower` post it.
   *
   * Not an input to any drop address: no recipe reaches it, because the step contracts inline the
   * `CowOrder` library instead. It belongs to the generation because it is the address integrators
   * build against, and that has to be recorded rather than rediscovered.
   */
  cowOrderPoster: Address
  /**
   * `DropBungeeReceiver` — the address a Bungee route delivers its destination payload to, which
   * forwards the tokens to the drop and activates it inside the bridge's own fill.
   *
   * Optional, and outside the commitment even more thoroughly than `cowOrderPoster`: no recipe
   * reaches it *and* it reaches no recipe, since all it does is call `activate`, which anyone may.
   * So a receiver can be added to a generation that already exists, and a generation predating it
   * simply has none — which is why this is the one address here that may be missing.
   */
  bungeeReceiver?: Address
  /**
   * `GPv2Settlement` and `ComposableCoW`. Not cow-drop's own contracts and not inputs to a drop
   * address — but they *are* constructor inputs to the step contracts, so they belong to the
   * generation. Carried so a rescue can retire live orders without an RPC round-trip.
   */
  settlement: Address
  composableCow: Address
  /** The shed implementation, which is baked into each drop's init code. */
  shedImplementation: Address
}

/** One generation of the contracts, resolved for one chain. */
export interface DropDeployment extends DropAddresses {
  chainId: number
  /**
   * Which deployment of the stack these addresses come from.
   *
   * A recipe is only reproducible if it records this. The addresses above are inputs to the drop's
   * CREATE2 derivation, so compiling the same recipe file against a later generation yields a
   * *different* drop address — and since a drop is funded before it exists, that is the difference
   * between recovering the funds and not.
   */
  generation: number
  /** `type(COWShedProxy).creationCode`, the other half of the init code. */
  proxyCreationCode: Hex
}

/** A price limit expressed as an exact fraction of atomic units: buy units per sell unit. */
export interface LimitPriceFraction {
  numerator: bigint
  denominator: bigint
}
