import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'

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
        <code className="address">{address}</code>
        <div className="actions">
          <button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy address'}</button>
          <button onClick={download}>Save recipe file</button>
          <span className={saved ? 'ok' : 'warn'}>{saved ? 'recipe remembered' : 'recipe not saved yet'}</span>
        </div>

        <p className="hint keep-recipe">
          <strong>Keep the recipe.</strong> This address is a hash of it, so the recipe is the only way
          to activate the drop — or to recover from it, since the owner&apos;s rescue needs the same bytes.
          Lose it after funding and the money cannot be retrieved by anyone. It is saved in this browser
          and in the page URL; download the file for anything you care about.
        </p>

        <p className="hint">
          Nothing exists at this address yet. Send the sell token here — by bridge, exchange withdrawal
          or plain transfer — then activate. Funds sent before it is deployed are safe: the recipe spends
          them on activation.
        </p>
      </div>
    </div>
  )
}
