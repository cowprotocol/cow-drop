# `@cowprotocol/cow-drop-sdk` API

The full function reference, and the things worth knowing before you use them. Install and build
instructions are in the [README](README.md).

## The 30-second version

```ts
import { compileRecipe, buildActivateTx, twapOnArrival } from '@cowprotocol/cow-drop-sdk'

// 1. Describe what should happen to the money.
const recipe = twapOnArrival({
  chainId: 100,
  owner: '0xYourAddress',            // can always recover the funds
  sellToken: WXDAI,
  buyToken: COW,
  parts: 12,
  partDuration: 3600,                // one part per hour
  limitPrice: { price: '45', sellDecimals: 18, buyDecimals: 18 },
  minAmount: 1000n * 10n ** 18n,     // refuse to start on a part-delivered balance
})

// 2. Get the address. Nothing is deployed yet; this is pure computation.
const { address, setupData, deployment } = compileRecipe(recipe)

// 3. Send funds to `address` — bridge, exchange withdrawal, plain transfer.

// 4. Anyone can then run it. No signature, no privileged sender.
const tx = buildActivateTx({ deployment, owner: recipe.owner, setupData })
await walletClient.sendTransaction(tx)
```

## Recipes

| | |
|---|---|
| `compileRecipe(json, deployment?)` | The one you'll use. Recipe file → `{ address, setupData, recipe, deployment }`. Validates as it goes and throws on anything ambiguous. |
| `swapOnArrival(params)` | Template: sell whatever lands here, once, at a limit price. Reusable — later arrivals get sold too. |
| `twapOnArrival(params)` | Template: split whatever lands here into parts and sell over time. One-shot. |
| `stopLossOnArrival(params)` | Template: sell whatever lands here once a feed pair crosses a strike. One-shot, and self-driving — the watch tower polls the condition. |
| `steps.*` | Build individual steps by hand: `presignSellAll`, `presignSellAllAtOracle`, `twapFromBalance`, `stopLossFromBalance`, `requireCallResult`, `requireMinBalance`, `requireTimeWindow`, `wrapNative`, `approveMax`, `approveBalance`, `sweep`, and `raw` for anything else. |
| `describeRecipe(setupData, deployment)` | The inverse: committed bytes → named steps, decoded arguments, and warnings. See below. |

All three templates take the same optional guards (`minAmount`, `notBefore`, `notAfter`), and
`swapOnArrival` takes an optional `oracle` which turns its `limitPrice` into a floor the feed may only
tighten.

A *template* is a function; a *recipe* is what it returns and what the address commits to. The
distinction is useful in code and not worth making a user learn, so the UI says "recipe" throughout.
Both templates default `receiver` to the `owner` — proceeds in your wallet rather than piling up in
the drop. Pass the zero address to leave them in the drop instead.

Each `steps.*` builder takes only the deployment field naming the contract that hosts it —
`Pick<DropDeployment, 'guardSteps'>` for a guard, and so on. The step contracts are four separate
deployments because a step's target is part of the drop address, so asking a guard for
`deployment.twapSteps` would be a lie about what moves that guard's address.

## Addresses and encoding

| | |
|---|---|
| `deriveDropAddress({ deployment, owner, setupData })` | The CREATE2 derivation, off-chain. This is why the UI can quote an address as you type. |
| `encodeRecipe(recipe)` / `decodeRecipe(setupData)` | The abi encoding the address actually commits to. Structural only — for meaning, use `describeRecipe`. |
| `getDeployment(chainId, generation?)` | The addresses that define what a drop address is. `generation` defaults to `LATEST_GENERATION`; `GENERATIONS` holds them all. Throws for an unsupported chain, and distinctly for an unknown generation. |

## Transactions and orders

