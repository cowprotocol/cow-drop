# cow-drop contracts

`DropExecutor`, five step contracts and a few shared libraries: the on-chain half of a drop, where a
recipe is checked against the address that commits to it.

## Build and test

```bash
git submodule update --init --recursive   # cow-shed has its own submodules
forge build
forge test                                # 79 hermetic tests
forge fmt
```

Fork tests against the real Gnosis deployments, skipped unless the env var is set:

```bash
GNOSIS_RPC_URL=https://rpc.gnosischain.com forge test --match-path 'test/DropGnosisFork.t.sol'
```

## Deploy

```bash
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify --private-key $PK
```

Idempotent — it skips anything already deployed at its deterministic address. A redeploy is a new
**generation** with new drop addresses for the same recipe, so read
[docs/DEPLOYMENTS.md](../docs/DEPLOYMENTS.md) first. Afterwards, regenerate the SDK's constants with
`pnpm --filter @cowprotocol/cow-drop-sdk generate`.

## Docs

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | What each contract does, why the split is what it is, the build settings, and the test map |
| [docs/DEPLOYMENTS.md](../docs/DEPLOYMENTS.md) | Addresses, generations, scripts and verification |
| [docs/DESIGN.md](../docs/DESIGN.md) | The commitment scheme the contracts implement |
