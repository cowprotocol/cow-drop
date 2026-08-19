<img src="apps/web/public/logo.png" alt="" width="150" align="right" />

# cow-drop

Drop your tokens into an address and the cow does the rest.

Compute an address, send funds to it — by bridge, exchange withdrawal, payroll, plain transfer —
and anyone can trigger the trading logic that was baked into it. There is no signature anywhere in
the flow, because the recipe is committed into the address itself.

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
| After activation | an off-chain poster submits the order — [`packages/watch-tower`](packages/watch-tower/README.md) | self-driving; each part is posted for you |
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
[`contracts/src/interfaces/ICoWSwapOnchainOrders.sol`](contracts/src/interfaces/ICoWSwapOnchainOrders.sol)
because ethflowcontract is not a dependency here. A redeclaration is only worth something if it is
byte-compatible, so [`contracts/test/OnchainOrders.t.sol`](contracts/test/OnchainOrders.t.sol) pins the
topic0 to EthFlow's `0xcf5f9de2…` — the field list expands to the same tuple, so `LibCowOrder.Data` and
`GPv2Order.Data` are the same event.

**An earlier version of this repository shipped its own `CowOrderPlaced` instead**, carrying a
pre-packed `orderUid`. That was right about the gap and wrong about the fix. What was missing was never
the event — it was an indexer that does not filter by address, because
`CoWSwapOnchainOrdersContract::filter()` in `services` pins a configured address list and asserts it is
non-empty, which no counterfactual drop address can ever be in. A second event would have split the
standard and bought nothing.

That indexer is [`packages/watch-tower`](packages/watch-tower/README.md). It filters on the one topic0
with no address filter, and verifies `settlement.preSignature(uid) != 0` before posting — which is what
makes dropping the address filter safe, and is the check `autopilot` skips because it has a filter
instead. **Generalising the upstream parser to work without one, gated on that check, is the change
this repository is actually asking for.**

Two details the switch turns on:

- **The UID is not in the log.** The owner is: in `sender` for a pre-signed order, in `signature.data`
  for an ERC-1271 one. So a consumer recomputes `orderDigest ++ owner ++ validTo` itself — see
  [`packages/sdk/src/orderUid.ts`](packages/sdk/src/orderUid.ts), checked against the compiled contract
  by fixtures, since a wrong digest means checking the pre-signature of an order that never existed.
- **`data` is twelve bytes of `int64 quoteId ++ uint32 validTo`,** the only layout the parser upstream
  accepts. A drop passes `NO_QUOTE`, honestly: the recipe is compiled into an address long before
  anything is funded and any quote that old has expired. EthFlow uses the `validTo` half to carry a
  deadline its order struct does not — it commits `uint32.max` and enforces expiry in ERC-1271 — which a
  pre-signed order must *not* do, since nothing gates it but the settlement contract's own check.

To emit it, redeclare the interface, or call `CowOrderPoster`: `presignAndAnnounce` if you can
delegatecall, or `setPreSignature` yourself and then `announce`, which refuses to emit an order that is
not really signed.

## Layout

Each package has its own short README — start with whichever part you're touching.

| | | |
|---|---|---|
| [`contracts/`](contracts/README.md) | The three contracts, why `DropExecutor` re-derives the address on every entry point, and why the build settings are load-bearing | foundry |
| [`packages/sdk/`](packages/sdk/README.md) | Compile a recipe, get an address, build the activation tx | TypeScript, viem |
| [`packages/watch-tower/`](packages/watch-tower/README.md) | Index `OrderPlacement` and post the orders to the order book, unattended | TypeScript, viem, cow-sdk |
| [`apps/web/`](apps/web/README.md) | The demo page: a form that turns into an address | Vite, React, cow-sdk |
| `recipes/` | Example `.drop.json` files | |

```
contracts/        lib/cow-shed pinned to cow-shed#78 (feat/owner-deploy-without-setup)
  src/DropExecutor.sol    the commitment check + activation
  src/steps/              the steps, one contract per dependency set (see below)
  src/lib/                internal libraries: inlined, never deployed, so they cost no address
    Orders.sol            order UID packing, limit-price math
    Allowance.sol         allowance handling
    CowOrder.sol          pre-sign an order and announce it as OrderPlacement
  src/interfaces/ICoWSwapOnchainOrders.sol   CoW's own event, redeclared
  src/CowOrderPoster.sol  the deployed helper, for third-party contracts placing an order
    Errors.sol            the errors more than one step contract raises
packages/sdk/src/
  recipe.ts               compileRecipe: recipe file -> address + committed bytes
  encoding.ts             the CREATE2 derivation, off-chain
  steps.ts                the step registry (extension point)
  templates.ts            swapOnArrival, twapOnArrival
packages/watch-tower/src/
  scanner.ts              find OrderPlacement anywhere on the chain, and verify it
  poster.ts               forward one order to the order book
  watchTower.ts           the loop, and where the block cursor advances
apps/web/src/App.tsx      the form, and the recipe it builds
```

