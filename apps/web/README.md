# cow-drop web

A single page that turns a form into an address: pick a recipe, see the drop address update as you
type, fund it, activate it.

## Build and run

```bash
pnpm dev      # http://localhost:5173
pnpm build
```

| env var | |
|---|---|
| `VITE_KEEPER_URL` | Points the page at a [keeper](../../packages/keeper/README.md). Without it the **Hand to keeper** button is hidden and the page keeps drops locally only. |
| `VITE_RPC_URL` | Your own RPC for the default chain instead of the public one. |

## Against a local fork

```bash
anvil --fork-url https://rpc.gnosischain.com --chain-id 100 &
cd ../../contracts && forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
cd ../apps/web && VITE_RPC_URL=http://127.0.0.1:8545 pnpm dev
```

## Docs

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The panels, the keeper handoff, how recipes are kept, tokens and logos |
| [docs/DESIGN.md](../../docs/DESIGN.md) | What a drop is and what the address commits to |
