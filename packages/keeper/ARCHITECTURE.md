# Keeper architecture

How the keeper decides what to activate, what it will pay for, and what it does when things go wrong.
Running it is covered in the [README](README.md).

Two loops run side by side. **The keeper activates; the watch tower posts.** The keeper decides what
to spend money on; an in-process [`watch-tower`](../watch-tower/README.md) turns the resulting
`OrderPlacement` logs into posted orders, with the retry and cursor semantics it already has. One
implementation of order posting, not two — at the cost of `order-posted` arriving a poll or two after
the receipt rather than instantly.

## Readiness is decided by simulation, not by reading the recipe

The tempting design is to decode the guards and evaluate them. It does not work: `requireCallResult`
leaves its inner calldata undecoded by design, a `raw` step is opaque entirely, `token: 0x0` means
native rather than an ERC20, and the guarded token need not be the sell token.

So the recipe is a **hint** — it says which balances are worth polling — and the gate is an `eth_call`
of `buildActivateTx` itself. That evaluates every guard correctly, including ones no decoder can read,
plus `NothingToSell`, `AlreadyConsumed` and `NoCodeAtDelegateTarget`, without this package
understanding any of them.

The balance poll exists only to keep that call cheap: a drop whose balances have not moved since the
last simulation is not simulated again until `resimulateIntervalMs`. Without that, a funded-but-not-
ready drop costs an `eth_call` every tick forever. A recipe of nothing but `raw` steps has nothing to
poll, so it is simulated on a timer instead — correctness is unaffected, only latency.

## Activating twice is the thing to be careful about, not activating once

A `once` recipe retires on its first confirmation and needs nothing more. Everything else is reusable —
running again on the next arrival is the point of a deposit address — so the question is what stops it
running again *too soon*.

The money does not leave at activation. The pre-signature is on chain, the order is valid, and the
balance `presignSellAll` sized it against is still sitting in the drop until a solver settles. Simulating
on that balance passes, so without a gate the very next tick signs a second order for the same money —
one the first order's fill makes unfillable, bought with the keeper's gas.

So a confirmed activation records `committedDigest`: the balances it committed. `shouldSimulate` refuses
while the polled digest still matches, and the commitment ends on whichever comes first:

- **the balance moves** — a fill, a sweep, or a fresh arrival. Any of the three means the sizing is
  stale, and a fill is what frees the money. This is a latch cleared on movement rather than a
  comparison against the committed value, so a refund of exactly the last order's size still counts as
  new money.
- **the order can no longer fill** — `validTo`, read from the last four bytes of the uid the watch tower
  posted onto the activation record. This is the half that matters when an order expires unfilled: the
  balance never moved, so nothing else would ever release it. Before a uid exists the recipe's own
  validity window stands in, measured from the receipt, which errs late.

A recipe that registers a conditional order instead gets none of this — see `selfDriving` under
Registration, and `activated`.

## Registration

```
POST /v1/drops            { recipe, address } -> 201 { drop }, or 200 if already registered
GET  /v1/drops/:address   -> the drop, its hints, and its activation history
POST /v1/drops/unregister { recipe } -> 200, 409 while an activation is in flight
GET  /v1/events?drop=0x…  -> SSE
GET  /v1/health           -> payer, balance, budget left, counts
GET  /v1/policy           -> whether it is subsidising, before anyone commits
GET  /v1/about            -> chain, generation, and the contract addresses those stand for
GET  /v1/openapi.json     -> this surface as an OpenAPI 3.1 document
GET  /v1/docs             -> Swagger UI over that document
```

The list above is generated at runtime from `ROUTES` in `src/server.ts`, which also feeds the boot
banner. `src/server.test.ts` walks it and asserts every entry answers something other than 404, so the
table cannot drift into advertising a route the router does not serve.

`/v1/about` publishes the same skew check one level up: the chain, the generation, and the contract
addresses those numbers stand for, plus a hash of the proxy creation code. A client can compare its
own SDK deployment key by key before it ever compiles a recipe, rather than discovering the mismatch
as a 409 — or, if it never sends its derived address, not at all.

The client sends the address it derived and the server compares it to its own. **A mismatch is a 409
naming both.** That is the point of the endpoint: it catches SDK-version skew, whose failure is
otherwise silent — the keeper would diligently watch an address nobody funded while the user watches
the one they did. The client's address is an assertion to be checked, never an input.