## Quick start

```bash
# cow-shed carries its own submodules (forge-std, solady, openzeppelin), so this must be recursive
git submodule update --init --recursive

pnpm install
cd contracts && forge test              # 79 hermetic tests
cd ../packages/sdk && pnpm generate && pnpm build && pnpm test
cd ../watch-tower && pnpm build && pnpm test
cd ../../apps/web && pnpm dev           # http://localhost:5173
```

Post the discrete orders anyone places on-chain, unattended:

```bash
pnpm --filter @cowprotocol/cow-drop-watch-tower build
node packages/watch-tower/dist/cli.js --rpc-url $RPC_URL --state ./gnosis.json
```

To run the keeper, the watch tower and the UI together, see [RUNNING.md](RUNNING.md).

Fork tests against the real Gnosis deployments (skipped without the env var):

```bash
cd contracts
GNOSIS_RPC_URL=https://rpc.gnosischain.com forge test --match-path 'test/DropGnosisFork.t.sol'
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
escape hatch for anything not
covered, and is what the ABI-builder UI emits.

Limit prices are exact integer fractions, never floats: the result is committed into an address, so
a rounding difference between the UI and the SDK would be a *different address*, not merely a
slightly different price.

## Using the SDK

```ts
import { compileRecipe, buildActivateTx, twapOnArrival } from '@cowprotocol/cow-drop-sdk'

const recipe = twapOnArrival({
  chainId: 100,
  owner: '0xYourAddress',            // can always recover the funds
  sellToken: WXDAI,
  buyToken: COW,
  parts: 12,
  partDuration: 3600,
  limitPrice: { price: '45', sellDecimals: 18, buyDecimals: 18 },
  minAmount: 1000n * 10n ** 18n,     // refuse to start on a part-delivered balance
})

const { address, setupData, deployment } = compileRecipe(recipe)
// -> send funds to `address`, by any means. Nothing is deployed there yet.

