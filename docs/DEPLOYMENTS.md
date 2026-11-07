# Deployments

The records under [`contracts/deployments/`](../contracts/deployments/) are the source of truth for
addresses. This document is what they cannot say: what a *generation* is, why a redeploy is one rather
than an update, and how to tell what is actually on a chain. The deploy command is in the
[README](../README.md#deploy-contracts).

**The addresses are the same on every chain.** Every input to the CREATE2 derivation is itself deployed
deterministically with a zero salt from addresses that are identical everywhere, so a recipe resolves to
the same drop address on Gnosis, mainnet and everywhere else — verified by running the deploy script
against Gnosis and mainnet forks and diffing the output. Only *whether the contracts exist there yet*
differs.

Supported chains are listed in `packages/sdk/src/chains.ts`, and **both order paths work on all of
them** — ComposableCoW, the TWAP handler and `CurrentBlockTimestampFactory` are present at their usual
addresses on every one, checked against the chains rather than against composable-cow's `networks.json`,
which is missing entries for chains the contracts are in fact live on.

## The records

`script/Deploy.s.sol` writes one file per (generation, chain), `deployments/gen<N>/<chainId>.json`, and
`pnpm --filter @cowprotocol/cow-drop-sdk generate` reads every `gen*/` and emits them all as the SDK's
`GENERATIONS` — so no address is ever transcribed by hand. Past directories are never touched.

Within a generation the files differ only in `chainId`, for the reason above. **That is why there is no
address table here.** One existed, listing every contract and its per-chain state by hand; it was wrong
within weeks, and it was wrong in the direction that matters — it called seven live contracts "not yet
broadcast", which is the kind of claim that stops someone funding an address that would have worked.

**A record is not proof of a deployment.** The script writes one in dry-run too, so a file exists for
every chain the script was ever pointed at, broadcast or not. What is actually there is a `getCode`
question — the UI asks it before anyone funds anything, and so can you:

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
bytecode. Nothing else moved: `SALT` does not depend on the generation, so `DropExecutor` keeps the
address it is already deployed at, and generation 1 stays in
[`contracts/deployments/gen1/`](../contracts/deployments/gen1/) and in the SDK's `GENERATIONS`.

Two contracts in the records sit outside every drop address, and so cost no generation when they change:
`CowOrderPoster`, which the steps reach by inlining the `CowOrder` library rather than by calling it, and
`DropBungeeReceiver`, which only ever calls `activate`. That is why the receiver could join generation 2
instead of starting a third. They ship with the generation anyway because a third-party integration and a
bridge quote respectively are made against their addresses, so those have to be recorded.

`PaymentSteps` joined generation 2 late for a narrower reason. It *is* an input to a drop address, but
only to recipes that name a payment step, and none existed before it — so adding it moved no address.
`DropAddresses.paymentSteps` is optional in the SDK because generation 1 has none, and a chain that was
deployed before it was added will not have it until the script is run again. That is exactly the case the
`getCode` sweep above is for.

The two cow-shed contracts in the records are the canonical ones from
[cow-shed#79](https://github.com/cowdao-grants/cow-shed/pull/79) rather than variants of our own — reused
where they already exist, landing on the same addresses where they do not. **The only things this project
deploys are its own nine contracts**, and a drop address derives entirely from official cow-shed code.
Since a CREATE2 address comes from init code, landing on #79's addresses is what proves this build
reproduces the canonical bytecode; see
[Build settings are load-bearing](../contracts/ARCHITECTURE.md#build-settings-are-load-bearing).

## Scripts

| | |
|---|---|
| `script/Deploy.s.sol` | Deploys the stack. Idempotent: skips anything already at its deterministic address. Writes the records above. |
| `script/Fixtures.s.sol` | Regenerates `deployments/derivation-fixtures.json`, the ground truth the SDK's derivation is tested against. |
| `script/DropConfig.sol` | Per-chain addresses of the CoW and composable-cow contracts we build on. |

## Verifying

`--verify` on the deploy script covers Etherscan-family explorers. Sourcify is worth checking separately,
because it is what Foundry's own trace decoding, Otterscan and several simulators read — a contract
missing there shows up as a bare address in a `cast run` trace even though the block explorer renders it
fine. Which addresses are verified is another thing not worth writing down, for the same reason the
address table was not; ask:

```sh
curl -s https://sourcify.dev/server/v2/contract/100/0xB61071638BE341F8959492838899907FDA1dA817 | jq .match
```

**Do not trust `forge verify-contract --verifier sourcify` to tell you it worked.** Sourcify's API v1 is
gone — `/check-all-by-addresses` now answers `404 API v1 is removed` — and forge probes v1 to decide
whether a contract is already verified. Historically it read that failure as "already verified. Skipping
verification" and reported success without submitting anything. Check the result with the v2 query above
rather than believing the command's output.

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
