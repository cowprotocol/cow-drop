# @cowprotocol/cow-drop-keeper

Watch registered drops, activate them when they are ready, and pay the gas.

A drop is funded before it exists and activation is permissionless — but somebody still has to
*notice* the funds arrived and send the transaction. Otherwise that is a person with the page open,
clicking **Activate**. This does it unattended, for drops whose owner explicitly asked it to. It runs
an in-process [watch tower](../watch-tower/README.md) to post the resulting orders, so **don't run
both**.

## Build and run

It needs a funded hot key, from `$KEEPER_PRIVATE_KEY` or `--private-key-file` — never from argv,
since an argument is visible in `ps`.

```bash
pnpm --filter @cowprotocol/cow-drop-keeper build
pnpm --filter @cowprotocol/cow-drop-keeper test

KEEPER_PRIVATE_KEY=0x<hot-key> pnpm --filter @cowprotocol/cow-drop-keeper start --rpc-url $RPC_URL
```

`--dry-run` decides and simulates everything without broadcasting; run it first. The default policy
subsidises every owner up to a small daily budget — **pass `--policy` before pointing anything public
at it.**

At boot it prints its whole configuration, the payer and its balance, a summary of the state it
loaded, and the URL of every route it serves — so a running keeper is auditable from its logs alone.

Browsable API docs are at **<http://localhost:8787/v1/docs>** — Swagger UI over the keeper's own
OpenAPI document.

```bash
curl localhost:8787/v1/health         # payer, balance, budget left
curl localhost:8787/v1/policy         # whether it is subsidising, before anyone commits
open  localhost:8787/v1/docs          # Swagger UI
curl  localhost:8787/v1/openapi.json  # the spec behind it
```

The spec is paths and summaries only. Request and response shapes live in [src/types.ts](src/types.ts),
because hand-copying them into a spec produces one that lies as soon as a type changes.

`/v1/docs` loads Swagger UI from a pinned CDN build rather than bundling `swagger-ui-dist`, so it is
the one route that needs the internet — `/v1/openapi.json` is served locally and works offline.

## CLI

```
--rpc-url <url>            RPC endpoint. Defaults to $RPC_URL.
--chain-id <id>            Defaults to $CHAIN_ID, else whatever the RPC says.
--generation <n>           Contract generation. Defaults to the SDK's latest.
--private-key-file <path>  File holding the hot key. Defaults to $KEEPER_PRIVATE_KEY.
--policy <path>            JSON subsidy policy. Defaults to subsidise-all with small budgets.
--state <path>             Registry and spend ledger. Default out/keeper/state-<chainId>.json.
--cursor <path>            Watch tower block cursor. Default out/keeper/cursor-<chainId>.json.
--port <n>                 HTTP port. Default 8787.
--allow-origin <origins>   CORS origins, comma separated. Default *.
--poll <seconds>           Seconds between passes. Default 12.
--min-balance <native>     Warn at boot below this balance. Defaults to $KEEPER_MIN_BALANCE, else 0.1.
--env <prod|staging>       Which order book to post to. Default prod.
--dry-run                  Decide and simulate everything, broadcast nothing.
--quiet                    Errors only.
```

`--min-balance` is advisory: it warns while the keeper can still pay. The hard floor is the policy's
`minPayerBalanceWei` (default 0.02 native), below which every activation is refused outright — the
boot banner reports that case as an error rather than a warning.

## Docs

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The HTTP API, the subsidy policies, how readiness is decided, crash safety and known limits |
| [docs/DESIGN.md](../../docs/DESIGN.md) | What a drop is and why activation is permissionless |
