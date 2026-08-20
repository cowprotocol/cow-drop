# Deployments

Where the contracts live, why a redeploy is a new *generation* rather than an update, and how to
verify what was deployed. The commands to run a deploy are in the [README](../README.md#deploy).

**The addresses are the same on every chain.** Every input to the CREATE2 derivation is itself
deployed deterministically with a zero salt from addresses that are identical everywhere, so a recipe
resolves to the same drop address on Gnosis, mainnet and everywhere else — verified by running the
deploy script against Gnosis and mainnet forks and diffing the output. Only *whether the contracts
exist there yet* differs, which the UI checks with `getCode`.

Supported chains are listed in `packages/sdk/src/chains.ts`, and **both order paths work on all of
them** — ComposableCoW, the TWAP handler and `CurrentBlockTimestampFactory` are present at their usual
addresses on every one, checked against the chains rather than against composable-cow's
`networks.json`, which is missing entries for chains the contracts are in fact live on.

## Generations

`GENERATION` in `contracts/script/Deploy.s.sol` names one deployment of the stack, and each one writes
its own `contracts/deployments/gen<N>/<chainId>.json`. Past directories are never touched.

Every address the script prints is part of the CREATE2 preimage of every drop, so changing the code, the
constructor arguments or a compiler setting moves **every** drop address. A recipe file therefore cannot
mean anything on its own — it has to say which generation it was compiled against, which is what
`DropRecipeJson.generation` is for, and why it defaults to 1 rather than the latest. Old generations stay
deployed, so an old file keeps resolving to the address its author funded.

Bump it whenever any input to an address changes, and let `pnpm --filter @cowprotocol/cow-drop-sdk
generate` pick the new directory up — it reads every `gen*/` and emits them all as `GENERATIONS`.

## Generation 2 — the current one

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
| `DropBungeeReceiver` | `0xbF4B4b7Ab60A2435177753ae32E2619627DC7e3C` | **not yet broadcast** | new |
| `DropExecutor` | `0xB61071638BE341F8959492838899907FDA1dA817` | live on Gnosis | same |

Generation 2 exists because `PresignSteps` and `CowOrderPoster` changed bytecode, and therefore addresses.
Nothing else moved: `SALT` does not depend on the generation and no other contract's code changed, so
`DropExecutor` keeps the address it is already deployed at. Generation 1's addresses stay in
[`contracts/deployments/gen1/`](../contracts/deployments/gen1/) and in the SDK's `GENERATIONS`, because a
recipe compiled against it resolves to an address somebody may have funded.

`DropBungeeReceiver` joined generation 2 rather than starting a generation 3 because **no drop address
depends on it** — nothing in a recipe reaches a receiver, so it is not an input to any CREATE2 preimage.
It is recorded here only because a bridge route is quoted against its address.
`DropAddresses.bungeeReceiver` is optional in the SDK for the same reason.

**Generation 2 has not been broadcast.** `pnpm generate` has already pointed the SDK at it, so a recipe
compiled today resolves against the new `PresignSteps`. Until the deploy runs, activating a path-P drop
reverts with `NoCodeAtDelegateTarget`, which the UI's `getCode` check surfaces before anyone funds anything.

Both cow-shed contracts are the canonical ones already live on Gnosis, so **the only things this project
deploys are its own seven contracts** and a drop address derives entirely from official cow-shed code.
Since a CREATE2 address comes from init code, landing on #79's addresses is proof this repo reproduces the
deployed bytecode — which is why `contracts/foundry.toml` must stay byte-identical to cow-shed's.

## Scripts

| | |
|---|---|
| `script/Deploy.s.sol` | Deploys the stack. Idempotent: skips anything already at its deterministic address. Writes `deployments/gen<N>/<chainId>.json`, which the SDK generates its constants from. |
| `script/Fixtures.s.sol` | Regenerates `deployments/derivation-fixtures.json`, the ground truth the SDK's derivation is tested against. |
| `script/DropConfig.sol` | Per-chain addresses of the CoW and composable-cow contracts we build on. |

## Verifying

`--verify` on the deploy script covers Etherscan-family explorers, and all four addresses are verified
on Gnosisscan. Sourcify is the one worth checking separately, because it is what Foundry's own trace
decoding, Otterscan and several simulators read — a contract missing there shows up as a bare address
in a `cast run` trace even though the block explorer renders it fine.

**`forge verify-contract --verifier sourcify` cannot be trusted right now.** Sourcify's API v1 is in a
scheduled brownout until 2027-01-08, forge (1.5.1) still probes v1 to decide whether a contract is
already verified, and it reads the brownout error as "already verified. Skipping verification" — so it
reports success without submitting anything. Check with the v2 API instead:

```sh
curl -s https://sourcify.dev/server/v2/contract/100/0xB61071638BE341F8959492838899907FDA1dA817 | jq .match
```

To submit, POST the standard JSON input to v2 directly. `forge` still generates that input correctly:

```sh
forge verify-contract --show-standard-json-input \
  0xB61071638BE341F8959492838899907FDA1dA817 src/DropExecutor.sol:DropExecutor > executor.stdjson

jq -n --slurpfile std executor.stdjson '{
  stdJsonInput: $std[0],
  compilerVersion: "0.8.30+commit.73712a01",
  contractIdentifier: "src/DropExecutor.sol:DropExecutor"
}' | curl -s -X POST -H 'content-type: application/json' --data @- \
  https://sourcify.dev/server/v2/verify/100/0xB61071638BE341F8959492838899907FDA1dA817
```

That returns a `verificationId`; poll `GET /v2/verify/<verificationId>` until it completes. The other
two identifiers are `lib/cow-shed/src/COWShedExecutorFactory.sol:COWShedExecutorFactory` and
`lib/cow-shed/src/COWShedWithExecutorSigner.sol:COWShedWithExecutorSigner` — both compile from the
pinned submodule under this crate's settings, so no separate build is needed.

Note that `bytecode_hash = "none"` and `cbor_metadata = false` mean there is no metadata hash to match
on, so a verification lands as `match` rather than `exact_match`. That is expected here, not a failure.

A drop address itself is never verified, and never can be before it is used: it has no code until
someone activates it. An empty `eth_getCode` there means "not activated yet", not "unverified".
