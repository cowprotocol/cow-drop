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
   * Run the target's code in the drop's context. Required for every `DropRecipes` primitive: that
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
 * read from ambient config.
 */
export interface DropDeployment {
  chainId: number
  /** `COWShedExecutorFactory` — the CREATE2 deployer of every drop. */
  factory: Address
  /** `DropExecutor` — both the `trustedExecutor` and the `setupTarget` of every drop. */
  executor: Address
  /** `DropRecipes` — the delegatecall target for recipe primitives. */
  recipes: Address
  /** The shed implementation, which is baked into each drop's init code. */
  shedImplementation: Address
  /** `type(COWShedProxy).creationCode`, the other half of the init code. */
  proxyCreationCode: Hex
}

/** A price limit expressed as an exact fraction of atomic units: buy units per sell unit. */
export interface LimitPriceFraction {
  numerator: bigint
  denominator: bigint
}
