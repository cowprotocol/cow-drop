# Web app architecture

What the page does, panel by panel, and the decisions behind it. Running it is covered in the
[README](README.md).

## The four tabs

| | |
|---|---|
| **Recipes** | The builder: a form that turns into an address. The default, and what the page is for. |
| **Drops** | Every drop associated with the connected account, from this browser *and* from the keeper. |
| **About** | What a drop is, and what the keeper this page points at will actually do. |
| **SDK** | The same thing in code. |

Only Recipes is new work. The other three surface things the project already had and never showed: the
keeper's `/v1/about`, `/v1/policy` and `/v1/health`, the SDK reference, and a drop list previously folded
into a `<details>`.

## Recipes, panel by panel

1. **Recipe** — swap on arrival, TWAP on arrival, or stop-loss on arrival. The hint says what each needs
   afterwards: the swap's order must be posted to the API, the two ComposableCoW recipes are self-driving.
2. **Parameters** — network, tokens, limit price, receiver, owner.
   - Switching network does not move the drop address (addresses are identical on every chain), only which
     chain you fund. Picking one also asks the wallet to switch, adding the chain if unknown, and the page
     follows the wallet's own `chainChanged` events so the two cannot drift. A declined prompt is not an
     error.
   - **Token selections reset on a chain change**, since an address from the previous chain would otherwise
     compile into a valid-looking recipe for a token that does not exist there.
   - **Owner** is who can recover the funds if the recipe turns out unrunnable; defaults to your wallet.
     **Receiver** defaults to the owner; the zero address leaves proceeds in the drop for chaining.
   - **Price feeds** appear for the stop-loss, and for the swap when you tick "improve the limit with a
     price feed". For the swap the limit becomes a *floor* the feed may only tighten — **anyone may
     activate a drop, so without a floor whoever activates chooses your price by choosing the moment.**
     Both feeds must quote the same currency, which nothing on-chain can check.
   - **Guards** are optional on every recipe: a minimum balance, and a not-before / not-after window.
     **The minimum is the one that matters** — on a one-shot recipe anyone may trigger the moment the first
     wei lands, sizing the order from a part-delivered balance, which is what a bridge paying in tranches
     does. The panel warns when a one-shot recipe has no minimum. Guards are part of the address, and they
     are refusals, not triggers.
3. **Your drop address** — updates live as you type, with a QR code. Nothing is deployed at it yet, and
   funds sent before deployment are safe.
4. **What the address commits to** — the decoded steps and the exact `setupData` bytes, via the SDK's
   `describeRecipe`. **Activation is permissionless and unsigned, so reading this is the safeguard.**
   Arguments show the exact committed values with no unit conversion: a prettified amount differing by an
   atomic unit would describe a different drop. Four warnings appear where they apply:

   | warning | why |
   |---|---|
   | unrecognised call | the SDK cannot name it, so a funder is trusting the bytes |
   | delegatecall to a non-step contract | it can rewrite the shed's storage, including the admin the rescue path depends on |
   | step contract as a plain call | it would read that contract's zero balance instead of the drop's |
   | `allowFailure` | the activation can complete having skipped the step |

