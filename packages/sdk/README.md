# @cowprotocol/cow-drop-sdk

Turn a recipe into a drop address, and build the transaction that runs it.

Everything here is pure except the parts that obviously aren't — no RPC calls, no wallet, no
network. You give it a recipe, it gives you an address and calldata. Its only dependency is `viem`;
anything that talks to CoW is [`@cowprotocol/cow-sdk`](https://www.npmjs.com/package/@cowprotocol/cow-sdk)'s
job, and `apps/web` uses both.

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

## Docs

| | |
|---|---|
| [API.md](API.md) | Every exported function, the rescue paths, generations, and the two things that will bite you |
| [docs/DESIGN.md](../../docs/DESIGN.md) | The commitment scheme and the recipe format |