`POST` is idempotent, because a client whose request timed out will retry and can only honestly be
told that retrying is safe if it is. Registering a recipe that was previously unregistered *resumes*
that record rather than returning it as held-but-idle, so the pair is a pause the recipe holder can
undo rather than a one-way door. Only `retiredReason: 'unregistered'` revives: every other reason is a
fact about the drop — `once-consumed` cannot fire twice, `expired` is past its committed window,
`terminal-revert` would revert again — and watching those is polling for something that cannot happen.
For the same reason, unregistering a drop that is *already* retired changes nothing rather than
rewriting its reason: only `unregistered` revives, so rewriting would make the pair a resurrection
ritual.

**A resume restores the state the stop interrupted, which is not always `watching`.** Whether a drop
that has already activated comes back armed depends on what its activation left behind, and the rule is
`selfDriving` — the same one `reconcile` applies. The status is derived from the activation history
rather than remembered in a field that would go stale.

A recipe that registers with ComposableCoW is parked in `activated`, which the tick loop never
considers. For a TWAP, re-arming is expensive: the drop holds its sell balance for the whole schedule,
and `twapFromBalance` reads that balance at activation and passes `t0 = 0`, so `createWithContext` seeds
the start time from the current block. A second activation registers a second TWAP over the remaining
balance, or re-seeds the cabinet and restarts the schedule over parts that already traded. And because
the balance *falls as the parts fill*, no balance-watching gate can hold it — parking is the only
answer available off-chain, since nothing here can tell a finished schedule from a running one.

A recipe that signs discrete orders comes back `watching`, gated by `committedDigest` instead. Parking
those was a bug: a reusable deposit address that fires exactly once is not reusable.

**Registration is open; unregistration is not symmetric.** Registering someone's drop grants nothing —
activation is permissionless already, the guards are committed into the address, and only the owner
can sweep. Unregistering someone else's costs them their subsidy for free, so it goes through
`POST /v1/drops/unregister` with the recipe in the body, which proves the caller holds the one thing
that matters. No subscription token is issued for this and none is needed: a token would be another
thing to store, lose on a restart and leak, and it would grant exactly what holding the recipe already
proves.

**Unregistering is refused while an activation is in flight** — a 409 naming the transaction. Retired
drops are excluded from `store.active()`, and only active drops get their `pending` activation
reconciled, so retiring mid-flight would abandon a transaction the keeper has already paid for: the
reserved spend would never be trued up against the receipt and the activation would never reach the
drop's history. The money is already committed, so the honest answer is to refuse; a second later the
tick has reconciled and the same request succeeds.

What registration does cost is capacity: a recipe stored indefinitely and a line in every tick's poll
set. Hence `--max-drops` and a body cap.

## Money

```json
{
  "mode": "paying",
  "feeRecipient": "0xKeeper…",
  "minFeeBps": 5,
  "minRevenueRatio": 1.5,
  "dailyBudgetWei": "250000000000000000"
}
```

Three modes. `all` subsidises everyone, `allowlist` a fixed set of owners, and **`paying` anyone whose
recipe pays the keeper more than the activation costs** — the only one whose limit is economic rather
than administrative, and so the only one that safely scales to strangers.

### `paying`

A drop qualifies when its order carries a CoW `partnerFee` naming the keeper:

```json
{ "version": "1.4.0", "metadata": { "partnerFee": { "volumeBps": 10, "recipient": "0xKeeper…" } } }
```

That costs no gas and needs no contract of ours — it is the protocol's own mechanism, taken at
settlement. The keeper values it with the order book's native price and refuses unless it clears the
gas by `minRevenueRatio`.

The document has to be supplied at registration, because **the chain carries only its hash**. So the
keeper verifies rather than trusts: it hashes the exact bytes it was handed and compares to what the
recipe committed to. A fee in a document nobody signed is not a promise. It hashes the string
verbatim and never re-serialises — JSON has many spellings of one object and only the one that was
hashed is the pre-image.

Two deliberate narrowings:

- **Only `volumeBps` counts.** A `surplusBps` fee is real income whose *guaranteed* value is zero — a
  fill with no surplus pays nothing — and subsidising against income that may never arrive is the
  thing this mode exists to stop.
- **`minRevenueRatio` sits above 1.** The volume is the balance a poll saw, the order is sized at
  activation, and the price moves in between. A fee that only just covers the gas covers nothing
  after any of that.

An unpriceable sell token is a refusal, not a zero: a token the order book will not price is one we
cannot say is worth subsidising, not one we know is worthless.

The documents are kept for a second job too — the order book rejects an appData hash it has never
seen, so the watch tower needs them to post the order at all.

**Confirm the price convention before turning this on with real money.** `feeValueWei` assumes CoW's
native price converts atomic token units to wei, which the SDK's `{ price?: number }` type does not
state. Run `--dry-run` first: it logs the estimated revenue beside the gas for every drop, so a wrong
convention shows up as several orders of magnitude rather than as a subtle loss.

