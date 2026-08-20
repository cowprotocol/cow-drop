# cow-drop web

Four tabs over one page — no router, because a fragment does the whole job. **Recipes** turns a form
into an address: pick a recipe, see the drop address update as you type, fund it, activate it.
**Drops** lists what this browser saved and what the keeper holds for your account. **About** says what
a drop is and what the configured keeper will actually pay for. **SDK** shows how to do all of it in
code.

Links are shareable. `#/recipes/<recipe>` carries the recipe, the other three tabs carry nothing, and
**every link shared before the tabs existed still opens** — a fragment that is not a route is read as a
bare recipe on the Recipes tab.

## Build and run

```bash
pnpm dev      # http://localhost:5173
pnpm build
```

| env var | |
|---|---|
| `VITE_KEEPER_URL` | Points the page at a [keeper](../../packages/keeper/README.md). Without it the **Hand to keeper** button is hidden, the Drops tab shows only this browser's own records, and the About tab drops its live panel. |
| `VITE_RPC_URL` | Your own RPC for the default chain instead of the public one. |

Both are build-time values, which is right for `pnpm dev` and wrong for a container image — Vite
would bake them into the bundle, pinning the image to one environment. So the published image reads
`KEEPER_URL` and `RPC_URL` at **container start** instead and writes them into `/config.js`, which
takes precedence over the `VITE_*` pair. See [`src/lib/runtimeConfig.ts`](src/lib/runtimeConfig.ts)
and [docs/RELEASING.md](../../docs/RELEASING.md).

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
