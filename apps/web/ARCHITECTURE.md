# Web app architecture

What the page does, panel by panel, and the decisions behind it. Running it is covered in the
[README](README.md).

## What the page does

Eight panels, top to bottom, in the order you'd actually use them:

1. **Recipe** — swap on arrival, TWAP on arrival, or stop-loss on arrival. The hint under the tabs
   explains what each needs afterwards: the swap's order has to be posted to the API, while the two
   ComposableCoW recipes are self-driving once activated.
2. **Parameters** — network, tokens, limit price, receiver, owner. The **network** selector lists the
   chains from `chains.ts` and defaults to whatever your wallet is on when that is one of them. Switching
   network does not move the drop address — the addresses are identical on every chain — it only changes
   which chain you fund. Both recipes work on every listed chain.

   Picking a network also asks the wallet to switch, adding the chain first if the wallet does not know
   it, and the page follows the wallet's own `chainChanged` events — so the two cannot drift apart. A
   declined prompt is not treated as an error; the mismatch banner says the wallet is elsewhere. Token
   selections reset on a chain change, because a token address from the previous chain would otherwise
   compile into a valid-looking recipe for a token that does not exist there. The **owner** matters: it's who can recover
   the funds if the recipe turns out to be unrunnable, and it defaults to your connected wallet. The
   **receiver** defaults to the owner, so proceeds land in your wallet rather than piling up in the
   drop; the zero address leaves them in the drop for chaining.

   **Price feeds** appear for the stop-loss, and for the swap when you tick "improve the limit with a
   price feed". For the swap the limit price becomes a *floor* the feed may only tighten — which is the
   point, because anyone may activate a drop, so without a floor whoever activates would be choosing
   your price by choosing the moment. The panel says out loud that both feeds must quote the same
   currency, since nothing on-chain can check it.

   **Guards** are optional on every recipe: a minimum balance, and a not-before / not-after window.
   The minimum is the one that matters — activation is permissionless, so on a one-shot recipe anyone
   may trigger it the moment the first wei lands and the order gets sized from a part-delivered
   balance, which is exactly what a bridge paying out in tranches does. The panel warns when a one-shot
   recipe has no minimum set. Guards are part of the address, so adding one moves it — and they are
   refusals, not triggers: nothing watches for the moment a guard turns true.
3. **Your drop address** — updates live as you type, with a QR code. Nothing is deployed at it yet,
   and funds sent before deployment are safe; the recipe spends them on activation.
4. **What the address commits to** — the decoded steps and the exact `setupData` bytes. This is the
   only place you can see what you're being asked to fund, and since activation is permissionless and
   unsigned, reading it *is* the safeguard — so the steps are named and their arguments decoded, via the
   SDK's `describeRecipe`. Arguments are shown as the exact committed values, with no unit conversion: a
   prettified amount that disagreed with the committed one by an atomic unit would be describing a
   different drop.

   A step the SDK cannot name is called out as an **unrecognised call** rather than rendered as if it
   were understood, with a warning saying why. Three more warnings appear where they apply: a
   delegatecall to something that is not a step contract (it can rewrite the shed's storage, including
   the admin the rescue path depends on), a step contract invoked as a plain *call* (it would read that
   contract's zero balance instead of the drop's), and `allowFailure` (the activation can complete
   having skipped the step).
5. **Status** — balance at the drop, whether it's deployed, and the activate button. Links to two
   explorers, because they answer different questions: CoW Explorer for the *orders* a drop has placed,
   the chain's own explorer for its *balances and transactions*. It warns when the contracts aren't
   deployed on the chain yet, in which case the address is a prediction (a correct one — addresses are
   deterministic).

   Also holds **Activate from the terminal**, for a keeper or a pre-flight check. Note what curl can
   and cannot do: activation is a signed transaction, so the send is a `cast` command, and curl gets
   the two jobs it genuinely does — simulating the activation via `eth_call` (no key, no funds, and it
   answers "would this work?" before anyone sends money to the address) and reading back the orders the
   drop owns.
