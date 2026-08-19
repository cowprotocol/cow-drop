# Run UI
VITE_KEEPER_URL=http://localhost:8787 pnpm --filter @cowprotocol/cow-drop-web dev

# Run keeper
KEEPER_PRIVATE_KEY=$(pass cow/pks/cow-drop/keeper) pnpm --filter @cowprotocol/cow-drop-keeper start --rpc-url $RPC_URL

# Run Watch Tower
pnpm --filter @cowprotocol/cow-drop-watch-tower start --rpc-url $RPC_URL

