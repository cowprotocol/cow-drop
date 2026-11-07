import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'

import { routeHash } from '../lib/route.js'
import { ChainTag } from './ChainTag.js'
import { Tooltip } from './Tooltip.js'

/**
 * The address panel: big, copyable, and scannable, since the whole point is to send funds here.
 *
 * It also carries the warning that matters most in this whole UI. A drop address is a hash commitment
 * to its recipe, and every path that can touch the drop — activation *and* the owner's rescue hatch —
 * needs those exact bytes back. Nothing on-chain holds them before the first activation. So funding an
 * address and losing its recipe destroys the money, with no owner override, because the owner needs the
 * same bytes as everyone else.
 *
 * Copying the address is the moment that risk begins, which is why copying also saves the recipe.
 */
export function DropAddress({
  address,
  saved,
  onRemember,
  recipe,
}: {
  address: Address
  saved: boolean
  onRemember: () => void
  recipe: DropRecipeJson
}) {
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    void QRCode.toDataURL(address, { margin: 1, width: 220 }).then((url) => {
      if (!cancelled) setQr(url)
    })
    return () => {
      cancelled = true
    }
  }, [address])

  const copy = async () => {
    // Saved on copy, not on an explicit button, because the thing to prevent is funding an address and
    // closing the tab.
    onRemember()
    await navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const download = () => {
    onRemember()
    const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${recipe.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${address.slice(0, 10)}.drop.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="drop-address">
      {qr && <img src={qr} alt={`QR code for ${address}`} width={220} height={220} />}
      <div>
        {/* Which chain this address is for, and the way out to it — the same tag the lists use. The
            explorer answers the one question this panel cannot: has anything arrived yet. */}
        <ChainTag chainId={recipe.chainId} address={address} className="address-chain" />
        <code className="address">{address}</code>
        <div className="actions">
          <button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy address'}</button>
          <button onClick={download}>Save recipe file</button>
          {/*
            A link, not a button, because it is a navigation — and it opens in a new tab, because the
            usual move is to keep building here while the card is shown across a room or pasted
            somewhere. It remembers the recipe on the way out for the same reason copying does:
            handing the address to someone else is a moment the recipe must survive.
          */}
          <a
            className="button"
            href={routeHash({ tab: 'share', recipe })}
            target="_blank"
            rel="noreferrer"
            onClick={onRemember}
          >
            Share ↗
          </a>
          <span className={saved ? 'ok' : 'warn'}>{saved ? 'recipe remembered' : 'recipe not saved yet'}</span>
        </div>

        <p className="hint keep-recipe">
          <strong>Keep the recipe.</strong> Lose it after funding and nobody can retrieve the money —
          not even you. Download the file for anything you care about.
          <Tooltip title="Why">
            The address is a hash of the recipe, so the recipe is the only way to activate or recover
            the drop. It lives in this browser and in the page URL, and nowhere else.
          </Tooltip>
        </p>

        <p className="hint">
          Nothing exists here yet. Send the sell token, then activate.
          <Tooltip title="Sending before deployment">
            Funds sent to an undeployed drop are safe: the recipe spends whatever it finds when it runs.
          </Tooltip>
        </p>
      </div>
    </div>
  )
}
