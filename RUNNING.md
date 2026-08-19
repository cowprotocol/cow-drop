# Running the stack

Once, for all three:

```bash
git submodule update --init --recursive
pnpm install
pnpm build
export RPC_URL=https://rpc.gnosischain.com
```

## UI

```bash
cd apps/web
VITE_KEEPER_URL=http://localhost:8787 pnpm dev   # http://localhost:5173
```

Drop `VITE_KEEPER_URL` to hide the **Hand to keeper** button. `VITE_RPC_URL` overrides the RPC.

## Watch tower

Posts the discrete orders any contract places on-chain. Nothing privileged, no key.

```bash
node packages/watch-tower/dist/cli.js --rpc-url $RPC_URL --state ./gnosis.json
```

Add `--dry-run` to verify without posting, `--only-drops` to ignore other contracts' orders.

## Keeper

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
