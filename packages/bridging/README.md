# @cowprotocol/cow-drop-bridging

Quote a bridge route that delivers into a drop and activates it on arrival.

Bridging into a drop needs nothing from this package: a drop address is fundable before it exists, so
naming `compileRecipe(...).address` as a bridge's recipient already works, and a keeper activates once
the money lands. What this adds is the **atomic** path — the bridge delivers to `DropBungeeReceiver`
with the recipe as its destination payload, so the tokens reach the drop and the CoW order goes live
in the same transaction as the bridge fill. No keeper latency, and the relayer filling the bridge pays
the activation gas as part of a job it is already being paid for.

## Build and test

```bash
pnpm --filter @cowprotocol/cow-drop-bridging build
pnpm --filter @cowprotocol/cow-drop-bridging test
```

Tests are hermetic: `fetch` is injected, so nothing here touches the network.

## Use

```ts
import { bungeeDelivery, compileRecipe, swapOnArrival } from '@cowprotocol/cow-drop-sdk'
import { BungeeDropProvider } from '@cowprotocol/cow-drop-bridging'

// The destination: a drop on Gnosis that sells whatever USDC arrives, for COW.
const compiled = compileRecipe(
  swapOnArrival({ chainId: 100, owner, sellToken: USDC_GNOSIS, buyToken: COW, limitPrice }),
)

const quote = await new BungeeDropProvider().getQuote({
  sender: owner,
  sellChainId: 8453,
  sellToken: USDC_BASE,
  sellAmount: 1_000_000_000n,
  buyChainId: 100,
  // The token the *bridge* delivers, which is the token the *drop* sells.
  buyToken: USDC_GNOSIS,
  destination: bungeeDelivery(compiled),
})

// quote.approval, then quote.transaction — two ordinary transactions on the source chain.
```

## Two legs, two "outputs"

The commonest way to get this wrong. A bridge-and-swap has two legs and each has an output:

| leg | from | to |
|---|---|---|
| bridge | USDC on Base | USDC on Gnosis — **`buyToken` here** |
| CoW order | USDC on Gnosis | COW — the recipe's business, not this package's |

So `buyToken` in a quote request is the *intermediate* token: what has to land in the drop for its
recipe to have something to sell. What the user finally receives is decided by the recipe.

## The destination seam

`DestinationTarget` — `{ receiver, payload, predictedAddress, gasLimit }` — is the only thing this
package knows about where the money is going, and it is built by the drop SDK rather than here.

That is deliberate, and it is the piece worth upstreaming.
[cow-sdk#845](https://github.com/cowprotocol/cow-sdk/pull/845) adds the same provider shape but asks
it for `getOrderFlowAddress(owner, chainId)` and `encodeDestinationOrderData(params)`, which hard-codes
the destination to `OrderFlow`. Naming the destination as data instead means one Bungee implementation
serves both — everything else (the quote call, `destinationPayload`, `destinationGasLimit`, route
selection) is already identical.

## Do not filter the bridges

`includeBridges` is opt-in and omitted by default, which lets Bungee offer everything it has. The
chain list is far more permissive than any single bridge, so a narrow set silently turns supported
pairs into "no route": restricting to `across, cctp, gnosis-native-bridge` leaves **Base to Gnosis
with no route at all**, while Symbiosis serves it and supports the destination payload. Verified
working end to end — quote through build-tx — for WETH on Base to WETH on Gnosis.

## What is not here

- **Bridge status.** The destination balance is the ground truth and the app already watches it;
  `explorerUrl()` covers the human case. A status API can be added when something needs to act on it
  rather than display it.
- **Anything that decides the recipe.** A quote never moves the drop address — the payload is the
  recipe, which commits to a rule rather than an amount — so quotes can be refreshed freely. Sizing a
  recipe's `minAmount` from a live quote would break that, and belongs to whoever builds the recipe.
