# cow-drop web

A single page that turns a form into an address.

```bash
pnpm dev      # http://localhost:5173
pnpm build
```

Optional: `VITE_RPC_URL` to use your own Gnosis RPC instead of the public one.

## What the page does

Six panels, top to bottom, in the order you'd actually use them:

1. **Recipe** — swap on arrival, or TWAP on arrival. The hint text under the tabs explains what
   each one needs afterwards (a posted order vs. nothing at all).
2. **Parameters** — tokens, limit price, receiver, owner. The **owner** matters: it's who can recover
   the funds if the recipe turns out to be unrunnable, and it defaults to your connected wallet. The
   **receiver** defaults to the owner, so proceeds land in your wallet rather than piling up in the
   drop; the zero address leaves them in the drop for chaining.
3. **Your drop address** — updates live as you type, with a QR code. Nothing is deployed at it yet,
   and funds sent before deployment are safe; the recipe spends them on activation.
4. **What the address commits to** — the compiled calls and the exact `setupData` bytes. This is the
   only place you can see what you're being asked to fund, which is why it shows raw calldata rather
   than a friendly summary.
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
7. **Recipe file** — import and export. Export, reload the page, import, and the same address comes
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
| `src/lib/tokens.ts` | A small curated Gnosis token list (symbols and decimals verified on-chain). |
| `src/components/` | Address panel with QR, the committed-bytes table, the rescue panel, and the JSON import/export. |

All the interesting logic lives in `@cowprotocol/cow-drop-sdk` — this app is a form around it.
