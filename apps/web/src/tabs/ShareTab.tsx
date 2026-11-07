import { compileRecipe, type DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import QRCode from 'qrcode'
import { useEffect, useMemo, useState } from 'react'

import { blockExplorer, chainLabel, cowExplorer } from '../lib/chain.js'
import { routeHash } from '../lib/route.js'
import { summariseRecipe } from '../lib/shareSummary.js'
import { fetchTokenList, findToken, type TokenInfo } from '../lib/tokenList.js'
import { ChainTag } from '../components/ChainTag.js'
import { PaymentPanel, paymentStepOf } from '../components/PaymentPanel.js'
import { Tooltip } from '../components/Tooltip.js'

/**
 * The share card: one drop, one big QR, and a plain-language table of what it does.
 *
 * This is the page you hand to someone else, so it is built for two situations the rest of the app is
 * not. One is a screen in a room — the QR is sized off the viewport so it can be scanned across a
 * desk, and nothing competes with it. The other is a link in a public timeline, where the reader has
 * never seen this project: no form, no wallet, no tabs, and the first thing on the page is a sentence
 * rather than an address.
 *
 * Sharing a recipe is safe, and that is the design rather than a hope. Activation is permissionless
 * by construction — the recipe is hashed into the address, so a stranger who runs it cannot change
 * what it does, and the proceeds go where the committed bytes already say. The only thing publishing
 * changes is *when* someone might trigger it, which is why `summariseRecipe` raises the one-shot
 * caveat on the recipes where that matters.
 */
export function ShareTab({ recipe }: { recipe: DropRecipeJson | null }) {
  if (!recipe) {
    return (
      <section className="share-empty">
        <h2>Nothing to share</h2>
        <p className="hint">
          A share link carries its recipe in the URL. This one arrived without one — build a drop and
          press <strong>Share</strong>.
        </p>
        <a className="button" href={routeHash({ tab: 'recipes' })}>
          Build a drop
        </a>
      </section>
    )
  }

  return <ShareCard recipe={recipe} />
}

function ShareCard({ recipe }: { recipe: DropRecipeJson }) {
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState<'address' | 'link' | null>(null)
  const [tokens, setTokens] = useState<TokenInfo[]>([])

  /*
   * A recipe off a URL is untrusted input — a truncated paste, or a link from an older generation
   * whose step contracts this build has never heard of. Compiling it is also the only way to get the
   * address, so the failure has to be rendered rather than thrown: a blank page tells the person who
   * followed the link nothing.
   */
  const compiled = useMemo(() => {
    try {
      return { ok: true as const, value: compileRecipe(recipe) }
    } catch (cause) {
      return { ok: false as const, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [recipe])

  const address = compiled.ok ? compiled.value.address : null

  useEffect(() => {
    if (!address) return
    let cancelled = false
    /*
     * The plain address, not an `ethereum:` URI. Exchange withdrawal screens are a first-class way to
     * fund a drop and many of their scanners read nothing else, so the payload stays the lowest
     * common denominator that every wallet, exchange app and camera can handle.
     *
     * Rendered at 720px and scaled down by CSS rather than generated at display size: this is made to
     * be shown on a projector or a laptop screen and scanned from a metre away, and a QR resampled
     * upwards loses the sharp module edges a camera locks onto.
     */
    void QRCode.toDataURL(address, { margin: 2, width: 720, errorCorrectionLevel: 'M' }).then((url) => {
      if (!cancelled) setQr(url)
    })
    return () => {
      cancelled = true
    }
  }, [address])

  /* Symbols are cosmetic, so a failed list leaves addresses on screen rather than an error. */
  useEffect(() => {
    let cancelled = false
    void fetchTokenList(recipe.chainId)
      .then((tokens) => {
        if (!cancelled) setTokens(tokens)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [recipe.chainId])

  const summary = useMemo(
    () =>
      summariseRecipe(
        recipe,
        (value) => findToken(tokens, value)?.symbol,
        (value) => findToken(tokens, value)?.decimals,
      ),
    [recipe, tokens],
  )

  const shareUrl = `${window.location.origin}${window.location.pathname}${routeHash({ tab: 'share', recipe })}`

  const flash = (what: 'address' | 'link') => {
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }

  const copyLink = async () => {
    await navigator.clipboard.writeText(shareUrl)
    flash('link')
  }

  const copyAddress = async () => {
    if (!address) return
    await navigator.clipboard.writeText(address)
    flash('address')
  }

  /*
   * The OS share sheet, which is what actually reaches the social apps on a phone. Absent on most
   * desktop browsers, so it is an extra button next to Copy link rather than the only way to share —
   * and a cancelled sheet rejects, which is not an error worth showing anyone.
   */
  const nativeShare =
    typeof navigator.share === 'function'
      ? () => {
          void navigator.share({ title: recipe.label, text: summary.headline, url: shareUrl }).catch(() => undefined)
        }
      : null

  if (!compiled.ok) {
    return (
      <section className="share-empty">
        <h2>This link does not compile</h2>
        <p className="error">{compiled.error}</p>
        <p className="hint">
          The recipe in this link does not resolve to an address, so there is nothing safe to show. It
          may have been truncated in transit, or built against a generation this page does not know.
        </p>
        <a className="button" href={routeHash({ tab: 'recipes' })}>
          Build a drop
        </a>
      </section>
    )
  }

  const explorer = blockExplorer(recipe.chainId)
  const isPayment = paymentStepOf(recipe) !== undefined

  return (
    <section className="share">
      <header className="share-head">
        <h1>{recipe.label}</h1>
        <p className="share-headline">{summary.headline}</p>
      </header>

      <div className="share-body">
        <div className="share-qr">
          {/* Sized by CSS, not by the attributes, but both are given so the box is reserved before
              the data URL resolves and the table below does not jump. */}
          {qr && <img src={qr} alt={`QR code for ${address ?? ''}`} width={720} height={720} />}
          {/* The chain, stated before the address rather than only in the sentence under it. This card
              is read by someone about to send money, and sending on the wrong chain is the mistake. */}
          <ChainTag chainId={recipe.chainId} address={address ?? undefined} className="address-chain" />
          <code className="address share-address">{address}</code>
          <div className="actions share-actions">
            <button onClick={() => void copyAddress()}>{copied === 'address' ? 'Copied' : 'Copy address'}</button>
            <button onClick={() => void copyLink()}>{copied === 'link' ? 'Link copied' : 'Copy link'}</button>
            {nativeShare && <button onClick={nativeShare}>Share…</button>}
          </div>
          {isPayment ? (
            <p className="hint">Pay on {chainLabel(recipe.chainId)} only.</p>
          ) : (
            <p className="hint">
              Scan it, or send {chainLabel(recipe.chainId)} funds to the address any way you like.
              <Tooltip title="Sending early is safe">
                Nothing is deployed here yet. The recipe spends whatever has arrived when it runs.
              </Tooltip>
            </p>
          )}
        </div>

        <div className="share-what">
          <table className="share-table">
            <caption>{isPayment ? 'Payment request' : 'What this address does'}</caption>
            <tbody>
              {summary.rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <td>
                    {row.value}
                    {row.hint && <div className="hint">{row.hint}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* A payer's real question is "how much do I send": answered live, in the token they hold. */}
          {isPayment && address && tokens.length > 0 && (
            <PaymentPanel recipe={recipe} address={address} deployment={compiled.value.deployment} tokens={tokens} />
          )}

          {summary.notes.map((note) => (
            <p key={note} className="hint warn-note">
              {note}
            </p>
          ))}

          <p className="hint">
            {!isPayment && (
              <>
                Anyone can trigger this, and nobody can change it — the address is a hash of the
                recipe.{' '}
              </>
            )}
            <a href={`${cowExplorer(recipe.chainId)}/address/${address ?? ''}`} target="_blank" rel="noreferrer">
              View orders on CoW Explorer
            </a>
            {' · '}
            <a href={`${explorer.url}/address/${address ?? ''}`} target="_blank" rel="noreferrer">
              View on {explorer.name}
            </a>
          </p>

          {/* A payer has no use for the builder, and a bridge cannot pay a payment request: it calls plain
              `activate`, which a payment recipe refuses. */}
          {!isPayment && (
            <div className="actions">
              <a className="button" href={routeHash({ tab: 'recipes', recipe })}>
                Open in the builder
              </a>
              <a className="button secondary" href={routeHash({ tab: 'bridge', recipe })}>
                Fund it from another chain
              </a>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