| | |
|---|---|
| `buildActivateTx({ deployment, owner, setupData })` | `{ to, data, value }` for deploying the drop and running its recipe. Idempotent — safe to send twice. |
| `parseOrderPlacement(log, { chainId, settlement })` | Decode an `OrderPlacement` event into the order that was placed, with the owner taken from the field its scheme puts it in and the uid recomputed. |
| `toOrderBookPayload(order)` | That order as a `POST /api/v1/orders` body, forwarding the scheme and signature the event carried. |
| `parseExtraData(extraData)` | The `int64 quoteId ++ uint32 validTo` the `data` field carries, or `undefined` if it is some other length. |
| `ORDER_PLACEMENT_TOPIC` | The `topic0` to filter `getLogs` by. The only filter an indexer needs. |
| `ORDER_INVALIDATION_TOPIC` | The companion event's `topic0`. |

`OrderPlacement` is **CoW's own event**, not cow-drop's: EthFlow has emitted it since it shipped, and
`autopilot` already parses it. It is redeclared in
`contracts/src/interfaces/ICoWSwapOnchainOrders.sol` only because ethflowcontract is not a dependency of
this repository, with the topic0 pinned to EthFlow's by a contract test. So decoding is against
`ONCHAIN_ORDERS_ABI` rather than any particular emitter's ABI — EthFlow's own logs decode here — and an
indexer filters on `ORDER_PLACEMENT_TOPIC` alone; `packages/watch-tower` is that indexer.

## Order hashing

The announcement carries no order uid: the owner is in `sender` (pre-signed) or `signature.data`
(ERC-1271), and the digest is the consumer's to compute. These do that.

| | |
|---|---|
| `cowDomainSeparator(chainId, settlement)` | `GPv2Settlement.domainSeparator()`, derived rather than fetched. |
| `hashCowOrder(order, domainSeparator)` | The EIP-712 digest. Mirrors `LibCowOrder.hash`. |
| `orderUidFor(order, owner, domainSeparator)` | `orderDigest ++ owner ++ validTo`, the 56 bytes the settlement contract keys signatures by. |
| `packOrderUid(digest, owner, validTo)` | The packing on its own. |
| `ownerOfOrderUid(uid)` | The owner in the middle 20 bytes of an order uid. |
| `COW_ORDER_TYPE_HASH` | `GPv2Order.TYPE_HASH`, built from the type string. |

This is a second implementation of a formula whose ground truth is Solidity, and the drift is silent —
a wrong digest means checking the pre-signature of an order that never existed, finding none, and
posting nothing. So every function here is asserted against fixtures generated by the compiled contract;
see `contracts/script/Fixtures.s.sol` and `src/derivation.test.ts`.

## Rescue

For when a drop's recipe can never succeed — funds arrived late, or a condition stopped holding.

| | |
|---|---|
| `buildRescueForState(…)` | The one to use. Picks the right path from whether the drop is deployed, and returns `{ tx, path }`. |
| `buildRescueTx(…)` | Drop not deployed: `initializeProxyWithoutSetup` — deploy at the same address, skip the recipe, sweep atomically. |
| `buildOwnerSweepTx(…)` | Drop deployed: `trustedExecuteHooks`, since the owner is the shed's admin. |
| `buildDeployOnlyTx(…)` | Deploy the shed, skip the recipe, do nothing else — then operate it as a normal cow-shed. |
| `buildSweepCalls(…)` | The `Call[]` those take: one `sweep` per token, zero address for native. |
| `buildRevokeCalls(…)` | Retire what the drop already placed: `ComposableCoW.remove` per conditional order, `setPreSignature(uid, false)` per pre-signed one. Pass as `revoke` to the builders above. |
| `parseConditionalOrdersCreated(logs, composableCow)` | The order hashes a rescue needs, from the activation receipt. They cannot be computed beforehand — the hash covers the amount that arrived. |

**A sweep alone does not end a drop's trading.** A registered conditional order stays authorised until
removed and a pre-signature stays valid until it expires, so an address swept mid-TWAP will still trade
whatever lands there next. Keep the hashes from the activation receipt alongside the recipe file; they
are the only way to retire the order later.

All owner-only, none needing a signature. Prefer designing the recipe so rescue is unnecessary — a
`requireTimeWindow` with a `notAfter`, or a deadline branch that lets the setup succeed trivially.

## Prices

| | |
|---|---|
| `limitPriceToFraction(price, sellDecimals, buyDecimals)` | `'0.95'` → an exact integer fraction. |

