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

# Every chain in one process. Each reads $RPC_URL_<chainId>, else a public endpoint (with a warning).
KEEPER_PRIVATE_KEY=0x<hot-key> pnpm --filter @cowprotocol/cow-drop-keeper start --chains 100,1,8453

# Or one chain, as before.
KEEPER_PRIVATE_KEY=0x<hot-key> pnpm --filter @cowprotocol/cow-drop-keeper start --rpc-url $RPC_URL
```

Each chain is served under its CoW network name — the same name as in `api.cow.fi/<network>`:

```
http://localhost:8787/xdai/v1/drops      Gnosis
http://localhost:8787/mainnet/v1/drops   Ethereum
http://localhost:8787/base/v1/drops      Base
GET /v1/networks                         what this process serves, and where
```

A single chain is also served unprefixed (`/v1/drops`), so anything pointed at a one-chain keeper keeps
working. The web app finds every chain from one base URL — see `VITE_KEEPER_BASE_URL` in
[`apps/web/README.md`](../../apps/web/README.md).

`--dry-run` decides and simulates everything without broadcasting; run it first. The default policy
subsidises every owner up to a small daily budget — **pass `--policy` before pointing anything public
at it.**

At boot it prints its whole configuration, the payer and its balance, a summary of the state it
loaded, and the URL of every route it serves — so a running keeper is auditable from its logs alone.

Browsable API docs are at **<http://localhost:8787/xdai/v1/docs>** (any network) — Swagger UI over the keeper's own
OpenAPI document.

```bash
curl 'localhost:8787/v1/drops?owner=0x…'  # every drop registered under one owner
curl localhost:8787/v1/health         # payer, balance, budget left
curl localhost:8787/v1/policy         # whether it is subsidising, before anyone commits
curl localhost:8787/v1/about          # the contracts behind the generation it serves
open  localhost:8787/v1/docs          # Swagger UI
curl  localhost:8787/v1/openapi.json  # the spec behind it
```

The spec is paths and summaries only. Request and response shapes live in [src/types.ts](src/types.ts),
because hand-copying them into a spec produces one that lies as soon as a type changes.

`/v1/docs` loads Swagger UI from a pinned CDN build rather than bundling `swagger-ui-dist`, so it is
the one route that needs the internet — `/v1/openapi.json` is served locally and works offline.

## CLI

```
--chains <ids>             Chain ids to keep, comma separated. Defaults to $CHAINS. Each chain's RPC
                           is $RPC_URL_<chainId>, else a public endpoint (with a warning).
--rpc-url <url>            One chain only: its RPC. Defaults to $RPC_URL.
--chain-id <id>            One chain only. Defaults to $CHAIN_ID, else whatever the RPC says.
--generation <n>           Contract generation. Defaults to the SDK's latest.
--private-key-file <path>  File holding the hot key. Defaults to $KEEPER_PRIVATE_KEY.
--policy <path>            JSON subsidy policy: one for every chain, or one per chain keyed by chain
                           id. Defaults to subsidise-all with small budgets.
--state-dir <dir>          Each chain's state-<id>.json and cursor-<id>.json. Default out/keeper.
--state <path>             One chain only: the registry and spend ledger file.
--cursor <path>            One chain only: the watch tower block cursor file.
--port <n>                 HTTP port. Default 8787.
--allow-origin <origins>   CORS origins, comma separated. Default *.
--poll <seconds>           Seconds between passes. Default 12.
--min-balance <native>     Warn at boot below this balance. Defaults to $KEEPER_MIN_BALANCE, else 0.1.
--env <prod|staging>       Which order book to post to. Default prod.
--dry-run                  Decide and simulate everything, broadcast nothing.
--quiet                    Errors only.
```

`--min-balance` is advisory: it warns while the keeper can still pay. The hard floor is the policy's
`minPayerBalanceWei`, below which every activation is refused outright — the boot banner reports that
case as an error rather than a warning.

**The floor and the per-activation cap default to twenty activations, sized from the chain's own gas
price at boot**, not to a fixed amount of native token. They have to be: 0.02 native is about five
activations of reserve on Ethereum and six thousand on Base, and a flat 0.01 native per-activation cap
is three thousand times the real cost on Base while refusing every Ethereum activation above roughly
24 gwei. The boot banner prints the derived numbers in both units, so a `payer-balance-low` refusal can
be read against them:

```
one activation costs about 0.0000032 native here, so the floor is 0.0000646 (20 activations)
and one activation may cost up to 0.0000646
```

**With several chains, key the policy file by chain id**, since every amount in it is in that chain's
native token — 0.25 is a quarter of an ETH on mainnet and a quarter of a dollar on Gnosis:

```json
{
  "100":  { "mode": "all", "dailyBudgetWei": "250000000000000000" },
  "1":    { "mode": "all", "dailyBudgetWei": "10000000000000000" },
  "8453": { "mode": "all", "dailyBudgetWei": "200000000000000" }
}
```

A keyed file with no entry for one of the chains is refused at boot rather than falling back to the
defaults for it. A plain, unkeyed policy applies to every chain.

Budgets are deliberately *not* scaled. `dailyBudgetWei` is risk appetite — a sum of money you are
willing to lose in a day — and scaling it by gas price would raise the ceiling on the chain where
mistakes cost most. Set it yourself if the default does not match your appetite.

## Docs

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The HTTP API, the subsidy policies, how readiness is decided, crash safety and known limits |
| [docs/DESIGN.md](../../docs/DESIGN.md) | What a drop is and why activation is permissionless |
