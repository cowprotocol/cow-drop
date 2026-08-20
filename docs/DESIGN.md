# Design

How cow-drop works, and why it is built the way it is. For build and run instructions see the
[README](../README.md); for addresses and generations see [DEPLOYMENTS.md](DEPLOYMENTS.md).

## The idea

A cow-shed address today commits to exactly one thing: its owner.

```
salt     = bytes32(uint160(owner))
initCode = COWShedProxy.creationCode ++ abi.encode(implementation, owner)
```

Every action then needs the owner to sign, at the moment of acting.

cow-drop inverts that. Using [cow-shed#64](https://github.com/cowdao-grants/cow-shed/pull/64)'s
deploy-time setup call, the address commits to a **recipe**:

```
salt = keccak256(abi.encode(owner, trustedExecutor, userSalt, setupTarget, keccak256(setupData)))
```

`setupData` is the recipe. Change one byte of it and you get a different address — so nobody can
substitute a different recipe at this one, and no signature is needed to prove the recipe is the
right one. **The address is the authorization.**

That yields some properties worth stating plainly:

- **Permissionless.** Anyone can activate a drop: a keeper, a solver pre-interaction, a stranger.
  There is no privileged sender and nothing to steal.
- **Fund before it exists.** Funds sent to the counterfactual address are spent by the recipe on
  activation. This is what makes it work behind a bridge, whose payout amount and timing you do not
  control.
- **The amount is never committed.** Recipe primitives run as delegatecalls, so `address(this)` is
  the drop and `balanceOf(address(this))` is what actually arrived. A drop commits to *"split
  whatever lands here into 12 parts"*, not to a number nobody could have known.
- **Recoverable, if you kept the recipe.** A drop whose recipe can never *succeed* is not lost funds:
  there are two owner-only rescue paths, neither needing a signature — see [Rescue](#rescue). But both
  need the recipe bytes, as does activation, and only their hash is on-chain. **Losing a recipe after
  funding loses the money, for everyone including the owner.** The recipe file is the key, not a
  convenience.

## Two order paths

| | Path P — pre-sign | Path C — composable |
|---|---|---|
| Step | `PresignSteps.presignSellAll` | `TwapSteps.twapFromBalance` |
| Needs ERC-1271 | no | yes, forwarded by `DropExecutor` |
| Needs a watch tower | no | yes, and it is automatic |
| After activation | an off-chain poster submits the order — [`packages/watch-tower`](../packages/watch-tower/README.md) | self-driving; each part is posted for you |
| Good for | swap whatever arrived, once | TWAP and anything recurring |

Both share one implementation, `COWShedWithExecutorSigner`, whose ERC-1271 delegates to the shed's
trusted executor — which for a drop is `DropExecutor`. So the ComposableCoW forwarding that makes
path C work lives in `DropExecutor.isValidSignature`, and pre-signing needs nothing from the
implementation at all. That is what lets us reuse the cow-shed contracts already deployed rather than
shipping our own variant.

## `OrderPlacement`, CoW's own event

A contract that pre-signs a CoW order has a problem that is not cow-drop's: the signature is on-chain
but nothing told the order book the order exists, so no solver sees it. `setPreSignature` takes a UID
and says nothing about what was signed.

The event that closes that is **already in production**. EthFlow has emitted it since it shipped, and
`autopilot` already decodes it under both of the schemes a contract can reach:

```solidity
event OrderPlacement(address indexed sender, GPv2Order.Data order, OnchainSignature signature, bytes data);
```

So cow-drop emits that, redeclared in
[`contracts/src/interfaces/ICoWSwapOnchainOrders.sol`](../contracts/src/interfaces/ICoWSwapOnchainOrders.sol)
because ethflowcontract is not a dependency here. A redeclaration is only worth something if it is
byte-compatible, so [`contracts/test/OnchainOrders.t.sol`](../contracts/test/OnchainOrders.t.sol) pins the
topic0 to EthFlow's `0xcf5f9de2…` — the field list expands to the same tuple, so `LibCowOrder.Data` and
`GPv2Order.Data` are the same event.

**An earlier version of this repository shipped its own `CowOrderPlaced` instead**, carrying a
pre-packed `orderUid`. That was right about the gap and wrong about the fix. What was missing was never
the event — it was an indexer that does not filter by address, because
`CoWSwapOnchainOrdersContract::filter()` in `services` pins a configured address list and asserts it is
non-empty, which no counterfactual drop address can ever be in. A second event would have split the
standard and bought nothing.

That indexer is [`packages/watch-tower`](../packages/watch-tower/README.md). It filters on the one topic0
with no address filter, and verifies `settlement.preSignature(uid) != 0` before posting — which is what
makes dropping the address filter safe, and is the check `autopilot` skips because it has a filter
instead. **Generalising the upstream parser to work without one, gated on that check, is the change
this repository is actually asking for.**

Two details the switch turns on:

- **The UID is not in the log.** The owner is: in `sender` for a pre-signed order, in `signature.data`
  for an ERC-1271 one. So a consumer recomputes `orderDigest ++ owner ++ validTo` itself — see
  [`packages/sdk/src/orderUid.ts`](../packages/sdk/src/orderUid.ts), checked against the compiled contract
  by fixtures, since a wrong digest means checking the pre-signature of an order that never existed.
- **`data` is twelve bytes of `int64 quoteId ++ uint32 validTo`,** the only layout the parser upstream
  accepts. A drop passes `NO_QUOTE`, honestly: the recipe is compiled into an address long before
  anything is funded and any quote that old has expired. EthFlow uses the `validTo` half to carry a
  deadline its order struct does not — it commits `uint32.max` and enforces expiry in ERC-1271 — which a
  pre-signed order must *not* do, since nothing gates it but the settlement contract's own check.

To emit it, redeclare the interface, or call `CowOrderPoster`: `presignAndAnnounce` if you can
delegatecall, or `setPreSignature` yourself and then `announce`, which refuses to emit an order that is
not really signed.

## Bridging in

Funding a drop from another chain is the case the whole design is shaped around — an address that
commits to a rule rather than an amount is exactly what you want behind a payout whose size and timing
you do not control. There are two ways to do it, and the first needs no new code at all.

**Name the drop as the bridge's recipient.** The address exists as a destination before it exists as a
contract, so any bridge can pay it, and a keeper activates once the balance arrives. Nothing on this
page is required for that.

**Or deliver through `DropBungeeReceiver`.** A bridge that supports a destination payload can pay the
receiver instead, with `abi.encode(owner, setupData, onFailure)` as the payload. It forwards the
tokens to `dropOf(owner, setupData)` and calls `activate` — so the CoW order is live in the *same
transaction* as the bridge fill, and the relayer's gas pays for the activation rather than a keeper's.

Three decisions in that contract are worth stating, because each one is a place the obvious choice is
wrong:

- **It cannot be a method on `DropExecutor`.** That contract's address is both the `trustedExecutor`
  and the `setupTarget` in every drop's CREATE2 preimage, so adding an entry point to it would move
  every drop address and force a generation. As a separate contract it is outside the commitment
  entirely — which means new bridges, or fixes to old ones, cost no drop address and no generation.
- **A recipe that declines is not a failure.** A `requireMinBalance` guard refusing a bridge's first
  tranche is the guard working. So the forwarding and the activation happen together in an external
  self-call under `try/catch`: a failed activation rolls the forwarding back with it, and the catch
  branch still holds the tokens to place. `onFailure` then picks — leave them at the drop to
  accumulate (the default, safe with any recipe), or return them to the owner.
- **It forwards the balance it holds, not the amounts the bridge reported.** A pass-through that keeps
  a remainder is a pass-through anyone can sweep. It is also guarded against reentrancy, for the one
  window where it genuinely holds funds: part-way through a multi-token delivery, a hostile token's
  transfer hook could otherwise redirect the remainder.

A malformed payload reverts, and that is safe rather than reckless: the bridge's transfer and its call
are one transaction, so reverting rolls the transfer back and the funds never leave the bridge.

Off-chain, `bungeeDelivery()` in the SDK builds the payload and
[`packages/bridging`](../packages/bridging/README.md) quotes the route. Note what the payload does
*not* contain — an amount — so re-quoting a route can never move the address the quote is aimed at.

**Direct delivery is the default, and this section is the reason.** The receiver is shared by everyone
and forwards its whole balance to whichever drop its caller names, so a delivery that fails to execute
there is not merely stuck — it is a public bounty, and one has already been taken. Paying the drop
address instead gives up atomicity and gives up nothing else. The whole argument, the incident and the
options for fixing the atomic path are in [BRIDGING.md](BRIDGING.md).

## Source layout

```
contracts/        lib/cow-shed pinned to cow-shed#78 (feat/owner-deploy-without-setup)
  src/DropExecutor.sol    the commitment check + activation
  src/steps/              the steps, one contract per dependency set
  src/lib/                internal libraries: inlined, never deployed, so they cost no address
    Orders.sol            order UID packing, limit-price math
    Allowance.sol         allowance handling
    CowOrder.sol          pre-sign an order and announce it as OrderPlacement
  src/interfaces/ICoWSwapOnchainOrders.sol   CoW's own event, redeclared
  src/CowOrderPoster.sol  the deployed helper, for third-party contracts placing an order
  src/bridge/             bridge receivers: an address, but not one any drop commits to
    DropDelivery.sol      the shared half — forward, activate, and what to do if it declines
    DropBungeeReceiver.sol  Bungee's executeData, translated
    Errors.sol            the errors more than one step contract raises
packages/sdk/src/
  recipe.ts               compileRecipe: recipe file -> address + committed bytes
  encoding.ts             the CREATE2 derivation, off-chain
  steps.ts                the step registry (extension point)
  templates.ts            swapOnArrival, twapOnArrival
  bridge.ts               the delivery payload, and the destination a bridge is aimed at
packages/bridging/src/
  types.ts                the provider seam: a bridge, reduced to what a drop needs from one
  bungee/                 the Bungee API, and the provider over it
packages/watch-tower/src/
  scanner.ts              find OrderPlacement anywhere on the chain, and verify it
  poster.ts               forward one order to the order book
  watchTower.ts           the loop, and where the block cursor advances
apps/web/src/
  App.tsx                 the shell: wallet, error banner, tab bar
  tabs/RecipesTab.tsx     the form, and the recipe it builds
  tabs/BridgeTab.tsx      funding a recipe from another chain
```

## The recipe format

The JSON is the authoring and interchange surface. The file is **not** itself the commitment — the
compiled `setupData` bytes are. The file is a reproducible way to get back to those bytes, which is
why compilation reads fields by name in a fixed order and never depends on key order or formatting.
Export a recipe, reload the page, import it, and the same address comes back; nothing about a drop
needs a server or a database.

```json
{
  "version": 1,
  "generation": 1,
  "label": "WXDAI -> COW over 12h",
  "chainId": 100,
  "owner": "0x…",
  "salt": "0x00…00",
  "once": true,
  "steps": [
    {
      "type": "twapFromBalance",
      "sellToken": "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
      "buyToken": "0x177127622c4A00F3d409B75571e12cB3c8973d3c",
      "parts": 12,
      "partDuration": 3600,
      "limitPrice": { "price": "45", "sellDecimals": 18, "buyDecimals": 18 }
    }
  ]
}
```

`generation` is which deployment of the contracts to compile against, and it is the field that makes
the file reproducible. The step contracts' addresses live inside the committed bytes, so compiling the
same file against a later generation resolves to a *different* address — which for a drop that is
already funded is the difference between recovering the money and not. It defaults to **1**, not to the
latest: a file written before the field existed was compiled against generation 1, and that is what it
has to keep meaning. Everything the SDK exports pins it explicitly.

Adding a capability is a new entry in the step registry (`packages/sdk/src/steps.ts`) plus a
matching primitive in one of the contracts under `contracts/src/steps/`. `{"type": "raw"}` is the
escape hatch for anything not covered, and is what the ABI-builder UI emits.

Limit prices are exact integer fractions, never floats: the result is committed into an address, so
a rounding difference between the UI and the SDK would be a *different address*, not merely a
slightly different price.

## Two SDKs, on purpose

`@cowprotocol/cow-drop-sdk` deliberately does **not** depend on
[`@cowprotocol/cow-sdk`](https://www.npmjs.com/package/@cowprotocol/cow-sdk): deriving an address is a
pure, offline computation and must stay that way, so its only dependency is `viem`. Anything that
talks to CoW — quotes, order submission, chain metadata, explorer URLs — is the official SDK's job,
and the web app uses both. `OrderBookApi` posts the pre-signed orders and fetches quotes;
`getWrappedTokenForChain` and the chain objects supply metadata that would otherwise rot in a
hardcoded table here.

The function reference is in [`packages/sdk/API.md`](../packages/sdk/API.md).

## Security

One invariant carries the whole design.

`COWShed.trustedExecuteHooks` is `onlyTrustedRole` and takes **no nonce, no deadline, no
signature**. `DropExecutor` is the trusted executor of every drop. So a `setup` implementation that
merely decoded `setupData` and forwarded the calls would let anyone call
`setup(someoneElsesDrop, …, arbitraryCalls)` and **drain every drop in the system**.

`DropExecutor._run` therefore re-derives the address from `(owner, setupData)` and requires it to
equal the shed it is being asked to act on, on *every* entry point — including the factory callback,
which is why there is no `msg.sender == FACTORY` check. A recipe that does not reproduce the address
is not that address's recipe.

`test/DropExecutor.t.sol` attacks this directly: forged recipes, the right recipe with the wrong
owner, a foreign trusted executor, a non-zero salt, and calling `trustedExecuteHooks` directly.

Two consequences of the design that are easy to miss:

- **The user salt lives inside the recipe.** The factory takes an arbitrary `bytes32 salt`, but
  `ICOWShedSetup.setup` receives only `(shed, owner, setupData)` — so a salt passed *only* as a
  factory argument could not be recovered, and the commitment could not be re-derived. Carrying it
  in the recipe solves that at no cost: it is committed anyway, so reading it back cannot be forged,
  and a caller who deploys with a factory salt that disagrees simply produces an address
  `DropExecutor` does not derive. Set it to get a second drop from an otherwise identical recipe, or
  as a grinding space for a vanity address; zero is the ordinary case.
- **Drops are re-triggerable by design**, since `trustedExecuteHooks` consumes no nonce. That is
  what makes a reusable deposit address work. Set `"once": true` for one-shot recipes, which
  `DropExecutor` enforces with a per-drop flag.

### One-shot recipes and premature activation

Activation is permissionless, so "nobody triggers this early" can never be a promise made by
whoever activates. For a `"once": true` recipe that matters, because the single run could be spent
at the wrong moment. Three things bound the risk:

- **A failing recipe cannot spend the run.** `consumed` is written in the same transaction as the
  calls, so a revert rolls it back. Activating a drop that holds nothing costs the caller gas and
  changes nothing (`test_once_prematureActivationDoesNotBurnTheRun`).
- **A guard makes "not yet" an explicit revert.** `requireMinBalance` and `requireTimeWindow` are
  ordinary steps, committed into the address like everything else, so no activator can skip them.
  Put `minAmount` on any one-shot recipe funded by a bridge that might pay out in tranches — without
  it, the first tranche to land sizes the whole schedule.
- **`allowFailure` + `once` is refused at compile time.** Together they are burnable by anyone: the
  step fails silently, the activation succeeds having done nothing, and the run is gone
  (`test_once_withAllowFailureCanBeBurnedByAnyone`).

What is *not* available is a guarantee that only a chosen party may ever activate. That would mean
committing an authorised activator into the recipe and checking it in `DropExecutor` — cheap to add,
but it gives up the property that makes drops interesting, so it is a per-recipe decision nobody has
asked for yet. Note also that a spent run is never lost funds: the owner can still sweep.

### Rescue

A drop is funded before it exists, which creates a failure mode worth taking seriously: money arrives
late, or a condition the recipe depends on stops holding, and the committed recipe can never succeed.
`initializeProxyWithSetup` is the only entrypoint that can deploy at a setup-committed address and it
always runs the setup — so without a hatch, those funds would be stranded at an address that can
never exist.

The first defence is recipe design: give a one-shot recipe a `requireTimeWindow` with a `notAfter`, or
a branch that lets the setup succeed trivially once the opportunity has passed. But the recipe author
may not have modelled it, or may have modelled it wrongly, so there are two rescue paths — and which
applies depends only on whether the drop is deployed yet:

| drop state | mechanism | SDK |
|---|---|---|
| not deployed | `initializeProxyWithoutSetup` ([cow-shed#78](https://github.com/cowdao-grants/cow-shed/pull/78)) — deploys at the same address, skips the recipe, sweeps in the same transaction | `buildRescueTx` |
| deployed | `trustedExecuteHooks` — the owner is the shed's admin, so no hatch and no signature are needed | `buildOwnerSweepTx` |

`buildRescueForState` picks between them. Both are owner-only.

Owner-only is what keeps ordinary drops safe to fund: if anyone could deploy at a setup-committed
address without running the setup, the address would stop being a promise about what happens to the
money. It grants the owner nothing new, since they are the admin already. The sweep runs in the *same*
transaction as the deployment because the committed trusted executor cannot be swapped out for the
rescue and is trusted the moment the shed exists — sweeping separately would leave it a window to act
first.

Passing no sweep calls (`buildDeployOnlyTx`) is the "just give me the account" variant: it deploys the
shed, skips the recipe, and leaves an ordinary cow-shed the owner drives normally. With an empty call
list the factory never takes the trusted role at all.

One consequence to keep in mind: **a drop's address no longer proves its recipe ran.** Anything
inferring that must check the recipe's own effects or watch for `SetupSkipped`.

Never discover a user's drop from `ownerOf` or `COWShedBuilt`: `initializeProxyWithSetup` is
permissionless, so anyone can create a shed that reports someone else as its owner. Always recompute
the address client-side from the intended parameters before funding it.

The keeper's `GET /v1/drops?owner=…` is not an exception to this, and not a hole in it either. It can
only name addresses whose recipe the keeper compiled itself, so the address, the recipe and the `owner`
it reports are one internally consistent triple rather than a claim a stranger attached to a deployed
shed. But registration is open and `owner` is a field of the *submitted* recipe, so a row still means
"someone registered a recipe that would make you the owner", never "you made this". A listing may tell
you where to look; the address you *fund* is still only ever one your own browser recomputed from a
recipe you chose.

**Unaudited, and it depends on an unmerged four-deep PR stack.** Do not put real money in it yet.

## Status

Working and verified end-to-end on a Gnosis fork: a third party funds a counterfactual address,
activates it, and the real `GPv2Settlement` records the pre-signature for an order whose
`sellAmount` is the balance that arrived.

Not done yet:

- Broadcast to Gnosis (needs a funded deployer).
- **Activation** is still manual for drops not handed to a
  [keeper](../packages/keeper/README.md). [`packages/watch-tower`](../packages/watch-tower/README.md)
  posts the orders, but somebody still has to notice that funds arrived and send the activation
  transaction. A solver pre-interaction is the better answer for a real product.

## Known constraints

- **Nothing upstream is merged.** The stack is cow-shed `#61 → #64 → #67 → PR2`, all unreviewed.
  The submodule is pinned to a commit; expect rebases. Any change to the shed implementation changes
  its address, which changes `initCodeHash`, which changes **every** drop address — which is why
  deployments are cut as numbered generations and recipe files pin the one they were compiled against.
  Expect the generation counter to move while the upstream stack is still in flux.
- **composable-cow#145 explicitly distrusts this trust model.** `ComposableCowPoller.registerFromShed`
  rejects sheds from `COWShedExecutorFactory` because the caller picks the trusted executor "who can
  then drive the shed with no signature at all". The objection does not apply to a
  commitment-verifying executor, but the check is address-scheme-based, so **Poller JIT funding is
  unavailable to drops** until a commitment-aware variant exists.
- `proxyOf` / `executeHooks` / `initializeProxy` are overloaded on the executor factory. Always use
  full signatures; bare-name encoding is ambiguous in both ethers and viem.
- Someone pays gas for activation. Fine for a demo; a real product wants a solver pre-interaction or
  a fee taken inside the recipe.
- No single-shot limit-order handler exists on composable-cow `main`, which is why path C is TWAP
  only. `TradeAboveThreshold` has the right shape but `buyAmount = 1`; composable-cow#82's
  `LimitOrder` is verify-only, so `getTradeableOrderWithSignature` reverts and the watch tower cannot
  post it. A ~60-line `BaseConditionalOrder` generator would let path C cover simple swaps too.

## Related work

- [`bridge-and-swap`](https://github.com/cowprotocol/bridge-and-swap) →
  [`orderflow-contracts#1`](https://github.com/cowprotocol/orderflow-contracts/pull/1) solves the
  same problem with a narrower commitment: the address commits to exactly one order, via a bespoke
  per-order contract. cow-drop generalizes that to any recipe and reuses cow-shed instead. Worth
  deciding whether one subsumes the other for the single-order case.

  `DropBungeeReceiver` is modelled directly on its `OrderFlowFactory.executeData`, and the mapping is
  one-to-one: `getOrderFlowAddress` is `dropOf`, `triggerOrderCreation` is `activate`. The difference
  is what the address commits to — one order there, any recipe here — which is why a drop can be
  bridged into and then run a TWAP, and why the receiver needs no per-order deployment.
- [cow-sdk#845](https://github.com/cowprotocol/cow-sdk/pull/845) adds a `BridgeThenSwapProvider`
  abstraction with a Bungee implementation, aimed at `OrderFlow`. `packages/bridging` deliberately
  mirrors its shape with the destination replaced by a `DestinationTarget` value, which is the
  generalization that would let one implementation serve both.
- [`approve-and-bridge`](https://github.com/cowprotocol/approve-and-bridge) is the outbound mirror
  (swap then bridge, as a post-hook) and already uses cow-shed as its delegatecall context.
