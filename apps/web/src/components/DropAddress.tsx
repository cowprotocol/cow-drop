import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'

/** The address panel: big, copyable, and scannable, since the whole point is to send funds here. */
export function DropAddress({ address }: { address: Address }) {
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
    await navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="drop-address">
      {qr && <img src={qr} alt={`QR code for ${address}`} width={220} height={220} />}
      <div>
        <code className="address">{address}</code>
        <div className="actions">
          <button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy address'}</button>
        </div>
        <p className="hint">
          Nothing exists at this address yet. Send the sell token here — by bridge, exchange
          withdrawal or plain transfer — then activate. Funds sent before it is deployed are safe:
          the recipe spends them on activation.
        </p>
      </div>
    </div>
  )
}
