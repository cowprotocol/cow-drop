# @cowprotocol/cow-drop-sdk

Turn a recipe into a drop address, and build the transaction that runs it.

Everything here is pure except the parts that obviously aren't — no RPC calls, no wallet, no
network. You give it a recipe, it gives you an address and calldata.

That purity is deliberate, and it is why this package does **not** depend on
[`@cowprotocol/cow-sdk`](https://www.npmjs.com/package/@cowprotocol/cow-sdk). Address derivation and
recipe compilation must be deterministic and offline — an address is a commitment, and anything that
could vary with a network response has no business near it. Its only dependency is `viem`.

Quoting, order submission and chain metadata are the official SDK's job, and `apps/web` uses both:
this one to work out *what* the address is, cow-sdk to talk to CoW. If you are building on top, do the
same.

```bash
pnpm --filter @cowprotocol/cow-drop-sdk generate   # ABIs + addresses from the foundry build
pnpm --filter @cowprotocol/cow-drop-sdk build
```

## The 30-second version

```ts
import { compileRecipe, buildActivateTx, twapOnArrival } from '@cowprotocol/cow-drop-sdk'

// 1. Describe what should happen to the money.
const recipe = twapOnArrival({
  chainId: 100,
  owner: '0xYourAddress',            // can always recover the funds
  sellToken: WXDAI,
  buyToken: COW,
  parts: 12,
  partDuration: 3600,                // one part per hour
  limitPrice: { price: '45', sellDecimals: 18, buyDecimals: 18 },
  minAmount: 1000n * 10n ** 18n,     // refuse to start on a part-delivered balance
})

// 2. Get the address. Nothing is deployed yet; this is pure computation.
const { address, setupData } = compileRecipe(recipe)

// 3. Send funds to `address` — bridge, exchange withdrawal, plain transfer.

// 4. Anyone can then run it. No signature, no privileged sender.
const tx = buildActivateTx({ deployment: compileRecipe(recipe).deployment, owner: recipe.owner, setupData })
await walletClient.sendTransaction(tx)
```

## Main functions

### Recipes

| | |
|---|---|
| `compileRecipe(json, deployment?)` | The one you'll use. Recipe file → `{ address, setupData, recipe, deployment }`. Validates as it goes and throws on anything ambiguous. |
| `swapOnArrival(params)` | Template: sell whatever lands here, once, at a limit price. Reusable — later arrivals get sold too. |
| `twapOnArrival(params)` | Template: split whatever lands here into parts and sell over time. One-shot. |

A *template* is a function; a *recipe* is what it returns and what the address commits to. The
distinction is useful in code and not worth making a user learn, so the UI says "recipe" throughout.
Both templates default `receiver` to the `owner` — proceeds in your wallet rather than piling up in
the drop. Pass the zero address to leave them in the drop instead.
| `steps.*` | Build individual steps by hand: `presignSellAll`, `twapFromBalance`, `requireMinBalance`, `requireTimeWindow`, `wrapNative`, `approveMax`, and `raw` for anything else. |

### Addresses and encoding

| | |
|---|---|
| `deriveDropAddress({ deployment, owner, setupData })` | The CREATE2 derivation, off-chain. This is why the UI can quote an address as you type. |
| `encodeRecipe(recipe)` / `decodeRecipe(setupData)` | The abi encoding the address actually commits to. |
| `getDeployment(chainId)` | The four addresses that define what a drop address is on that chain. Throws for unsupported chains. |

### Transactions and orders

| | |
|---|---|
| `buildActivateTx({ deployment, owner, setupData })` | `{ to, data, value }` for deploying the drop and running its recipe. Idempotent — safe to send twice. |
| `parseDropOrderPlaced(log)` | Decode a `DropOrderPlaced` event into the order that got pre-signed. |
| `toOrderBookPayload(order, drop)` | That order as a `POST /api/v1/orders` body, with `signingScheme: 'presign'`. |

### Rescue

For when a drop's recipe can never succeed — funds arrived late, or a condition stopped holding.

| | |
|---|---|
| `buildRescueForState(…)` | The one to use. Picks the right path from whether the drop is deployed, and returns `{ tx, path }`. |
| `buildRescueTx(…)` | Drop not deployed: `initializeProxyWithoutSetup` — deploy at the same address, skip the recipe, sweep atomically. |
| `buildOwnerSweepTx(…)` | Drop deployed: `trustedExecuteHooks`, since the owner is the shed's admin. |
| `buildDeployOnlyTx(…)` | Deploy the shed, skip the recipe, do nothing else — then operate it as a normal cow-shed. |
| `buildSweepCalls(…)` | The `Call[]` those take: one `sweep` per token, zero address for native. |

All owner-only, none needing a signature. Prefer designing the recipe so rescue is unnecessary — a
`requireTimeWindow` with a `notAfter`, or a deadline branch that lets the setup succeed trivially.

### Prices

| | |
|---|---|
| `limitPriceToFraction(price, sellDecimals, buyDecimals)` | `'0.95'` → an exact integer fraction. |

Prices are never floats. The result is committed into an address, so a rounding difference between
your code and the SDK would produce a *different address*, not a slightly different price.

## Two things that will bite you otherwise

**The recipe file is not the commitment.** The compiled `setupData` bytes are. The file is a
reproducible way to get back to those bytes, which is why compilation reads fields by name in a
fixed order and ignores key order and formatting. Change any value — the label, the `once` flag, one
digit of the price — and you get a different address.

**`salt` and `orderSalt` are different things.** The recipe's `salt` is the factory's user salt: it
moves the drop address, and exists so the same parameters can yield more than one drop (or so you can
grind a vanity address without putting junk in `label`). The `twapFromBalance` step's `orderSalt` is
the ComposableCoW conditional-order discriminator, and does not affect the address at all.

**Guards are steps, not settings.** `requireMinBalance` and `requireTimeWindow` are ordinary steps
committed into the address, so nobody activating your drop can skip them. Put a `minAmount` on any
one-shot recipe that a bridge might fund in tranches; without it, the first tranche to land sizes the
whole schedule. Ordering affects what a guard measures, not whether it binds — the recipe is atomic,
so a guard anywhere in the list unwinds the whole activation.

## Constants are generated, not written

`src/generated/` comes from the foundry build via `scripts/generate-constants.mjs`. The shed
implementation address and the proxy creation code both feed the CREATE2 init code, so a stale
hand-copied value would mean quoting addresses the contracts will never deploy to. Run `pnpm generate`
after any contract change.

## Tests

```bash
pnpm test
```

`derivation.test.ts` is the important one: it checks this package's off-chain address derivation
against fixtures generated by the actual compiled contract
(`contracts/script/Fixtures.s.sol`). Two implementations of one formula drift silently, and the
failure mode is an address that funds get stranded at.
