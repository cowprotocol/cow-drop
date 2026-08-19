# Set the RPC_URL
RPC_URL=

# Run UI
VITE_KEEPER_URL=http://localhost:8787 pnpm --filter @cowprotocol/cow-drop-web dev

# Run keeper
KEEPER_PRIVATE_KEY=$(pass cow/pks/cow-drop/keeper) pnpm --filter @cowprotocol/cow-drop-keeper start --rpc-url $RPC_URL

# Run Watch Tower (not needed for DEMO)
pnpm --filter @cowprotocol/cow-drop-watch-tower start --rpc-url $RPC_URL --only-drops

# Same two, restarting on every source edit (no rebuild needed)
KEEPER_PRIVATE_KEY=$(pass cow/pks/cow-drop/keeper) pnpm dev:keeper --rpc-url $RPC_URL
pnpm dev:watch-tower --rpc-url $RPC_URL --only-drops


# Transfer
https://sepolia.etherscan.io/address/0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14#writeContract


```bash
SEPOLIA_WETH=0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14


TO= cast send $WETH "transfer(address,uint256)" $TO $(cast to-wei 0.01) --private-key $(pass cow/pks/scripts-work)

```
