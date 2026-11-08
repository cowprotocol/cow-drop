import type { DropRecipeJson } from '@cowprotocol/cow-drop-sdk'
import { useMemo, useState } from 'react'
import type { Address } from 'viem'

import { chainLabel, explorerAddressUrl } from '../lib/chain.js'
import { routeHash } from '../lib/route.js'
import { nicknameOf, useNicknameRevision } from '../lib/nicknames.js'
import { listDrops } from '../lib/storage.js'
import { ChainLogo } from './ChainLogo.js'
import { QrZoom } from './QrZoom.js'
import { Select, type SelectOption } from './Select.js'

/**
 * The option that leaves rather than chooses.
 *
 * A sentinel instead of a link below the list, because it has to be reachable the same way every
 * other row is — arrow keys and Enter — and a link outside the listbox is not.
 */
const VIEW_ALL = 'view-all'

/** A drop's identity: the same address on two chains is two drops. */
function key(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`
}

/**
 * The drop currently on the bench, in the header.
 *
 * The address used to exist only inside step 3, which meant that the moment you scrolled past it —
 * to set a guard, to read the committed steps, to watch the status — the one thing anybody else
 * needs was off screen. This keeps it in reach: the name, the chain, a QR to hold up, and the two
 * ways an address leaves this page.
 *
 * Shown in full, never truncated. An address is the thing money is sent to, and a reader comparing
 * what is on their screen against what is in their wallet cannot do it against an ellipsis — which
 * is exactly the check that catches an address swapped in flight.
 *
 * Deliberately not a second copy of step 3. There is no "keep the recipe" warning here and no
 * download: those belong at the moment the address is first produced, and repeating them would
 * teach people to skip them. This is a reminder of what is loaded, not a place to act on it.
 */
export function DropBadge({
  recipe,
  address,
  onRemember,
  onLoad,
  onViewAll,
  revision,
}: {
  recipe: DropRecipeJson
  address: Address
  /** Copying or sharing hands the address to someone else — a moment the recipe has to survive. */
  onRemember: () => void
  /** Switch the builder to another saved drop. */
  onLoad: (recipe: DropRecipeJson) => void
  /** Leave for the full list, which can do things this cannot — forget, rescue, read keeper state. */
  onViewAll: () => void
  /** Bumped whenever a drop is written, so the list below re-reads `localStorage`. */
  revision: number
}) {
  const [copied, setCopied] = useState(false)
  const explorer = explorerAddressUrl(recipe.chainId, address)

  /*
   * The saved drops, which is deliberately not everything the Drops tab shows.
   *
   * That list also carries rows the keeper knows about and this browser does not, and those cannot
   * be loaded — switching to one would mean switching to nothing, because the recipe is what the
   * builder works on and only the keeper has it. So this offers what it can actually open, and
   * "View all drops" goes where the rest live.
   */
  /* Re-read when a drop is renamed from the Drops tab, so the strip and the list agree. */
  const nicknames = useNicknameRevision()
  const saved = useMemo(() => listDrops(), [revision])

  /** What *you* call this drop, falling back to what the recipe calls it. */
  const nameFor = (chainId: number, address: string, fallback: string) =>
    nicknameOf(chainId, address) ?? fallback

  const current = key(recipe.chainId, address)

  const options = useMemo<SelectOption<string>[]>(() => {
    const rows = saved.map((drop) => ({
      value: key(drop.chainId, drop.address),
      label: nameFor(drop.chainId, drop.address, drop.label),
      description: `${chainLabel(drop.chainId)} · ${drop.address.slice(0, 10)}…${drop.address.slice(-6)}`,
      keywords: drop.address,
      icon: <ChainLogo chainId={drop.chainId} size={18} />,
    }))

    // The drop on the bench may not be saved yet — it is saved on copy, share or download — and a
    // trigger with nothing selected would read as "no drop loaded" while one plainly is.
    if (!rows.some((row) => row.value === current)) {
      rows.unshift({
        value: current,
        label: nameFor(recipe.chainId, address, recipe.label),
        description: `${chainLabel(recipe.chainId)} · not saved yet`,
        keywords: address,
        icon: <ChainLogo chainId={recipe.chainId} size={18} />,
      })
    }

    return [...rows, { value: VIEW_ALL, label: 'View all drops', description: 'Open the Drops tab' }]
    // `nicknames` is a dependency in substance: `nameFor` reads a store it does not close over.
  }, [saved, current, recipe, address, nicknames])

  const choose = (next: string) => {
    if (next === VIEW_ALL) {
      onViewAll()
      return
    }
    if (next === current) return
    const picked = saved.find((drop) => key(drop.chainId, drop.address) === next)
    if (picked) onLoad(picked.recipe)
  }

  const copy = async () => {
    /*
     * Remembered first, and not conditionally.
     *
     * `writeText` rejects for reasons that have nothing to do with the drop — an unfocused document
     * is enough — and the recipe surviving matters more than the copy landing. Behind the old order
     * a refused clipboard meant the recipe was never saved, which is the one failure this app cannot
     * afford: an address someone then funds, with no recipe to activate or recover it.
     */
    onRemember()
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Nothing useful to say: the address is on screen in full, and selectable.
    }
  }

  return (
    <div className="drop-badge">
      <QrZoom value={address} label={recipe.label} />

      <div className="drop-badge-text">
        <strong>{nameFor(recipe.chainId, address, recipe.label)}</strong>

        {/*
          The chain's mark sits on the address line rather than above it: which chain an address is
          on is part of reading the address, not a separate fact about the drop. Sending to the right
          address on the wrong chain is the mistake this is here to prevent.
        */}
        <span className="drop-badge-address">
          <ChainLogo chainId={recipe.chainId} size={16} />
          {explorer ? (
            <a href={explorer} target="_blank" rel="noreferrer" title={`View on ${chainLabel(recipe.chainId)}`}>
              <code>{address}</code>
            </a>
          ) : (
            <code>{address}</code>
          )}
        </span>
      </div>

      <div className="drop-badge-actions">
        {/*
          Switching is an action, so it looks like one. It was the drop's own name for a while —
          clicking the title to change which title it was — which read as a label that happened to
          move, rather than as a thing you could press.
        */}
        <Select
          className="drop-switcher"
          triggerLabel="Change"
          value={current}
          options={options}
          onChange={choose}
          searchable={saved.length > 6}
          filterPlaceholder="Name or address"
        />
        <button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
        <a
          className="button"
          href={routeHash({ tab: 'share', recipe })}
          target="_blank"
          rel="noreferrer"
          onClick={onRemember}
        >
          Share ↗
        </a>
      </div>
    </div>
  )
}
