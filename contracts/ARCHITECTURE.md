# Contract architecture

`DropExecutor`, five step contracts, four shared pieces. `DropExecutor` carries the entire security
argument; the split of the rest is an address-stability argument, explained below. For the overall
design see [docs/DESIGN.md](../docs/DESIGN.md); for addresses and generations see
[docs/DEPLOYMENTS.md](../docs/DEPLOYMENTS.md).

## Layout

One directory per category, and the categories are about **addresses**, because a contract's address is
what ends up committed into every drop that reaches it:

```
src/DropExecutor.sol   has an address, and is not a step: every drop names it as both
                       trustedExecutor and setupTarget
src/steps/             each has an address, named by a recipe as a step's target
src/lib/               code with no address of its own: inlined libraries, and the abstract
                       base the ComposableCoW steps inherit. Never deployed, so nothing
                       here can ever move a drop address
src/bridge/            has an address, and no drop commits to it: nothing in a recipe reaches
                       a receiver, and all a receiver does is call `activate`, which anyone
                       may. So a new bridge costs no drop address and no generation
src/interfaces/        the slices of external protocols the steps call
```

The names inside `steps/` and `lib/` carry no `Drop` prefix: the directory already says what they are,
and repeating it in the folder, the prefix and the `Steps` suffix says the same thing three times. Only
`DropExecutor` keeps it, being at the root and the one name written into the verification instructions.

## What each contract does

### `DropExecutor.sol` — the one that matters

Every drop names this contract as both its `trustedExecutor` and its `setupTarget`. It answers one
question: *does this recipe belong to this address?*

```solidity
dropOf(owner, setupData)          // the address a recipe resolves to (salt read from setupData)
activate(owner, setupData)        // deploy it and run the recipe, or re-run if it exists
setup(shed, owner, setupData)     // the factory's callback during deployment
```

**Why it re-derives the address on every entry point.** `COWShed.trustedExecuteHooks` is
`onlyTrustedRole` and takes no nonce, no deadline and no signature. `DropExecutor` is the trusted
executor of *every* drop. So a `setup` that simply decoded `setupData` and forwarded the calls would
let anyone call `setup(someoneElsesDrop, …, arbitraryCalls)` and drain every drop in the system.
`_run` re-derives the address from `(owner, setupData)` and requires it to equal the shed it was
handed. A recipe that doesn't reproduce the address is not that address's recipe.

That check guards the factory callback too, which is why there's no `msg.sender == FACTORY`
requirement — caller identity isn't the boundary, the derivation is.

**Why the user salt lives in the recipe.** The factory takes an arbitrary `bytes32 salt`, but
`setup` receives only `(shed, owner, setupData)` — so a salt passed only as a factory argument
couldn't be recovered here. `_saltOf` reads it back out of the encoding instead (it's the third word,
right after `label`), and `dropOf`/`activate` pass that to the factory. It's committed either way, so
this cannot be forged: deploy with a factory salt that disagrees with the recipe and you get an
address this contract doesn't derive, so the deployment reverts.

The alternative — stashing the salt in transient storage during `activate` — would break deployment
straight through the factory, which the design deliberately allows as a discardable solver
pre-interaction.