const tx = buildActivateTx({ deployment, owner: recipe.owner, setupData })
await walletClient.sendTransaction(tx)   // anyone can send this
```

The functions you'll actually reach for:

| | |
|---|---|
| `compileRecipe(json)` | Recipe file → `{ address, setupData, recipe, deployment }`. Validates and throws on anything ambiguous. |
| `swapOnArrival` / `twapOnArrival` / `stopLossOnArrival` | Templates: a handful of parameters in, a complete recipe out. All take optional `minAmount` / `notBefore` / `notAfter` guards. |
| `steps.*` | Build steps by hand — including `requireMinBalance` / `requireTimeWindow` guards and `raw`. |
| `describeRecipe(setupData, deployment)` | Committed bytes → named steps, decoded arguments, and warnings about anything that cannot be named. |
| `deriveDropAddress(…)` | The CREATE2 derivation on its own, if you already have `setupData`. |
| `buildActivateTx(…)` | The activation transaction. Idempotent; safe to send twice. |
| `parseOrderPlacement` / `toOrderBookPayload` | Turn an activation receipt into an order-book submission. The event is the protocol's, so this decodes any on-chain order — EthFlow's included. |
| `hashCowOrder` / `orderUidFor` / `cowDomainSeparator` | The UID the announcement does not carry, computed offline. |

Full reference in [`packages/sdk/README.md`](packages/sdk/README.md).

The SDK deliberately does **not** depend on
[`@cowprotocol/cow-sdk`](https://www.npmjs.com/package/@cowprotocol/cow-sdk): deriving an address is a
pure, offline computation and must stay that way, so its only dependency is `viem`. Anything that
talks to CoW — quotes, order submission, chain metadata, explorer URLs — is the official SDK's job,
and the web app uses both. `OrderBookApi` posts the pre-signed orders and fetches quotes;
`getWrappedTokenForChain` and the chain objects supply metadata that would otherwise rot in a
hardcoded table here.

## Deployments

**The addresses are the same on every chain.** Every input to the CREATE2 derivation is itself
deployed deterministically with a zero salt from addresses that are identical everywhere, so a recipe
resolves to the same drop address on Gnosis, mainnet and everywhere else — verified by running the
deploy script against Gnosis and mainnet forks and diffing the output. Only *whether the contracts
exist there yet* differs, which the UI checks with `getCode`.

Addresses are recorded per **generation**, one deployment of the stack, under
`contracts/deployments/gen<N>/<chainId>.json`. Every address below feeds the CREATE2 preimage of every
drop, so a redeploy is a new generation with new drop addresses for the same recipe — never an update
in place. Past generations stay deployed and the SDK keeps their addresses in `GENERATIONS`, which is
what lets a recipe file pinned to an older generation still resolve to the address its author funded.
Bump `GENERATION` in `script/Deploy.s.sol` whenever any input to an address changes.

Generation 2 — the current one:

| Contract | Address | Status | vs. gen 1 |
|---|---|---|---|
| `COWShedWithExecutorSigner` | `0x1c4b988481d945c98a21446AB2960000d290aB22` | live on Gnosis ([cow-shed#79](https://github.com/cowdao-grants/cow-shed/pull/79)) | same |
| `COWShedExecutorFactory` | `0xD4B9497f258bf63A7f21d1DEAF26dA2F23e4DC99` | live on Gnosis ([cow-shed#79](https://github.com/cowdao-grants/cow-shed/pull/79)) | same |
| `GuardSteps` | `0x29a56c6C6019ab6a1A19B8a09Cce33CfC2900ed7` | **not yet broadcast** | same |
| `TokenSteps` | `0xEc4DC95baFceE0703f5aFFb4BdFc2cFF35b2781c` | **not yet broadcast** | same |
| `PresignSteps` | `0xd00cae373DE3a738D13ab7E1203a8d4662D4f1e0` | **not yet broadcast** | **moved** |
| `StopLossSteps` | `0xAD50014B6aE6050D8D640bF4EccbBb54dc2Df61C` | **not yet broadcast** | same |
| `TwapSteps` | `0xA03808Aa21Ea0874BeBC57Eb08806b7EAa4BbdC5` | **not yet broadcast** | same |
| `CowOrderPoster` | `0xeaCcAf23D2446208633c122dcC6a6Ab9fD62BA38` | **not yet broadcast** | **moved** |
| `DropExecutor` | `0xB61071638BE341F8959492838899907FDA1dA817` | live on Gnosis | same |

Generation 2 exists because `PresignSteps` and `CowOrderPoster` now announce an order as CoW's own
`OrderPlacement` rather than a `CowOrderPlaced` of this repository's invention, which changes their
bytecode and therefore their addresses. Nothing else moved — `SALT` does not depend on the generation and
no other contract's code changed, so `DropExecutor` keeps the address it is already deployed at. Both of
generation 1's replaced contracts were never broadcast on any chain, so nothing on-chain was orphaned;
generation 1 is kept anyway, because a recipe compiled against it resolves to a drop address somebody
may have funded, and that is the case a generation exists to protect. Generation 1's addresses are in
[`contracts/deployments/gen1/`](contracts/deployments/gen1/) and stay in the SDK's `GENERATIONS`.

**Generation 2 has not been broadcast.** `pnpm generate` has already pointed the SDK at it, so a recipe
compiled today resolves against the new `PresignSteps`; until the deploy runs, activating a path-P drop
reverts with `NoCodeAtDelegateTarget` — which the UI's `getCode` check surfaces before anyone funds
anything. Broadcast it with the command at the top of `script/Deploy.s.sol`.

Both cow-shed contracts are the canonical ones already live on Gnosis, reused rather than
redeployed — so **the only things this project deploys are its own seven contracts**, and a drop address
is derived entirely from official cow-shed code. Because a CREATE2 address is derived from init code,
landing on #79's addresses is also proof this repo reproduces the deployed bytecode, which is why
`contracts/foundry.toml` must stay byte-identical to cow-shed's.

Supported chains are listed in `packages/sdk/src/chains.ts`, and **both order paths work on all of
them** — ComposableCoW, the TWAP handler and `CurrentBlockTimestampFactory` are present at their usual
addresses on every one, checked against the chains rather than against composable-cow's
`networks.json`, which is missing entries for chains the contracts are in fact live on.

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
```

The script is idempotent: it skips anything already deployed at its deterministic address.

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

**Unaudited, and it depends on an unmerged four-deep PR stack.** Do not put real money in it yet.

## Status

Working and verified end-to-end on a Gnosis fork: a third party funds a counterfactual address,
activates it, and the real `GPv2Settlement` records the pre-signature for an order whose
`sellAmount` is the balance that arrived.

Not done yet:

- Broadcast to Gnosis (needs a funded deployer).
- **Activation** is still manual. [`packages/watch-tower`](packages/watch-tower/README.md) now posts
  the orders, but somebody still has to notice that funds arrived and send the activation
  transaction. A balance watcher that does that is the remaining half; a solver pre-interaction is
  the better answer for a real product.

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
- [`approve-and-bridge`](https://github.com/cowprotocol/approve-and-bridge) is the outbound mirror
  (swap then bridge, as a post-hook) and already uses cow-shed as its delegatecall context.