5. **Status** — balance, whether it is deployed, and the activate button. Links to two explorers because
   they answer different questions: CoW Explorer for the *orders*, the chain's explorer for *balances and
   transactions*. It warns when the contracts are not deployed on the chain yet, in which case the address
   is a prediction (a correct one).

   Also holds **Activate from the terminal**. Activation is a signed transaction, so the send is a `cast`
   command; curl gets the two jobs it does — simulating via `eth_call` (no key, no funds, answers "would
   this work?" before anyone sends money) and reading back the drop's orders.
6. **If something goes wrong** — the rescue panel, behind a toggle. Shows which path applies, lets you pick
   balances and destination, and offers "deploy shed only" for manual control. Owner-only.
7. **Add a custom step** — an ABI-driven builder that appends a `raw` step. Two limits stated in the panel:
   every argument is a **literal** committed into the address, so this cannot express anything depending on
   the amount that arrives; and `delegatecall` is off by default and needs a second confirmation.
8. **Recipe file** — import and export. Export, reload, import, and the same address comes back.

## Activation

The connected wallet only pays gas. It is not authorising anything — the recipe was authorised by being
committed into the address — so any account could send the same transaction. Hence the deliberately thin
wallet handling: `viem` plus the injected provider, no connector framework.

For the pre-sign path, activation is followed by a `POST` to the CoW order book, since the pre-signature
exists on-chain but the order still has to be made visible to solvers. For the TWAP path there is nothing
to post; the watch tower takes over.

## Never lose a recipe

A drop address is a hash of its recipe, and every path that can touch the drop — activation *and* the
owner's rescue — needs those exact bytes. Nothing on-chain holds them until the first activation.
**Funding an address and losing its recipe destroys the money, with no owner override.**

So the page treats the recipe as a key:

- kept in the **URL fragment** while Recipes is showing, so a bookmark, a pasted link or a reload restores
  it (and a fragment never reaches a server);
- saved to **localStorage** at every point where funding is plausibly next — copying the address,
  downloading the file, activating — not only on an explicit save, because the failure to prevent is
  someone copying an address and closing the tab;
- **Drops** gets its own tab *and* stays folded above the form, because the moment you need it is the
  moment you have already funded something. Both render the same rows from the same code.
- the address panel states the consequence and shows whether the current recipe is saved yet.

## Handing a drop to a keeper

With `VITE_KEEPER_URL` set, the status panel gains **Hand to keeper**: it POSTs the recipe to `/v1/drops`,
and the keeper recompiles `setupData` itself and refuses anything that does not derive the address given.
The call is idempotent.

Saved drops then carry a tag, and it is deliberately **not** the local flag rendered as fact — the browser
only knows what it *sent*, and the keeper's `--state` defaults to memory, so a restart can lose every
registration. The list asks the keeper on open:

| tag | meaning |
|---|---|
| `local only` | never sent to a keeper |
| `keeper watching` | the keeper holds it and is polling |
| `keeper holds, not watching` | held but retired — the recipe is kept, nothing is polling |
| `sent, keeper has no record` | **we sent it and the keeper does not have it.** The one that needs acting on |
| `sent, keeper unreachable` | the keeper is down; unknown rather than bad |
| `keeper is on another chain` | sent, but this keeper serves a different chain |
| `keeper only — no recipe here` | the keeper has it and this browser does not |
| `sent, not checked` | the listing was filtered by another owner, so it proves nothing |

The distinctions are the point: a keeper that is down and a keeper that has forgotten call for opposite
reactions, and a chain-scoped 404 must not render as the loudest tag here. **Never derive an alarm from a
silence that had an innocent explanation.**

## The Drops tab

Two sources, neither complete. This browser holds the **recipes**, which are the only thing that can
activate or rescue a drop, but only knows what *it* saved. The keeper knows what was registered from
anywhere and hands out **no recipes at all**. So the tab shows both and says which is which.

- **Your drops** — saved here, owned by the connected account. Load, Forget, everything.
- **The keeper for &lt;chain&gt; also has** — registered under this account and not in this browser. Listed
  and linked, with no Load, Forget or activate control: all three need the recipe bytes, and only their
  hash is on-chain.
- **Other accounts in this browser** — collapsed, and deliberately **shown rather than hidden**. Otherwise
  you would watch a drop you funded vanish on switching wallets.

Two things the tab says out loud. The keeper is **per-chain** while localStorage spans every chain, so a
drop elsewhere reads as out of scope rather than missing. And **a keeper row is not proof of ownership**:
registration is open and `owner` is a field of the submitted recipe, so it means *someone registered a
recipe naming you*, never *you made this* — which is why that group warns against funding anything from it.

## Routing

The fragment already carried the recipe and never reaches a server, so the tab rides the same private
channel: no server rewrite, no router dependency.

`#/recipes/<recipe>` is canonical; the other three tabs carry nothing. A fragment that does **not** start
with `/` is read as a bare recipe, which is how every link shared before the tabs existed still opens —
an invariant rather than a heuristic, since `recipeToHash` maps `/` to `_`, so **every `/` in a fragment
is structural**.

Push for a tab, replace for a keystroke. The recipe mirror is gated on Recipes being on screen, and
`pushState`/`replaceState` do not fire `hashchange`, which keeps that mirror from reading back its own
write.

The tabs are **links with `aria-current`**, not an ARIA tablist — they really are pages, and a row of
`role="tab"` without a roving-tabindex model is worse for a screen-reader user than plain links.

The builder **stays mounted** while another tab shows, hidden with the `hidden` attribute; unmounting
would throw away a half-filled form the URL could not restore. `hidden` specifically, because it removes
the subtree from the accessibility tree *and* the tab order. Accepted cost: a *reload* while parked on
another tab loses an unsaved recipe.

## Files

| | |
|---|---|
| `src/App.tsx` | The shell: error banner, header and wallet, tab bar. Nothing about recipes. |
| `src/tabs/RecipesTab.tsx` | The form, and the recipe it builds. `toRecipe` is pure, which is what makes the address update as you type. |
| `src/tabs/DropsTab.tsx` | The three groups, the empty states, and the one-chain footer. |
| `src/tabs/AboutTab.tsx` | What a drop is, plus the keeper's `/v1/about`, `/v1/policy` and `/v1/health`. |
| `src/tabs/SdkTab.tsx` | Copyable snippets, grouped as `packages/sdk/API.md` groups them. |
| `src/lib/route.ts` | Fragment ⇄ tab + recipe. Pure. |
| `src/lib/useRoute.ts` | The fragment as an external store, and the one place that writes it. |
| `src/lib/dropList.ts` | Merging what this browser saved with what the keeper holds. Pure. |
| `src/lib/drop.ts` | Reading drop status, activating, and posting placed orders. |
| `src/lib/chain.ts` | Public client, injected wallet, chain switching. |
| `src/lib/tokenList.ts` | Loads the token lists cowswap enables by default, per chain. |
| `src/lib/tokenLogo.ts` | The logo fallback cascade, mirroring cowswap's `getTokenLogoUrls`. |
| `src/lib/tokens.ts` | Offline fallback list (symbols and decimals verified on-chain). |
| `src/components/` | Address panel with QR, decoded step table, custom-step builder, rescue panel, JSON import/export. |

## Tokens and logos

Tokens come from the lists cowswap marks `enabledByDefault` in
`libs/tokens/src/const/tokensList.json`, mirrored per chain in `TOKEN_LIST_SOURCES`. The picker matches a
fresh CoW Swap install exactly: 617 tokens on Ethereum, 661 on Arbitrum, 624 on Polygon, 311 on Gnosis, 7
on Sepolia. The opt-in lists cowswap keeps behind a toggle — Curve, Balancer, Ondo, xStocks — are left out.

Lists are concatenated in cowswap's priority order and sorted *within* each list rather than across the
whole set, so CoW's curated tokens stay at the top instead of scattering alphabetically; the first list
wins on a duplicate address. Curated tokens are flagged, which is what the rescue panel lists — it renders
a checkbox per token, so it shows the short list plus the recipe's sell token rather than all 661. Results
are cached per chain for the session. If every source fails the built-in list stands in and is not cached,
since an unreachable token list should never stop you computing an address.

Logos follow cowswap's cascade from `getTokenLogoUrls`, and it **is** a cascade because CoW's CDN answers
**403** for addresses it does not carry, so any single URL fails regularly:

1. the list's own `logoURI`, resolved through a `uriToHttp` subset (`ipfs://`, `ipns://`, `http→https`)
2. `files.cow.fi/token-lists/images/<chainId>/<address>/logo.png`
3. the same under mainnet, since many bridged tokens are only there
4. Trust Wallet's assets repo

`TokenLogo` walks that list on each `error` and ends at a lettered circle rather than a broken image. A
native `<select>` cannot show images, so the picker is a button plus a filterable popover.

## Two SDKs, on purpose

`@cowprotocol/cow-drop-sdk` works out *what the address is* — pure, offline, deterministic.
[`@cowprotocol/cow-sdk`](https://www.npmjs.com/package/@cowprotocol/cow-sdk) does everything involving
talking to CoW: `OrderBookApi` for quotes and order submission, and the chain objects for the explorer, the
API path and the wrapped native token.

The one gap is the CoW Explorer's own network slugs (`gc`, `arb1`, …) — `internalId` is `xdai`, which that
explorer does not accept — so `lib/chain.ts` keeps a small local map.

**Quoting note:** a drop cannot know its amount ahead of time, so the quote uses a visible **reference
amount** and only its price. That amount is not decoration — quote too little and the fee dominates, making
the market look far worse than it is — which is why it is an input rather than a hidden constant. It never
enters the recipe.
