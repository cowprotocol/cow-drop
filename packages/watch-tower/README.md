# @cowprotocol/cow-drop-watch-tower

Post the discrete CoW orders that contracts place on-chain.

A pre-signature is on-chain the moment the order is placed — the order is valid, the relayer is
approved, the money is there — but nothing has told the order book the order exists, so no solver sees
it. This watches CoW's own `OrderPlacement` event, verifies what it finds against the settlement
contract, and forwards it to `POST /api/v1/orders`. It started as cow-drop's poster and is not limited
to it: any contract that emits the event is picked up, EthFlow included.

## Build and run

```bash
pnpm --filter @cowprotocol/cow-drop-watch-tower build
pnpm --filter @cowprotocol/cow-drop-watch-tower test

cow-drop-watch-tower --rpc-url https://rpc.gnosischain.com
```

Or from the repo root, without linking the binary:

```bash
node packages/watch-tower/dist/cli.js --rpc-url $RPC_URL
```

Nothing here is privileged: the orders are already signed on-chain, so posting one only makes it
visible, and a duplicate counts as success.

## CLI

```
--rpc-url <url>       RPC endpoint. Defaults to $RPC_URL.
--chain-id <id>       Defaults to $CHAIN_ID, else whatever the RPC says.
--generation <n>      Contract generation to watch. Defaults to the latest.
--from-block <n>      First block when there is no saved state. Default: the current head.
--state <path>        JSON file for the block cursor. Default out/watch-tower/cursor-<chainId>.json.
--confirmations <n>   Blocks to stay behind the head. Default 2.
--max-block-range <n> Largest getLogs range. Default 10000.
--poll <seconds>      Seconds between passes once caught up. Default 15.
--env <prod|staging>  Which order book to post to. Default prod.
--only-drops          Post only orders from a cow-drop activation, not every contract's.
--once                Scan one range and exit. For cron.
--dry-run             Find and verify orders, post nothing.
--quiet               Errors only.
```

## Docs

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The event, what is verified before posting, failure and restart semantics, and the library API |
| [docs/DESIGN.md](../../docs/DESIGN.md) | Why the announcement is CoW's own event and not a new one |
