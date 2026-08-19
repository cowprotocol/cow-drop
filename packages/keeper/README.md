# @cowprotocol/cow-drop-keeper

Watch registered drops, activate them when they are ready, and pay the gas.

A drop is funded before it exists and activation is permissionless — but somebody still has to
*notice* the funds arrived and send the transaction. Otherwise that is a person with the page open,
clicking **Activate**. This does it unattended, for drops whose owner explicitly asked it to. It runs
an in-process [watch tower](../watch-tower/README.md) to post the resulting orders, so **don't run
both**.

## Build and run

It needs a funded hot key, read from a file or `$KEEPER_PRIVATE_KEY` — never from argv, since an
argument is visible in `ps`.

```bash
pnpm --filter @cowprotocol/cow-drop-keeper build
pnpm --filter @cowprotocol/cow-drop-keeper test

echo 0x<hot-key> > ./keeper.key && chmod 600 ./keeper.key
node packages/keeper/dist/cli.js \
  --rpc-url $RPC_URL --private-key-file ./keeper.key \
  --state ./keeper.json --cursor ./gnosis.json --port 8787
```

`--dry-run` decides and simulates everything without broadcasting; run it first. The default policy
subsidises every owner up to a small daily budget — **pass `--policy` before pointing anything public
at it.**

```bash
curl localhost:8787/v1/health    # payer, balance, budget left
curl localhost:8787/v1/policy    # whether it is subsidising, before anyone commits
```

## CLI

```
--rpc-url <url>            RPC endpoint. Defaults to $RPC_URL.
--chain-id <id>            Defaults to $CHAIN_ID, else whatever the RPC says.
--generation <n>           Contract generation. Defaults to the SDK's latest.
--private-key-file <path>  File holding the hot key. Defaults to $KEEPER_PRIVATE_KEY.
--policy <path>            JSON subsidy policy. Defaults to subsidise-all with small budgets.
--state <path>             Registry and spend ledger. Default: memory only, lost on restart.
--cursor <path>            The watch tower's block cursor.
--port <n>                 HTTP port. Default 8787.
--allow-origin <origins>   CORS origins, comma separated. Default *.
--poll <seconds>           Seconds between passes. Default 12.
--env <prod|staging>       Which order book to post to. Default prod.
--dry-run                  Decide and simulate everything, broadcast nothing.
--quiet                    Errors only.
```

## Docs

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The HTTP API, the subsidy policies, how readiness is decided, crash safety and known limits |
| [docs/DESIGN.md](../../docs/DESIGN.md) | What a drop is and why activation is permissionless |
