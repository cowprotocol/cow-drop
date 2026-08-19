import type { Address } from 'viem'
import { useCallback, useEffect, useState } from 'react'

import { mergeDrops, type MergedDrop, type MergedGroups } from '../lib/dropList.js'
import { keeperUrl, listKeeperDrops, type KeeperDropList } from '../lib/keeper.js'
import { forgetDrop, listDrops } from '../lib/storage.js'

/**
 * The drops this browser and the configured keeper know about, merged.
 *
 * Shared by the builder and the Drops tab: the two render the same rows from the same fetch logic, so
 * the safety-critical parts cannot drift between them. Only the framing differs — the builder folds it
 * into a `<details>`, the tab lays it out flat.
 */
export interface DropListState {
  groups: MergedGroups
  /** The keeper's answer, for the chain it names and the truncation it reports. */
  remote: KeeperDropList | null
  remoteFailed: boolean
  loading: boolean
  total: number
  reload: () => void
  forget: (drop: MergedDrop) => void
}

/**
 * Read localStorage, ask the keeper about the connected account, and merge.
 *
 * Re-runs on `revision` (a drop was written) and on the account changing. No polling and no SSE: the
 * event stream is per-drop, and opening one here would be a subscription for a list that is read rather
 * than watched. A manual reload is offered instead.
 */
export function useDropList(account: Address | null, revision: number): DropListState {
  const [local, setLocal] = useState(() => listDrops())
  const [remote, setRemote] = useState<KeeperDropList | null>(null)
  const [remoteFailed, setRemoteFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setLocal(listDrops())
  }, [revision, attempt])

  useEffect(() => {
    // Nothing to ask about: the endpoint requires an owner, and asking for "everything" is exactly the
    // bulk dump it refuses.
    if (!account || keeperUrl() === null) {
      setRemote(null)
      setRemoteFailed(false)
      return
    }

    let live = true
    setLoading(true)
    setRemoteFailed(false)

    void listKeeperDrops(account)
      .then((answer) => {
        if (live) setRemote(answer)
      })
      .catch(() => {
        // Unknown rather than empty. An unreachable keeper must never render as "you have nothing".
        if (live) {
          setRemote(null)
          setRemoteFailed(true)
        }
      })
      .finally(() => {
        if (live) setLoading(false)
      })

    return () => {
      live = false
    }
  }, [account, revision, attempt])

  const groups = mergeDrops({
    local,
    remote,
    remoteFailed,
    account,
    keeperChainId: remote?.chainId ?? null,
  })

  const forget = useCallback((drop: MergedDrop) => {
    forgetDrop(drop.address, drop.chainId)
    setLocal(listDrops())
  }, [])

  return {
    groups,
    remote,
    remoteFailed,
    loading,
    total: groups.mine.length + groups.keeperOnly.length + groups.otherOwners.length,
    reload: () => setAttempt((n) => n + 1),
    forget,
  }
}