6. **If something goes wrong** — the rescue panel, behind a toggle. It shows which path applies
   (deploy-without-setup if the drop doesn't exist yet, direct sweep if it does), lets you pick which
   balances to recover and where to send them, and offers "deploy shed only" for taking manual
   control instead. Owner-only, so it tells you when the connected account isn't the owner.
7. **Add a custom step** — an ABI-driven builder for calling something the recipe types do not cover.
   Paste human-readable signatures or a JSON ABI, pick a function, fill the arguments, and it appends a
   `raw` step to the recipe below. Two limits are stated in the panel rather than discovered: every
   argument is a **literal** committed into the address, so this cannot express anything that depends on
   the amount that arrives; and `delegatecall` is off by default and needs a second, explicit
   confirmation, because foreign code running as the drop can rewrite the shed's admin.
8. **Recipe file** — import and export. Export, reload the page, import, and the same address comes
   back, because the address is derived from the recipe rather than stored anywhere.

## Activation

The connected wallet only pays gas. It isn't authorising anything — the recipe was authorised by
being committed into the address — so any account could send the same transaction. That's why the
wallet handling here is deliberately thin: `viem` plus the injected provider, no connector framework.

For the pre-sign path, activation is followed by a `POST` to the CoW order book, since the
pre-signature exists on-chain but the order still has to be made visible to solvers. The page does
this for you and reports the order UIDs. For the TWAP path there's nothing to post: the watch tower
takes over.

## Files

| | |
|---|---|
| `src/App.tsx` | The form, and the recipe it builds. `toRecipe` is pure, which is what makes the address update as you type. |
| `src/lib/drop.ts` | Reading drop status, activating, and posting placed orders. |
| `src/lib/chain.ts` | Public client, injected wallet, chain switching. |
| `src/lib/tokenList.ts` | Loads the token lists cowswap enables by default, per chain, and merges them by priority. |
| `src/lib/tokenLogo.ts` | The logo fallback cascade, mirroring cowswap's `getTokenLogoUrls`. |
| `src/lib/tokens.ts` | Offline fallback list (symbols and decimals verified on-chain). |
| `src/components/` | Address panel with QR, the decoded step table, the custom-step builder, the rescue panel, and the JSON import/export. |

## Handing a drop to a keeper

With `VITE_KEEPER_URL` set, the status panel gains **Hand to keeper**: it POSTs the recipe to
`/v1/drops`, and the keeper recompiles `setupData` itself and refuses anything that does not derive the
address given — so the page cannot register a recipe for an address it does not hold the preimage of.
The call is idempotent, so a retry after a timeout is safe.

Saved drops then carry a tag, and it is deliberately **not** the local flag rendered as fact. The
browser only knows what it *sent*; the keeper's own state is the truth, and its `--state` defaults to
memory only, so a restart can lose every registration. The list asks the keeper on open and shows four
distinct answers:

| tag | meaning |
|---|---|
| `local only` | never sent to a keeper |
| `keeper watching` | the keeper holds it and is polling |
| `keeper holds, not watching` | held but retired — the recipe is kept, nothing is polling |
| `sent, keeper has no record` | **we sent it and the keeper does not have it.** The one that needs acting on |
| `sent, keeper unreachable` | the keeper is down; unknown rather than bad |

The last two are separate on purpose: a keeper that is down and a keeper that has forgotten call for
opposite reactions.

## Never lose a recipe

A drop address is a hash of its recipe, and every path that can touch the drop — activation *and* the
owner's rescue — needs those exact bytes back. Nothing on-chain holds them until the first activation.
Funding an address and losing its recipe therefore destroys the money, with no owner override.

So the page treats the recipe as a key rather than a document:

- it is kept in the **URL fragment**, so a bookmark, a pasted link or a plain reload restores it (and a
  fragment never reaches a server);
- it is saved to **localStorage** at every point where funding is plausibly next — copying the address,
  downloading the file, activating — not only on an explicit save, because the failure to prevent is
  someone copying an address and closing the tab;
- **Saved drops** at the top of the page lists them, and says plainly that clearing site data loses
  them, so the downloaded `.drop.json` is still the durable copy;
- the address panel states the consequence, and shows whether the current recipe is saved yet.

## Tokens and logos

Tokens come from the lists cowswap marks `enabledByDefault` in `libs/tokens/src/const/tokensList.json`,
mirrored per chain in `TOKEN_LIST_SOURCES`. This used to be one hardcoded URL,
`files.cow.fi/tokens/CowSwap.json`, on the assumption that it was what CoW Swap shows. It was not, in
two separate ways, and both made the picker far smaller than CoW Swap's:

- **Priority 1 is not the whole default set.** `CowSwap.json` is CoW's own curated list and it is tiny
  on the newer chains — 11 tokens on Arbitrum, 5 on Polygon — while cowswap also enables the CoinGecko
  and Uniswap lists out of the box.
- **Sepolia never used `CowSwap.json` at all.** That file carries no Sepolia tokens whatsoever, so
  loading it there returned nothing and the 3-token built-in fallback was all you ever saw. cowswap
  points Sepolia at `token-lists/CowSwapSepolia.json` instead.

The picker now matches a fresh CoW Swap install exactly: 617 tokens on Ethereum, 661 on Arbitrum, 624
on Polygon, 311 on Gnosis, 7 on Sepolia. The opt-in lists cowswap keeps behind a toggle — Curve,
Balancer, Ondo, xStocks — are left out.

Lists are concatenated in cowswap's priority order and sorted *within* each list rather than across the
whole set, so CoW's curated tokens stay at the top of the picker instead of scattering alphabetically
through several hundred others; the first list wins on a duplicate address. Those curated tokens are
flagged `curated`, which is what the rescue panel lists — it renders a checkbox per token, so it shows
the short list plus the recipe's sell token rather than all 661. Results are cached per chain for the
session, since a chain now costs up to four requests. If every source fails the built-in list stands in
and is not cached, since an unreachable token list should never stop you computing an address.

Logos follow cowswap's cascade from `getTokenLogoUrls`, and the fact that it *is* a cascade is the
point — CoW's CDN answers **403** for addresses it does not carry, so any single URL fails regularly:

1. the list's own `logoURI`, resolved through a `uriToHttp` subset (`ipfs://`, `ipns://`, `http→https`)
2. `files.cow.fi/token-lists/images/<chainId>/<address>/logo.png`
3. the same under mainnet, since many bridged tokens are only there
4. Trust Wallet's assets repo

`TokenLogo` walks that list on each `error` and ends at a lettered circle rather than a broken image.
A native `<select>` cannot show images, so the picker is a button plus a filterable popover; Escape and
outside-click close it.

## Two SDKs, on purpose

`@cowprotocol/cow-drop-sdk` works out *what the address is* — pure, offline, deterministic.
[`@cowprotocol/cow-sdk`](https://www.npmjs.com/package/@cowprotocol/cow-sdk) does everything that
involves talking to CoW: `OrderBookApi` for quotes and order submission, and the chain objects for the
block explorer, the API path and the wrapped native token, none of which should be retyped here.

The one thing cow-sdk does not cover is the CoW Explorer's own network slugs (`gc`, `arb1`, …) —
`internalId` is `xdai`, which that explorer does not accept — so `lib/chain.ts` keeps a small local map
for it.

Quoting note: a drop cannot know its amount ahead of time, so the quote uses a visible **reference
amount** and only its price. That amount is not decoration — quote too little and the fee dominates,
making the market look far worse than it is — which is why it is an input rather than a hidden
constant. It never enters the recipe.
