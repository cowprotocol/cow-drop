<img src="apps/web/public/logo.png" alt="" width="150" align="right" />

# cow-drop

Drop your tokens into an address and the cow does the rest.

Compute an address, send funds to it — by bridge, exchange withdrawal, payroll, plain transfer —
and anyone can trigger the trading logic that was baked into it. There is no signature anywhere in
the flow, because the recipe is committed into the address itself.

**Unaudited, and it depends on an unmerged cow-shed PR stack. Do not put real money in it yet.**

## Docs

|                                                           |                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [docs/DESIGN.md](docs/DESIGN.md)                          | How it works: the commitment, the two order paths, the recipe format, security and rescue |
| [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md)                | Addresses, generations, and verification                                                  |
| [`contracts/`](contracts/README.md)                       | `DropExecutor` and the step contracts — foundry                                           |
| [`packages/sdk/`](packages/sdk/README.md)                 | Compile a recipe, get an address, build the activation tx — TypeScript, viem              |
| [`packages/watch-tower/`](packages/watch-tower/README.md) | Index `OrderPlacement` and post the orders to the order book                              |
| [`packages/keeper/`](packages/keeper/README.md)           | Activate registered drops and pay the gas                                                 |
| [`apps/web/`](apps/web/README.md)                         | The demo page: a form that turns into an address — Vite, React                            |
| `recipes/`                                                | Example `.drop.json` files                                                                |

## Build

```bash
# cow-shed carries its own submodules (forge-std, solady, openzeppelin), so this must be recursive
git submodule update --init --recursive

pnpm install
pnpm build
```

## Test

```bash
pnpm test:contracts   # 79 hermetic forge tests
pnpm test             # the TypeScript packages
```

Fork tests against the real Gnosis deployments (skipped without the env var):

```bash
cd contracts
GNOSIS_RPC_URL=https://rpc.gnosischain.com forge test --match-path 'test/DropGnosisFork.t.sol'
```

## Run locally

Assumes `pnpm build` has run, and:

```bash
export RPC_URL=https://rpc.gnosischain.com
```

### UI

```bash
VITE_KEEPER_URL=http://localhost:8787 pnpm --filter @cowprotocol/cow-drop-web dev
# http://localhost:5173
```

Drop `VITE_KEEPER_URL` to hide the **Hand to keeper** button. `VITE_RPC_URL` overrides the RPC.

### Watch tower

Posts the discrete orders any contract places on-chain. Nothing privileged, no key.

```bash
node packages/watch-tower/dist/cli.js --rpc-url $RPC_URL --state ./gnosis.json
```

Add `--dry-run` to verify without posting, `--only-drops` to ignore other contracts' orders.

### Keeper

Activates registered drops and pays the gas, so it needs a funded hot key. It runs its own watch
tower in-process — **don't run both.**

```bash
echo 0x<hot-key> > ./keeper.key && chmod 600 ./keeper.key
node packages/keeper/dist/cli.js \
  --rpc-url $RPC_URL --private-key-file ./keeper.key \
  --state ./keeper.json --cursor ./gnosis.json --port 8787
```

Add `--dry-run` to decide and simulate without broadcasting. `curl localhost:8787/v1/health` for the
payer, its balance and the budget left. The default policy subsidises every owner up to a small daily
budget — pass `--policy` before pointing anything public at it.

## Deploy contracts

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify --private-key $PK
```

The script is idempotent: it skips anything already deployed at its deterministic address. A redeploy
is a new **generation** with new drop addresses for the same recipe, never an update in place — see
[docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md) before running it.

Regenerate the SDK's constants afterwards:

```bash
pnpm --filter @cowprotocol/cow-drop-sdk generate
```
