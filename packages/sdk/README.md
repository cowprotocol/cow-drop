# @cowprotocol/cow-drop-sdk

Turn a recipe into a drop address, and build the transaction that runs it.

Everything here is pure except the parts that obviously aren't — no RPC calls, no wallet, no
network. You give it a recipe, it gives you an address and calldata. Its only dependency is `viem`;
anything that talks to CoW is [`@cowprotocol/cow-sdk`](https://www.npmjs.com/package/@cowprotocol/cow-sdk)'s
job, and `apps/web` uses both.

> **Unaudited, and it depends on an unmerged cow-shed PR stack. Do not put real money in it yet.**

## Install

```bash
pnpm add @cowprotocol/cow-drop-sdk viem
```

`viem` is a direct dependency, not a peer — the addresses this derives have to come from one copy of
its ABI encoders, not whichever version a consumer happens to hoist.

## Build

```bash
pnpm --filter @cowprotocol/cow-drop-sdk generate   # ABIs + addresses from the foundry build
pnpm --filter @cowprotocol/cow-drop-sdk build
pnpm --filter @cowprotocol/cow-drop-sdk test
```

`generate` is only needed after a contract change — `src/generated/` is committed.

## Use

```ts
import { compileRecipe, buildActivateTx, twapOnArrival } from '@cowprotocol/cow-drop-sdk'

const recipe = twapOnArrival({ chainId: 100, owner, sellToken, buyToken, parts: 12, partDuration: 3600,
  limitPrice: { price: '45', sellDecimals: 18, buyDecimals: 18 } })

const { address, setupData, deployment } = compileRecipe(recipe)  // send funds to `address`
const tx = buildActivateTx({ deployment, owner, setupData })      // anyone can send this
```

## Examples

Every template returns a recipe; `compileRecipe` turns it into the address to fund, and
`buildActivateTx` into the transaction anyone can send once funds arrive. The examples use Gnosis
tokens:

```ts
const WXDAI = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d'
const COW = '0x177127622c4A00F3d409B75571e12cB3c8973d3c'
const USDCE = '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0'
```

<details>
<summary><b>Swap on arrival</b> — sell whatever lands, at a limit price</summary>

```ts
const recipe = swapOnArrival({
  chainId: 100,
  owner,
  sellToken: USDCE,
  buyToken: COW,
  limitPrice: { price: '2.5', sellDecimals: 6, buyDecimals: 18 }, // at least 2.5 COW per USDC.e
})
const { address, setupData, deployment } = compileRecipe(recipe) // fund `address`
const tx = buildActivateTx({ deployment, owner, setupData }) // then anyone can send this
```

</details>

<details>
<summary><b>Swap at the oracle price</b> — a limit that tracks the market, with a floor</summary>

```ts
const recipe = swapOnArrival({
  chainId: 100,
  owner,
  sellToken: WXDAI,
  buyToken: COW,
  limitPrice: { price: '40', sellDecimals: 18, buyDecimals: 18 }, // the floor
  oracle: { sellTokenPriceOracle: sellFeed, buyTokenPriceOracle: buyFeed, haircutBps: 50 },
})
```

The feed may only improve on the floor, so whoever activates can't pick a bad moment for you.

</details>

<details>
<summary><b>TWAP</b> — split what arrives into parts sold over time</summary>

```ts
const recipe = twapOnArrival({
  chainId: 100,
  owner,
  sellToken: WXDAI,
  buyToken: COW,
  parts: 12,
  partDuration: 3600, // one part an hour
  limitPrice: { price: '45', sellDecimals: 18, buyDecimals: 18 },
  minAmount: 1000n * 10n ** 18n, // don't start before 1,000 WXDAI has arrived
})
```

</details>

<details>
<summary><b>Stop-loss</b> — sell only if the price falls to a strike</summary>

```ts
const recipe = stopLossOnArrival({
  chainId: 100,
  owner,
  sellToken: WXDAI,
  buyToken: COW,
  sellTokenPriceOracle: sellFeed,
  buyTokenPriceOracle: buyFeed, // same quote currency as sellFeed
  strike: 45n * 10n ** 18n, // sell once WXDAI is worth 45 COW or less
  limitPrice: { price: '40', sellDecimals: 18, buyDecimals: 18 }, // and not for less than 40
  validitySeconds: 7 * 24 * 3600,
})
```

</details>

<details>
<summary><b>Payment request</b> — get paid a fixed amount, in any token</summary>

```ts
const recipe = paymentRequest({ chainId: 100, owner, buyToken: USDCE, buyAmount: 100_000_000n }) // 100 USDC.e
const { address, setupData, deployment } = compileRecipe(recipe)

// Tell the payer what to send: a CoW *buy* quote for the price, plus 0.5%.
const send = requiredPayment(quote) // quote = { sellAmount, feeAmount } from the order book

// Once it has arrived, activate with that token.
const tx = buildActivatePaymentTx({ deployment, owner, setupData, sellToken: WXDAI })
```

Surplus over the price goes to the receiver, since the drop places a sell order.

</details>

<details>
<summary><b>Guards</b> — a time window and a minimum balance</summary>

```ts
const recipe = swapOnArrival({
  chainId: 100,
  owner,
  sellToken: WXDAI,
  buyToken: COW,
  limitPrice: { price: '40', sellDecimals: 18, buyDecimals: 18 },
  notBefore: 1_798_761_600n, // 1 Jan 2027
  notAfter: 1_830_297_600n, // 1 Jan 2028
  minAmount: 500n * 10n ** 18n,
})
```

Every template takes these. A guard reverts, so an early activation doesn't spend a one-shot recipe.

</details>

<details>
<summary><b>Native token in</b> — wrap first, then trade</summary>

```ts
const recipe = swapOnArrival({
  chainId: 100,
  owner,
  sellToken: WXDAI,
  buyToken: COW,
  wrapNative: WXDAI, // send xDAI; it's wrapped before selling
  limitPrice: { price: '40', sellDecimals: 18, buyDecimals: 18 },
})
```

</details>

<details>
<summary><b>Read a recipe back</b> — check what an address will do before funding it</summary>

```ts
const described = describeRecipe(setupData, deployment)
if (hasWarnings(described)) console.warn(described.steps.flatMap((step) => step.warnings))
```

</details>

<details>
<summary><b>Rescue</b> — get funds back out, deployed or not</summary>

```ts
const tx = buildRescueForState({ deployment, owner, setupData, drop: address, to: owner, tokens: [WXDAI], deployed })
```

Owner only. Picks the right path for whether the drop has been deployed yet; see [API.md](API.md#rescue).

</details>

## Docs

| | |
|---|---|
| [API.md](API.md) | Every exported function, the rescue paths, generations, and the two things that will bite you |
| [docs/DESIGN.md](https://github.com/cowprotocol/cow-drop/blob/main/docs/DESIGN.md) | The commitment scheme and the recipe format |
