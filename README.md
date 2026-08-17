# defi-drop

A funding address that already knows what to do.

Compute an address, send funds to it — by bridge, exchange withdrawal, payroll, plain transfer —
and anyone can trigger the trading logic that was baked into it. There is no signature anywhere in
the flow, because the recipe is committed into the address itself.

> Working name. See [Naming](#naming).

## The idea

A cow-shed address today commits to exactly one thing: its owner.

```
salt     = bytes32(uint160(owner))
initCode = COWShedProxy.creationCode ++ abi.encode(implementation, owner)
```

Every action then needs the owner to sign, at the moment of acting.

defi-drop inverts that. Using [cow-shed#64](https://github.com/cowdao-grants/cow-shed/pull/64)'s
deploy-time setup call, the address commits to a **recipe**:

```
salt = keccak256(abi.encode(owner, trustedExecutor, 0, setupTarget, keccak256(setupData)))
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
- **Recoverable.** The shed's admin is the `owner`, so a drop with a broken recipe is never lost
  funds — the owner can always sweep it with an ordinary signed `executeHooks`.

## Two order paths

| | Path P — pre-sign | Path C — composable |
|---|---|---|
| Recipe | `presignSellAll` | `twapFromBalance` |
| Needs ERC-1271 | no | yes (`COWShedForComposableCoW`) |
| Needs a watch tower | no | yes, and it is automatic |
| After activation | an off-chain poster submits the order | self-driving; each part is posted for you |
| Good for | swap whatever arrived, once | TWAP and anything recurring |

Both share a single factory: the ComposableCoW-aware shed implementation is a superset, since
pre-signing needs nothing from the implementation.

## Layout

```
contracts/        foundry; lib/cow-shed pinned to cow-shed#64 (feat/deploy-time-setup-call)
  src/DropExecutor.sol    the commitment check + activation
  src/DropRecipes.sol     recipe primitives, delegatecalled by the drop
  src/DropOrders.sol      order UID packing, limit-price math
packages/sdk/     address derivation, recipe format, templates
apps/web/         Vite + React SPA: build a recipe, get an address
recipes/          example .drop.json files
```

## Quick start

```bash
# cow-shed carries its own submodules (forge-std, solady, openzeppelin), so this must be recursive
git submodule update --init --recursive

pnpm install
cd contracts && forge test              # 24 hermetic tests
cd ../packages/sdk && pnpm generate && pnpm build && pnpm test
cd ../../apps/web && pnpm dev           # http://localhost:5173
```

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
  "label": "WXDAI -> COW over 12h",
  "chainId": 100,
  "owner": "0x…",
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

Adding a capability is a new entry in the step registry (`packages/sdk/src/steps.ts`) plus a
matching primitive in `DropRecipes.sol`. `{"type": "raw"}` is the escape hatch for anything not
covered, and is what the ABI-builder UI emits.

Limit prices are exact integer fractions, never floats: the result is committed into an address, so
a rounding difference between the UI and the SDK would be a *different address*, not merely a
slightly different price.

## Deployments

Gnosis (chain 100). Addresses are CREATE2 with a zero salt, so they are deterministic and were
verified by deploying against a Gnosis fork.

| Contract | Address | Status |
|---|---|---|
| `COWShedForComposableCoW` (v2.1.0) | `0xF0D400089d5b9fACA64E3422AD6614546587cfFB` | already deployed |
| `COWShedExecutorFactory` | `0xdaB53E4DA62fc84D0A96b130E647a61755028FDD` | **not yet broadcast** |
| `DropRecipes` | `0xC5169644b3B3e9253FB0eaC0d4e98D2e4d6f0210` | **not yet broadcast** |
| `DropExecutor` | `0xB5C464EC6a288a6aa8146415697d6c53DCFE9b2b` | **not yet broadcast** |

The shed implementation is the *canonical* cow-shed v2.1.0 build, not a fork — and because a CREATE2
address is derived from its init code, reusing it is proof this repo reproduces the official
bytecode. That is also why `contracts/foundry.toml` must stay byte-identical to cow-shed's.

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

- **`salt` is always zero.** `ICOWShedSetup.setup` receives only `(shed, owner, setupData)`, so a
  non-zero salt could not be recovered on-chain and the commitment could not be re-derived.
  Uniqueness comes from the recipe bytes; `label` exists to differentiate otherwise-identical
  recipes.
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
- `packages/keeper` — a balance watcher that activates drops and posts orders unattended. The UI
  covers this manually for now; [`bridge-and-swap`](https://github.com/cowprotocol/bridge-and-swap)'s
  `backend/` is a working reference, though its `getLogs` has no address filter and its factory
  verification is commented out, so both need fixing before reuse.
- A custom step-builder tab in the UI (the `raw` step type is supported by the SDK already).

## Known constraints

- **Nothing upstream is merged.** The stack is cow-shed `#61 → #64 → #67 → PR2`, all unreviewed.
  The submodule is pinned to a commit; expect rebases. Any change to the shed implementation changes
  its address, which changes `initCodeHash`, which changes **every** drop address — so treat the
  deployment as a versioned generation from day one.
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
  per-order contract. defi-drop generalizes that to any recipe and reuses cow-shed instead. Worth
  deciding whether one subsumes the other for the single-order case.
- [`approve-and-bridge`](https://github.com/cowprotocol/approve-and-bridge) is the outbound mirror
  (swap then bridge, as a post-hook) and already uses cow-shed as its delegatecall context.

## Naming

`defi-drop` is a placeholder. `trough` is the current favourite — you pour things in and the cow does
the rest, and it sits in the cow-shed family without claiming to be part of it. Runners-up: `feeder`,
`milk-run`, `drop-shed`.