### `all` and `allowlist`

```json
{
  "mode": "all",
  "denylist": [],
  "maxCostPerActivationWei": "10000000000000000",
  "maxFeePerGasWei": "500000000000",
  "dailyBudgetWei": "250000000000000000",
  "perOwnerDailyBudgetWei": "50000000000000000",
  "minPayerBalanceWei": "20000000000000000"
}
```

Two things about this are worth reading twice.

**The per-activation cap is in wei, not gas units.** A units cap does not bound the spend: the same
300k gas costs thirty times more in a fee spike, and a cap that moves with the gas price is not a cap.
`maxFeePerGasWei` is the separate breaker that pauses the keeper in a spike rather than draining it one
capped transaction at a time.

**`perOwnerDailyBudgetWei` barely binds in `mode: "all"`.** `owner` is a field of a recipe anyone may
submit, and minting a fresh one per registration is free. So in `all` mode the only cap that really
holds is `dailyBudgetWei` — set it to a number you would not mind losing daily. Simulation kills the
cheap abuse (a drop that would revert costs nothing) but a valid, useless, repeatedly-registered drop
can still drain a day's allowance. The per-owner cap earns its place in `allowlist` mode, where the
owner set is fixed by configuration rather than by the caller.

`paying` is the answer to that: an attacker draining the budget has to pay you more than they cost.
The budgets stay in place underneath it as a backstop.

The hot key is read from `--private-key-file` or `$KEEPER_PRIVATE_KEY`, never from argv — `--private-key`
is rejected rather than ignored, because an argument is visible in `ps` to everything on the machine.
It sits behind a `Submitter` interface, so a relayer or Safe replaces it without touching the loop.

## Crash safety

`Submitter` is two-phase — `prepare` then `broadcast` — and that is the whole reason it is not a single
`sendTransaction`. Signing locally yields the transaction hash *before* any bytes leave the process, so
the record moves to `activating` with the hash recorded, and the budget is debited, before the
broadcast. A crash inside that window leaves a hash to look up rather than a question about whether
anything was sent.

The budget is debited at the reservation and settled from the receipt. Over-counting a transaction that
never goes out is the safe direction — reconciliation refunds it — whereas under-counting means a crash
loop can spend past the daily cap.

On restart the watch tower's cursor is rewound to the oldest in-flight activation's block. Without
that, a restart between broadcast and scan skips the block the activation landed in, and its orders are
never posted.

## Reverts

An unrecognised selector is **always** `waiting`, never `terminal`. The decoder is the lossy part of
this system — a `raw` step's target has its own errors, and a future step contract will have errors
this build has never heard of — so if an unfamiliar revert could retire a drop, one unknown error would
stop the keeper watching an address that is alive and about to be funded. Being wrong the other way
costs a poll every few minutes. That is the right asymmetry.

Only `AlreadyConsumed`, `NotADrop`, `MalformedRecipe` and `TooLate` retire a drop.
`NoCodeAtDelegateTarget` parks it, because the step contract may be deployed later.

## Retired, not deleted

A retired record keeps its recipe. This store holds the only server-side copy of `setupData`, and
losing those bytes before activation loses the money for everyone including the owner — see
`apps/web/src/lib/storage.ts`. `GET /v1/drops/:address` keeps serving it, which makes the keeper an
incidental recovery path. It is not a backup service and should not be sold as one; download the
`.drop.json` regardless.

## Tests

All hermetic — no network, no node, no clock. `KeeperChain` is six methods and `Submitter` is four, so
a test drives a revert, a fee spike, a reorged transaction or a crash between signing and broadcasting
by handing over a fake. `now()` is injected because the day a budget rolls over on is the thing most
worth pinning.

## Known limits

- **One chain per process.** The hot key, the nonce, the deployment and the cursor are all per chain.
  Several chains means several processes behind one ingress, which is why a recipe for another chain is
  a 422 rather than something stored and never looked at.
- **One process per key.** Two keepers sharing a key would read the same nonce and stall each other.
- **The keeper cannot hold the moment exclusively.** A user may hit Activate while it is mid-flight;
  the simulation immediately before the send is the narrowest window obtainable off-chain, and the
  residual cost is one reverted transaction's gas. Permissionless means permissionless.
- **A stuck transaction is not fee-bumped.** Past `receiptTimeoutMs` the reservation is refunded and
  the drop goes back to watching, rather than replacing at the same nonce. That is the honest limit of
  a first version.
