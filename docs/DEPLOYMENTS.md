# Deployments

The records under [`contracts/deployments/`](../contracts/deployments/) are the source of truth for
addresses. This document is what they cannot say: what a *generation* is, why a redeploy is one rather
than an update, and how to tell what is actually on a chain. The deploy command is in the
[README](../README.md#deploy-contracts).

## The records

`script/Deploy.s.sol` writes one file per (generation, chain), `deployments/gen<N>/<chainId>.json`, and
`pnpm --filter @cowprotocol/cow-drop-sdk generate` reads every `gen*/` and emits them all as the SDK's
`GENERATIONS` — so no address is ever transcribed by hand. Past directories are never touched.

Within a generation the addresses are identical on every chain: every input to the CREATE2 derivation is
itself deployed with a zero salt from addresses that are the same everywhere. The files therefore differ
only in `chainId`, which is why there is no address table in this document.

**A record is not proof of a deployment.** The script writes one in dry-run too, so a file exists for
every chain the script was ever pointed at, broadcast or not. What exists is a `getCode` question — the
UI asks it before anyone funds anything, and so can you:

```sh
for a in $(jq -r 'to_entries[]|select(.value|type=="string")|.value' contracts/deployments/gen2/100.json); do
  [ "$(cast code "$a" --rpc-url "$RPC_URL")" = 0x ] && echo "missing $a"
done
```

Activating a drop whose step contracts are not there reverts with `NoCodeAtDelegateTarget`.

## Generations

`GENERATION` in `script/Deploy.s.sol` names one deployment of the stack. Every address the script prints
is part of the CREATE2 preimage of every drop, so changing the code, a constructor argument or a compiler
setting moves **every** drop address. A recipe file therefore cannot mean anything on its own — it has to
say which generation it was compiled against, which is what `DropRecipeJson.generation` is for, and why it
defaults to 1 rather than to the latest. Old generations stay deployed, so an old file keeps resolving to
the address its author funded.

Bump it whenever any input to an address changes; leave the previous directory alone. Generation 2 exists
because `PresignSteps` and `CowOrderPoster` moved to CoW's own `OrderPlacement` event, changing their
bytecode. Everything else kept its generation-1 address, `DropExecutor` included, because `SALT` does not
depend on the generation.

Two contracts sit outside every drop address and so cost no generation when they change:
`CowOrderPoster`, which the steps reach by inlining the `CowOrder` library rather than by calling it, and
`DropBungeeReceiver`, which only ever calls `activate`. That is why the receiver could join generation 2
instead of starting a third. They ship with the generation anyway because a third-party integration and a
bridge quote respectively are made against their addresses, so those have to be recorded.

The two cow-shed contracts in the records are the canonical ones from
[cow-shed#79](https://github.com/cowdao-grants/cow-shed/pull/79) rather than variants of our own — reused
where they already exist, landing on the same addresses where they do not. That the addresses match #79's
is what proves this build reproduces the canonical bytecode; see
[Build settings are load-bearing](../contracts/ARCHITECTURE.md#build-settings-are-load-bearing).

## Scripts

| | |
|---|---|
| `script/Deploy.s.sol` | Deploys the stack. Idempotent: skips anything already at its deterministic address. Writes the records above. |
| `script/Fixtures.s.sol` | Regenerates `deployments/derivation-fixtures.json`, the ground truth the SDK's derivation is tested against. |
| `script/DropConfig.sol` | Addresses of the CoW and composable-cow contracts we build on. |

## Verifying

`--verify` on the deploy script covers Etherscan-family explorers. Sourcify is worth checking separately,
because it is what Foundry's own trace decoding, Otterscan and several simulators read — a contract missing
there shows up as a bare address in a `cast run` trace even though the block explorer renders it fine.

**`forge verify-contract --verifier sourcify` cannot be trusted right now.** Sourcify's API v1 is in a
scheduled brownout until 2027-01-08, forge (1.5.1) still probes v1 to decide whether a contract is already
verified, and it reads the brownout error as "already verified. Skipping verification" — so it reports
success without submitting anything. Check with the v2 API instead:

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

That returns a `verificationId`; poll `GET /v2/verify/<verificationId>` until it completes. The cow-shed
identifiers are `lib/cow-shed/src/COWShedExecutorFactory.sol:COWShedExecutorFactory` and
`lib/cow-shed/src/COWShedWithExecutorSigner.sol:COWShedWithExecutorSigner` — both compile from the pinned
submodule under this crate's settings, so no separate build is needed.

Note that `bytecode_hash = "none"` and `cbor_metadata = false` mean there is no metadata hash to match on,
so a verification lands as `match` rather than `exact_match`. That is expected here, not a failure.

A drop address itself is never verified, and never can be before it is used: it has no code until someone
activates it. An empty `eth_getCode` there means "not activated yet", not "unverified".