Prices are never floats. The result is committed into an address, so a rounding difference between
your code and the SDK would produce a *different address*, not a slightly different price.

## Two things that will bite you otherwise

**The recipe file is not the commitment — it is the key.** The compiled `setupData` bytes are what the
address commits to, and the file is the only reproducible way back to them. Change any value — the
label, the `once` flag, one digit of the price — and you get a different address.

That makes losing a recipe fatal, not inconvenient. `activate` needs those exact bytes, and so does
`initializeProxyWithoutSetup`, the owner's rescue hatch. `DropTriggered` emits only their hash, and a
drop that has never been activated left nothing else on-chain. So: **fund a drop, lose its recipe before
activating it, and nobody can recover the money — the owner included, because the owner needs the same
bytes as everyone else.** Keep the file. (After a first activation the bytes are recoverable from the
deploying transaction's calldata, which helps only in hindsight.)

**`salt` and `orderSalt` are different things.** The recipe's `salt` is the factory's user salt: it
moves the drop address, and exists so the same parameters can yield more than one drop (or so you can
grind a vanity address without putting junk in `label`). The `twapFromBalance` step's `orderSalt` is
the ComposableCoW conditional-order discriminator, and does not affect the address at all.

**Guards are steps, not settings.** `requireMinBalance` and `requireTimeWindow` are ordinary steps
committed into the address, so nobody activating your drop can skip them. Put a `minAmount` on any
one-shot recipe that a bridge might fund in tranches; without it, the first tranche to land sizes the
whole schedule. Ordering affects what a guard measures, not whether it binds — the recipe is atomic,
so a guard anywhere in the list unwinds the whole activation.

## Reading a recipe back

`describeRecipe(setupData, deployment)` turns committed bytes into named steps with decoded arguments.
It exists because activation is permissionless and unsigned: the *only* safeguard for someone about to
send money to a drop is re-deriving the address from a recipe they understand, and undecoded calldata
reduces that to trusting a hex blob.

So the output worth reading is `warnings`, per step. A step it cannot name is not an error — `raw`
exists on purpose — but it has to be reported as a gap rather than rendered as though understood:

| warning | why |
|---|---|
| target is not a step contract | its meaning cannot be shown, so a funder is trusting the bytes |
| delegatecall to a non-step contract | runs foreign code *as the drop*: it can move any balance and rewrite the shed's storage, including the admin the owner's rescue depends on |
| step contract as a plain call | `address(this)` would be the step contract, whose balance is always zero, so the step reverts or quietly does nothing |
| `allowFailure` | the activation can complete having skipped the step |

Targets are resolved against the generation you pass. A step pointing at a *different* generation's
contracts comes back unknown, which is correct — those addresses host different code, and naming the
step from this generation's ABI could describe it wrongly.

## Generations, and why a recipe file pins one

`DropRecipeJson.generation` says which deployment of the contracts a file was compiled against, and it
is what makes the file reproducible. Every address in a `DropDeployment` feeds the CREATE2 preimage of
the drop, so compiling the same file against a later generation yields a *different* address — and since
a drop is funded before it exists and the file is the only way back to the funds, that is the difference
between recovering them and not.

It defaults to **1**, not to `LATEST_GENERATION`. A file written before the field existed was compiled
against generation 1, and defaulting to the latest would silently repoint it. Everything this package
exports pins the field explicitly.

## Constants are generated, not written

`src/generated/` comes from the foundry build via `scripts/generate-constants.mjs`. The shed
implementation address and the proxy creation code both feed the CREATE2 init code, so a stale
hand-copied value would mean quoting addresses the contracts will never deploy to. Run `pnpm generate`
after any contract change. It reads every `contracts/deployments/gen*/` directory, so past generations
survive a redeploy rather than being replaced.

## Tests

`derivation.test.ts` is the important one: it checks this package's off-chain address derivation
against fixtures generated by the actual compiled contract
(`contracts/script/Fixtures.s.sol`). Two implementations of one formula drift silently, and the
failure mode is an address that funds get stranded at.
