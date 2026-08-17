# defi-drop contracts

Three contracts. One of them carries the entire security argument.

```bash
git submodule update --init --recursive   # cow-shed has its own submodules
forge test                                # 30 hermetic tests
forge fmt
```

## What each contract does

### `DropExecutor.sol` — the one that matters

Every drop names this contract as both its `trustedExecutor` and its `setupTarget`. It answers one
question: *does this recipe belong to this address?*

```solidity
dropOf(owner, setupData)          // the address a recipe resolves to
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

**Why the salt is always zero.** `setup` receives only `(shed, owner, setupData)`. A non-zero user
salt couldn't be recovered from those, so the address couldn't be re-derived. Uniqueness comes from
the recipe bytes instead; the `label` field exists so two otherwise-identical recipes can have two
addresses.

**Why drops are re-triggerable.** `trustedExecuteHooks` consumes no nonce, so a recipe can run again
on funds that arrive later — which is what makes a reusable deposit address work. Set `once` for
one-shot recipes; `DropExecutor` enforces it with a per-drop flag, written before the calls so a
revert rolls it back.

### `DropRecipes.sol` — the steps a recipe is built from

**Every function here is delegatecalled by the drop** (`Call.isDelegateCall = true`). That's what
makes `address(this)` the drop, so `balanceOf(address(this))` is the amount that *actually arrived*.
It's the reason a drop can commit to "split whatever lands here into 12 parts" without committing to
a number nobody could have known when the address was computed.

Immutables are readable under delegatecall (they live in the code, not storage), which is why the
deployment addresses work. Storage wouldn't, and this contract deliberately has none.

| | |
|---|---|
| `presignSellAll(…)` | Sell the whole balance as one pre-signed CoW order. Emits `DropOrderPlaced` so an off-chain poster can submit it. |
| `twapFromBalance(…)` | Split the whole balance into `n` parts and register a TWAP with ComposableCoW. |
| `requireMinBalance(token, min)` | Guard: revert unless enough has arrived. `token = address(0)` for native. |
| `requireTimeWindow(from, to)` | Guard: revert outside an absolute window. `0` means unbounded. |
| `wrapNative(wrapped)` | Wrap the whole native balance, so xDAI/ETH-funded drops can trade. |
| `approveMax(token, spender)` | For the generic step builder; the order primitives handle their own allowances. |

Events emitted here come *from the drop*, since that's `address(this)` under delegatecall — which is
what lets a poster filter `DropOrderPlaced` by drop address.

### `DropOrders.sol` — order plumbing

Order UID packing (`digest ++ owner ++ validTo`), the `sell`/`erc20` flag constants, and exact
integer limit-price arithmetic. Order *hashing* is not reimplemented — `cow-shed/LibCowOrder.sol`
already has the canonical assembly version, and two would be one too many.

## The two order paths

`presignSellAll` needs nothing from the shed implementation: the drop signs its own order on-chain
and an off-chain poster makes it visible. `twapFromBalance` needs the drop to answer ERC-1271, which
`COWShedForComposableCoW` does by forwarding to ComposableCoW — after which the watch tower posts
each part unattended. One factory serves both, because the composable implementation is a superset.

For the TWAP params to be committable into the address they must not mention the owner, so
`receiver = address(0)` (ComposableCoW's "pay the owner" sentinel) and `t0 = 0` with
`createWithContext` seeding the start time from a value factory at activation.

## Build settings are load-bearing

`foundry.toml` must stay byte-identical to cow-shed's (`solc 0.8.30`, `via_ir`,
`optimizer_runs = 1_000_000`, `bytecode_hash = "none"`, `cbor_metadata = false`,
`evm_version = "prague"`).

We compile `COWShedForComposableCoW` and `COWShedExecutorFactory` from the pinned submodule and
deploy them ourselves. The implementation address ends up inside every drop's CREATE2 init code and
the factory is the CREATE2 deployer, so a change to any compiler setting silently moves **every drop
address**. It also means our build reproduces the canonical cow-shed bytecode — verified, since
deploying the implementation collides with the one already live on Gnosis.

## Tests

| file | what it covers |
|---|---|
| `DropExecutor.t.sol` | Derivation, activation, `once` semantics, recovery, and the attacks: forged recipes, wrong owner, foreign trusted executor, non-zero salt, direct `trustedExecuteHooks`. |
| `DropRecipes.t.sol` | Each primitive, run the way it really runs — delegatecalled from inside a drop by an activation nobody signed. |
| `DropGnosisFork.t.sol` | Against the real Gnosis deployments. Skipped unless `GNOSIS_RPC_URL` is set, so the default suite is hermetic. |

The load-bearing fork test is `test_fork_twapIsTradeableAndTheDropValidatesTheSignature`: it does
exactly what the watch tower does — `getTradeableOrderWithSignature`, then hand the signature back to
the owner's `isValidSignature` — for a non-Safe owner. If a cow-shed drop couldn't own a conditional
order, that's where it would show up.

```bash
GNOSIS_RPC_URL=https://rpc.gnosischain.com forge test --match-path 'test/DropGnosisFork.t.sol'
```

## Scripts

| | |
|---|---|
| `script/Deploy.s.sol` | Deploys the stack. Idempotent: skips anything already at its deterministic address. Writes `deployments/<chainId>.json`, which the SDK generates its constants from. |
| `script/Fixtures.s.sol` | Regenerates `deployments/derivation-fixtures.json`, the ground truth the SDK's derivation is tested against. |
| `script/DropConfig.sol` | Per-chain addresses of the CoW and composable-cow contracts we build on. |