**How funds get out when a recipe can't run.** Two paths, neither needing a signature, both
owner-only. Before deployment: `COWShedExecutorFactory.initializeProxyWithoutSetup` (cow-shed#78)
deploys at the committed address, skips the setup, and runs caller-supplied calls as the shed in the
same transaction — same transaction because the committed executor is trusted the moment the shed
exists. After deployment: nothing special is needed, since `trustedExecuteHooks` is `onlyTrustedRole`
= admin *or* trusted executor, and the owner is the admin. `TokenSteps.sweep` is the primitive both
use. See the `test_rescue_*` tests.

**Why a delegatecall to nothing is rejected.** The EVM treats a call to a codeless address as a
*success* returning nothing, and cow-shed's `executeCalls` only checks that flag. So a recipe whose
primitives point at an undeployed step contract would activate cleanly and do nothing at all — no order,
funds untouched, and a `once` recipe's single run spent. `_requireDelegateTargetsHaveCode` turns that
silence into a revert, which leaves the run intact. Plain calls are left alone: paying an EOA is
legitimate, delegatecalling nothing never is.

**Why drops are re-triggerable.** `trustedExecuteHooks` consumes no nonce, so a recipe can run again
on funds that arrive later — which is what makes a reusable deposit address work. Set `once` for
one-shot recipes; `DropExecutor` enforces it with a per-drop flag, written before the calls so a
revert rolls it back.

### `src/steps/` — the steps a recipe is built from

**Every function in these contracts is delegatecalled by the drop** (`Call.isDelegateCall = true`).
That's what makes `address(this)` the drop, so `balanceOf(address(this))` is the amount that *actually
arrived*. It's the reason a drop can commit to "split whatever lands here into 12 parts" without
committing to a number nobody could have known when the address was computed.

Immutables are readable under delegatecall (they live in the code, not storage), which is why the
deployment addresses work. Storage wouldn't, and none of these contracts has any.

**Why four contracts rather than one.** A step's target address sits inside `setupData`, so it is part
of the CREATE2 preimage of every drop that reaches it — and a contract's own address covers its
constructor arguments as well as its code. One contract holding everything therefore couples things
that have nothing to do with each other: while `sweep` shared a contract with the TWAP step, the
address of the *rescue* primitive moved every time the TWAP handler address did. Splitting by what each
contract actually depends on decouples them, and the two that depend on nothing get addresses that can
only move if their own code changes.

| contract | constructor | steps |
|---|---|---|
| `GuardSteps` | — | `requireMinBalance(token, min)`, `requireTimeWindow(from, to)`, `requireCallResult(…)` |
| `TokenSteps` | — | `wrapNative(wrapped)`, `sweep(token, to)`, `approveMax(token, spender)`, `approveBalance(token, spender)` |
| `PresignSteps` | settlement, vault relayer | `presignSellAll(…)`, `presignSellAllAtOracle(…)` |
| `TwapSteps` | vault relayer, ComposableCoW, TWAP handler, timestamp factory | `twapFromBalance(…)` |
| `StopLossSteps` | vault relayer, ComposableCoW, StopLoss handler | `stopLossFromBalance(…)` |

- `requireMinBalance` / `requireTimeWindow` — revert unless enough has arrived, or outside an absolute
  window. `token = address(0)` guards the native balance; a `0` bound means unbounded.
- `wrapNative` — wrap the whole native balance, so xDAI/ETH-funded drops can trade.
- `approveMax` / `approveBalance` — allow a spender everything, or exactly what arrived. Both are
  *conditional*: they read the allowance first and skip the write when it already covers the amount,
  which matters because a reusable drop re-runs its recipe on every arrival and an allowance survives
  between runs. Both are upward-only, so a wider allowance already in place is never narrowed.

  An allowance for a **fixed** amount needs no step at all — `token.approve(spender, n)` is an ordinary
  call and belongs in `raw`. It is also usually wrong in a recipe: the number is committed before
  anything is funded, so it will not match what arrives. `approveBalance` is the one that has to be a
  step, because "the amount that arrived" is not a literal.
- `sweep` — rescue: send the whole balance out. `token = address(0)` for native. An empty balance is a
  no-op, not a revert, so a rescue naming five tokens moves whatever it finds.
- `presignSellAll` — sell the whole balance as one pre-signed CoW order. Emits `OrderPlacement` so an
  off-chain poster can submit it — see `lib/CowOrder.sol`.
- `presignSellAllAtOracle` — the same, but the limit is `max(oracle-derived, committed floor)`. The
  floor is not optional and is the whole point: activation is permissionless, so an activator picks the
  moment and therefore the oracle reading. Letting the oracle only *improve* on a committed number means
  the worst they can do is hand you the price you already agreed to.
- `requireCallResult` — the general-purpose guard: revert unless a read from another contract satisfies
  a comparison. A `staticcall`, so the worst a malformed one can do is revert or pass wrongly, never
  move a balance — which is why the generic *write* step it resembles does not exist. Note it is a
  **refusal, not a trigger**: evaluated once at activation, with nothing watching for the condition to
  turn true. "Sell when the price crosses X" is `stopLossFromBalance`, where the watch tower polls.
- `twapFromBalance` — split the whole balance into `n` parts and register a TWAP with ComposableCoW.
- `stopLossFromBalance` — register a stop-loss over the whole balance: composable-cow's `StopLoss`
  handler sells it when `sellTokenPrice / buyTokenPrice` falls to or below `strike`, both prices read
  from Chainlink-style feeds and normalised to 18 decimals. The two feeds must quote the same currency,
  which is not checkable on-chain. `strike` decides *when* to sell; the separate limit price decides how
  bad a fill is refused.

  It resolves two things a recipe cannot commit to, not one: the amount, and the **deadline**.
  `StopLoss` takes an absolute `uint32 validTo`, so committing one would start the clock when the
  address was *computed* — the step takes a duration and resolves it at activation instead, the same
  way `presignSellAll` does and the counterpart of TWAP's `t0 = 0` cabinet read.

A recipe is free to mix targets; nothing in `DropExecutor` restricts it to one. The `_amountFromBalance`
and `_register` internals live in `lib/ComposableBase.sol`, which is what a second handler is built
from — see its notes on the two requirements a handler has to meet (it must implement the generator
side, not just `verify`, and it must ignore `sender`).

Events emitted here come *from the drop*, since that's `address(this)` under delegatecall — so an
`OrderPlacement` from a drop names the drop as both emitter and `sender`.

### `interfaces/ICoWSwapOnchainOrders.sol`, `lib/CowOrder.sol` and `CowOrderPoster.sol`

A *discrete* order has every field resolved, unlike a *conditional* one, which is a rule ComposableCoW
turns into orders later. Conditional orders are announced by `ConditionalOrderCreated` and indexed for
you; discrete ones look like they have nothing, because `setPreSignature` takes a UID and says nothing
about what was signed. So the order exists and no solver can see it.

The announcement that closes that is **not ours and not new**:

```solidity
event OrderPlacement(address indexed sender, GPv2Order.Data order, OnchainSignature signature, bytes data);
```

EthFlow has emitted it since it shipped, and `autopilot` decodes it under both schemes a contract can
reach — `Eip1271`, owner from `signature.data`; `PreSign`, owner from `sender`. It is redeclared in
`interfaces/ICoWSwapOnchainOrders.sol` only because ethflowcontract is not a dependency here; the
canonical event signature expands a struct to its tuple, so `LibCowOrder.Data` and `GPv2Order.Data`
produce the identical `topic0`. `test/OnchainOrders.t.sol` pins that to EthFlow's hash, along with the
scheme numbering and the twelve-byte `data` layout — nothing else in the suite would notice a drift,
since every other test emits and decodes with the same declaration.

What was actually missing is an indexer *without* an address filter:
`CoWSwapOnchainOrdersContract::filter()` upstream pins a configured address list and asserts it is
non-empty, and a counterfactual drop address can never be in one. `packages/watch-tower` filters on
`topic0` alone and verifies `settlement.preSignature(uid) != 0` instead, which is what makes doing so
safe. Generalising the upstream parser along those lines is the change this repository is asking for.

Two consequences:

- **The emitter does not have to be the owner** — that is what `sender` is for.
- **The UID is not in the log.** A consumer recomputes `orderDigest ++ owner ++ validTo`. `uidOf` is
  still here because this side needs one to pass to `setPreSignature`; it just no longer pays to log it.
- **`data` is `int64 quoteId ++ uint32 validTo`,** exactly twelve bytes or the parser upstream rejects
  it. `CowOrder.NO_QUOTE` is what a drop passes: the recipe was compiled into an address long before
  anything was funded, so any quote it named would have expired. Note a pre-signed order must keep its
  real `validTo` in the struct — EthFlow's trick of committing `uint32.max` works only because ERC-1271
  lets it enforce expiry itself.

`CowOrder` is a library: every function is `internal`, so it is inlined and never deployed.
`CowOrder.presign(settlement, order)` is the whole tail of the pre-sign path — hash, pack the UID,
`setPreSignature`, emit.

`CowOrderPoster` is the deployed version, for contracts that would rather call than copy. Two entry
points, because `setPreSignature` keys off `msg.sender`:

| you can | use | who signs | who emits |
|---|---|---|---|
| delegatecall | `presignAndAnnounce(order, quoteId)` | you | you |
| only plain calls | `setPreSignature` yourself, then `announce(order, quoteId)` | you | the poster |

`quoteId` is a required argument rather than an overload: it is the one field of the announcement a
caller can get wrong invisibly, and a caller that holds a live quote is the reason it exists.

`announce` reverts unless the settlement contract already holds the signature, so an `OrderPlacement`
from that address is signed by construction. Each entry point rejects the wrong call type rather than
silently doing the wrong thing. The poster is **not** part of any drop address — no recipe reaches it,
since the steps inline the library — but it ships with the generation because integrators build
against its address.

### `lib/ComposableBase.sol` — the shared half of a ComposableCoW step

Abstract, so it has no address. **One step contract per handler**, because a handler needs its own typed
function to build its own `staticInput` — and a new function changes the contract's bytecode, which
changes its address, which changes every drop address that named the old one. Separate contracts keep
that from happening to handlers already in use.

That leaves the shared half needing a home which is not an address. It cannot be a library: `_register`
reads `COMPOSABLE_COW`, and `Library cannot have non-constant state variables` is a compiler error, so a
library would have to thread the address through every call. An abstract contract holds it and is never
deployed, and immutables stay readable under delegatecall because they live in the *concrete* contract's
code.

`_amountFromBalance(sellToken, divisor)` reads what arrived and approves the relayer — `divisor` is `n`
for an n-part schedule, `1` for a single-shot handler. `_register` picks `createWithContext` when given a
value factory and plain `create` when not, since a handler with no start-time field would otherwise seed
a cabinet entry nothing reads.

Note what does *not* need any of this: `TradeAboveThreshold` reads the owner's balance itself, so its
`staticInput` carries no amount and registering it is an ordinary `raw` call to ComposableCoW. A step
contract earns its place exactly when the amount has to be resolved at activation.

### `lib/` — the rest, shared without an address

`Allowance` is a library of `internal` functions, so it is inlined into each caller and never
deployed. Its two entry points differ in what they *grant*, not just what they test: `ensureMax` writes
an unlimited allowance when the current one is short (what the order steps want, so a later top-up needs
no fresh approval), while `ensureAtLeast` writes exactly the amount asked for. That is the point: a
deployed library would need its own address, and every address a step reaches is committed into the drop
address. `NothingToSell` lives at file scope in `lib/Errors.sol` so every step contract raises the same
selector for the commonest failure.

### `lib/Orders.sol` — order plumbing

Order UID packing (`digest ++ owner ++ validTo`), the `sell`/`erc20` flag constants, and exact
integer limit-price arithmetic. Order *hashing* is not reimplemented — `cow-shed/LibCowOrder.sol`
already has the canonical assembly version, and two would be one too many.

## The two order paths

`presignSellAll` needs nothing from the shed implementation: the drop signs its own order on-chain
and an off-chain poster makes it visible. `twapFromBalance` needs the drop to answer ERC-1271.

Drops use `COWShedWithExecutorSigner`, whose `isValidSignature` delegates to the shed's trusted
executor — which for a drop is `DropExecutor`. So `DropExecutor.isValidSignature` is what forwards to
ComposableCoW, keyed on `msg.sender` (the drop asking), which is exactly the owner ComposableCoW should
be queried about. One consequence worth knowing: cow-shed's own `ERC1271Forwarder` passes the original
caller as `sender`, but by the time the call reaches us the drop has become `msg.sender`. TWAP ignores
`sender`, so this is fine today; a handler or swap guard that inspects it would see the drop.

The payoff is that both cow-shed contracts are the canonical ones already deployed (cow-shed#79), so
the only contracts this project deploys are its own two.

For the TWAP params to be committable into the address they must not mention the owner, so
`receiver = address(0)` (ComposableCoW's "pay the owner" sentinel) and `t0 = 0` with
`createWithContext` seeding the start time from a value factory at activation.

## Build settings are load-bearing

`foundry.toml` must stay byte-identical to cow-shed's (`solc 0.8.30`, `via_ir`,
`optimizer_runs = 1_000_000`, `bytecode_hash = "none"`, `cbor_metadata = false`,
`evm_version = "prague"`).

We compile `COWShedWithExecutorSigner` and `COWShedExecutorFactory` from the pinned submodule. The
implementation address ends up inside every drop's CREATE2 init code and the factory is the CREATE2
deployer, so a change to any compiler setting silently moves **every drop address**. It also means our
build must reproduce the canonical cow-shed bytecode — verified, because both compute exactly the
addresses cow-shed#79 records as live on Gnosis, and a CREATE2 address is derived from init code.

## Tests

| file | what it covers |
|---|---|
| `DropExecutor.t.sol` | Derivation, activation, `once` semantics, recovery, and the attacks: forged recipes, wrong owner, foreign trusted executor, a salt disagreeing with the recipe, truncated `setupData`, direct `trustedExecuteHooks`. |
| `steps/StepsBase.sol` | The shared harness: a real factory, a real `DropExecutor`, all four step contracts and the mocks. Every step test runs its step delegatecalled from inside a drop by an activation nobody signed — calling a step contract directly would read *its* balance, which is always zero. |
| `steps/GuardSteps.t.sol` | The guards, including a one-shot recipe surviving a premature activation, and a guard placed *last* still binding because the activation is atomic. |
| `steps/TokenSteps.t.sol` | `wrapNative`, and a recipe spanning two step contracts. |
| `steps/PresignSteps.t.sol` | Pre-signing an arbitrary arrived amount; that `OrderPlacement` is emitted by the drop and names it in `sender`; and that the event alone carries everything a poster needs, including the uid recomputed the way `packages/watch-tower` recomputes it. |
| `OnchainOrders.t.sol` | That the redeclared `OrderPlacement` and `OrderInvalidation` still carry EthFlow's topics, that the scheme numbering is the on-chain one rather than `GPv2Signing`'s, and the twelve-byte `data` layout. |
| `CowOrderPoster.t.sol` | Both integration shapes against the deployed helper — a contract that delegatecalls and one that can only make plain calls — plus the refusals: announcing an unsigned order, and either entry point reached the wrong way. |
| `steps/TwapSteps.t.sol` | The TWAP step, plus a hermetic assertion that `TwapData` still encodes as the ten words the deployed handler decodes. |
| `steps/StopLossSteps.t.sol` | The stop-loss step, the deadline running from activation rather than authoring, and a hermetic assertion on the thirteen-word `StopLossData` layout. |
| `steps/ComposableBase.t.sol` | The half of the base `TwapSteps` does not reach: `divisor == 1`, and that a zero value factory routes to plain `create`. Uses a throwaway second handler defined in the test, so the branch a future `StopLoss` step will take does not ship unexercised. |
| `DropGnosisFork.t.sol` | Against the real Gnosis deployments. Skipped unless `GNOSIS_RPC_URL` is set, so the default suite is hermetic. |

`test_fork_stopLossIsTradeableOnceTheStrikeIsCrossed` does the same against the real `StopLoss` handler
with only the price feeds mocked — which is what makes the trigger controllable while still proving the
deployed handler decodes our hand-copied struct field-for-field. It then moves the sell token up and
asserts the order stops being tradeable, which pins the direction of the strike comparison.

The load-bearing fork test is `test_fork_twapIsTradeableAndTheDropValidatesTheSignature`: it does
exactly what the watch tower does — `getTradeableOrderWithSignature`, then hand the signature back to
the owner's `isValidSignature` — for a non-Safe owner. If a cow-shed drop couldn't own a conditional
order, that's where it would show up.
