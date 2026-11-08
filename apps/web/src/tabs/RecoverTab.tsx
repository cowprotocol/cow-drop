import { buildOwnerSweepTx, buildRescueForState, compileRecipe, getDeployment } from '@cowprotocol/cow-drop-sdk'
import { formatUnits, isAddress, type Address } from 'viem'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { chainLabel, blockExplorer, getPublicClient, isUserRejection, sendTransaction, switchChain, walletChainId } from '../lib/chain.js'
import { readDropOwner, readNativeBalance, readTokenBalance } from '../lib/drop.js'
import { listDrops, type SavedDrop } from '../lib/storage.js'
import { fetchTokenList, findToken, type TokenInfo } from '../lib/tokenList.js'
import { ChainLogo } from '../components/ChainLogo.js'
import { Section } from '../components/Section.js'
import { Select, type SelectOption } from '../components/Select.js'
import { TokenLogo } from '../components/TokenLogo.js'
import { TokenPicker } from '../components/TokenPicker.js'
import { Tooltip } from '../components/Tooltip.js'

/** The zero address, which `sweep` reads as "the native balance". */
const NATIVE: Address = '0x0000000000000000000000000000000000000000'

/** One balance the panel knows about, whether or not there is anything in it. */
interface Holding {
  token: Address
  symbol: string
  decimals: number
  info?: TokenInfo
  balance: bigint | null
}

/** A drop the panel can act on: one this browser saved, or an address someone pasted. */
interface Target {
  address: Address
  chainId: number
  /** The saved record, when there is one. Its recipe is what makes an undeployed drop recoverable. */
  saved?: SavedDrop
}

function short(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`
}

/**
 * Recovery, as its own tab.
 *
 * It used to be a step inside the builder, which meant it could only ever act on the drop the form
 * happened to derive. That is the wrong shape: a drop built against an older version of a step
 * contract has an address the current form cannot reproduce, so its owner could see the funds and
 * not reach them. Here the drop is an input — picked from what this browser saved, or pasted — and
 * anything you own is reachable.
 *
 * The two paths are the SDK's. A deployed drop is swept directly by its admin, which needs no recipe
 * at all; an undeployed one has to be deployed first, which does, so that path is only offered for a
 * drop whose recipe this browser still holds.
 */
export function RecoverTab({
  account,
  active,
  onError,
}: {
  account: Address | null
  /** The drop the builder is currently showing, so arriving here preselects it. */
  active: { address: Address; recipe: unknown; chainId: number } | null
  onError?: (message: string) => void
}) {
  const saved = useMemo(() => listDrops(), [])

  const [target, setTarget] = useState<Address | ''>(() => active?.address ?? saved[0]?.address ?? '')
  const [typedChain, setTypedChain] = useState(() => active?.chainId ?? saved[0]?.chainId ?? 100)
  const [tokens, setTokens] = useState<TokenInfo[]>([])
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [selected, setSelected] = useState<Address[]>([NATIVE])
  const [owner, setOwner] = useState<Address | null>(null)
  const [deployed, setDeployed] = useState<boolean | null>(null)
  const [to, setTo] = useState('')
  const [adding, setAdding] = useState<Address | ''>('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  /** The chosen drop, and the chain to act on it: the saved record's, or the one picked for a pasted address. */
  const chosen: Target | null = useMemo(() => {
    if (!target || !isAddress(target)) return null
    const record = saved.find((drop) => drop.address.toLowerCase() === target.toLowerCase())
    return { address: target as Address, chainId: record?.chainId ?? typedChain, saved: record }
  }, [target, saved, typedChain])

  // Token list follows the chain, since a balance is only meaningful against the right one.
  useEffect(() => {
    if (!chosen) return
    let cancelled = false
    void fetchTokenList(chosen.chainId).then((list) => {
      if (!cancelled) setTokens(list)
    })
    return () => {
      cancelled = true
    }
  }, [chosen?.chainId])

  /**
   * Which balances to show before anybody asks.
   *
   * Native always, because it is the one a drop can hold without any ERC20 ever moving — and the one
   * nothing else on the page would mention. Then whatever the saved recipe names, since those are the
   * balances this drop was built to hold.
   */
  const initialTokens = useCallback(
    (drop: Target): Address[] => {
      const named = new Set<Address>()
      const recipe = drop.saved?.recipe
      for (const step of recipe?.steps ?? []) {
        for (const key of ['sellToken', 'buyToken', 'token'] as const) {
          const value = (step as Record<string, unknown>)[key]
          if (typeof value === 'string' && isAddress(value)) named.add(value.toLowerCase() as Address)
        }
      }
      return [...named]
    },
    [],
  )

  /** Read every known balance, and drop the ones that turn out to be empty and unasked for. */
  const load = useCallback(async () => {
    if (!chosen) return
    setLoading(true)
    try {
      const list = tokens.length > 0 ? tokens : await fetchTokenList(chosen.chainId)
      // Native is read separately and always listed first, so it must not also ride along as an
      // ERC20 — re-reading with it in `holdings` would list the drop's own currency twice.
      const wanted = [...new Set([...initialTokens(chosen), ...holdings.map((h) => h.token)])].filter(
        (token) => token !== NATIVE,
      )

      const [native, code, admin, ...balances] = await Promise.all([
        readNativeBalance(chosen.chainId, chosen.address),
        getPublicClient(chosen.chainId).getBytecode({ address: chosen.address }),
        readDropOwner(chosen.chainId, chosen.address),
        ...wanted.map((token) => readTokenBalance(chosen.chainId, token, chosen.address)),
      ])

      setDeployed(Boolean(code && code !== '0x'))
      setOwner(admin ?? (chosen.saved ? (chosen.saved.recipe.owner as Address) : null))

      const rows: Holding[] = [
        { token: NATIVE, symbol: 'native', decimals: 18, balance: native as bigint },
        ...wanted.map((token, index) => {
          const info = findToken(list, token)
          return {
            token,
            symbol: info?.symbol ?? short(token),
            decimals: info?.decimals ?? 18,
            info,
            balance: balances[index] as bigint,
          }
        }),
      ]
      setHoldings(rows)
      // Anything actually there starts ticked: the common case is "get all of it out".
      setSelected(rows.filter((row) => (row.balance ?? 0n) > 0n).map((row) => row.token))
    } catch (cause) {
      onError?.(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
    // `holdings` is read to keep tokens the user added, but must not re-trigger the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen?.address, chosen?.chainId, tokens.length, initialTokens, onError])

  useEffect(() => {
    setHoldings([])
    setOwner(null)
    setDeployed(null)
    setResult(null)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen?.address, chosen?.chainId])

  const options = useMemo<SelectOption<Address | ''>[]>(() => {
    const rows: SelectOption<Address | ''>[] = saved.map((drop) => ({
      value: drop.address,
      label: drop.label || short(drop.address),
      description: `${short(drop.address)} · ${chainLabel(drop.chainId)}`,
      keywords: `${drop.address} ${drop.label}`,
      icon: <ChainLogo chainId={drop.chainId} size={18} />,
      note: active?.address.toLowerCase() === drop.address.toLowerCase() ? 'open in Recipes' : undefined,
    }))
    if (active && !saved.some((drop) => drop.address.toLowerCase() === active.address.toLowerCase())) {
      rows.unshift({
        value: active.address,
        label: short(active.address),
        description: `${chainLabel(active.chainId)} · not saved`,
        keywords: active.address,
        icon: <ChainLogo chainId={active.chainId} size={18} />,
        note: 'open in Recipes',
      })
    }
    /*
     * A pasted address joins the list once it is chosen.
     *
     * The trigger renders whichever option matches the value, so without this a drop picked by
     * pasting left the trigger showing its own placeholder — the one case the tab exists for looked
     * like nothing had been selected.
     */
    if (target && isAddress(target) && !rows.some((row) => row.value.toLowerCase() === target.toLowerCase())) {
      rows.push({
        value: target as Address,
        label: short(target),
        description: 'Pasted address',
        keywords: target,
      })
    }
    return rows
  }, [saved, active, target])

  /** Typing an address that is not in the list offers it as a row — the whole point of the tab. */
  const custom = useCallback((query: string): SelectOption<Address | ''> | null => {
    const trimmed = query.trim()
    if (!isAddress(trimmed)) return null
    return {
      value: trimmed as Address,
      label: short(trimmed),
      description: 'Use this address',
      keywords: trimmed,
    }
  }, [])

  const addToken = (token: Address) => {
    setAdding('')
    if (holdings.some((row) => row.token.toLowerCase() === token.toLowerCase())) return
    const info = findToken(tokens, token)
    setHoldings((current) => [
      ...current,
      { token, symbol: info?.symbol ?? short(token), decimals: info?.decimals ?? 18, info, balance: null },
    ])
    if (chosen) {
      void readTokenBalance(chosen.chainId, token, chosen.address).then((balance) =>
        setHoldings((current) =>
          current.map((row) => (row.token === token ? { ...row, balance } : row)),
        ),
      )
    }
  }

  const toggle = (token: Address) =>
    setSelected((current) =>
      current.includes(token) ? current.filter((t) => t !== token) : [...current, token],
    )

  const isOwner = account !== null && owner !== null && account.toLowerCase() === owner.toLowerCase()
  const recipient = isAddress(to) ? (to as Address) : account
  const anythingToRecover = holdings.some((row) => selected.includes(row.token) && (row.balance ?? 0n) > 0n)
  /** An undeployed drop has to be deployed first, and only its recipe can do that. */
  const needsRecipe = deployed === false
  const blocked = needsRecipe && !chosen?.saved

  const recover = async () => {
    if (!chosen || !account || !recipient) return
    setBusy(true)
    setResult(null)
    try {
      if ((await walletChainId()) !== chosen.chainId) await switchChain(chosen.chainId)

      const tx = chosen.saved
        ? buildRescueForState({
            ...(() => {
              const compiled = compileRecipe(chosen.saved.recipe)
              return { deployment: compiled.deployment, owner: compiled.owner, setupData: compiled.setupData }
            })(),
            drop: chosen.address,
            to: recipient,
            tokens: selected,
            deployed: deployed === true,
          }).tx
        : buildOwnerSweepTx({
            deployment: getDeployment(chosen.chainId),
            drop: chosen.address,
            to: recipient,
            tokens: selected,
          })

      const hash = await sendTransaction({ chainId: chosen.chainId, account, ...tx })
      await getPublicClient(chosen.chainId).waitForTransactionReceipt({ hash })
      setResult({ ok: true, text: `Recovered in ${hash}` })
      await load()
    } catch (cause) {
      if (isUserRejection(cause)) return
      setResult({ ok: false, text: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusy(false)
    }
  }

  const explorer = chosen ? blockExplorer(chosen.chainId) : null

  return (
    <>
      <Section title={<>1 &middot; Pick the drop</>}>
        <div className="grid">
          <Select
            label={
              <span className="label-text">
                Drop
                <Tooltip title="Any drop you own">
                  The list is what this browser saved. Paste any other address to act on it instead —
                  a drop built by an older recipe, or one saved in another browser. Ownership is read
                  from the chain, not from the recipe.
                </Tooltip>
              </span>
            }
            value={target}
            options={options}
            onChange={setTarget}
            searchable
            customOption={custom}
            filterPlaceholder="Search, or paste an address"
            placeholder="Pick a drop, or paste an address"
          />
          {chosen && !chosen.saved && (
            <Select
              label="Network"
              value={chosen.chainId}
              options={[...new Set([1, 100, 8453, 11155111, chosen.chainId])].map((id) => ({
                value: id,
                label: chainLabel(id),
                icon: <ChainLogo chainId={id} size={18} />,
              }))}
              onChange={setTypedChain}
            />
          )}
        </div>

        {chosen && (
          <dl className="facts">
            <dt>Address</dt>
            <dd>
              <code className="address">{chosen.address}</code>
              {explorer && (
                <>
                  {' '}
                  <a href={`${explorer}/address/${chosen.address}`} target="_blank" rel="noreferrer">
                    explorer ↗
                  </a>
                </>
              )}
            </dd>
            <dt>Deployed</dt>
            <dd>{deployed === null ? 'checking…' : deployed ? 'yes' : 'not yet'}</dd>
            <dt>Owner</dt>
            <dd>
              {owner === null ? (
                deployed === false ? 'unknown until deployed' : 'checking…'
              ) : (
                <code className="address">{owner}</code>
              )}
            </dd>
          </dl>
        )}

        {chosen && owner !== null && !isOwner && (
          <p className="hint warn-note">
            Only the owner can recover this drop. Connect {short(owner)}.
          </p>
        )}
        {blocked && (
          <p className="hint warn-note">
            This drop is not deployed, so recovering needs its recipe to deploy it first — and this
            browser does not have it. Load the recipe file in Recipes, then come back.
          </p>
        )}
      </Section>

      <Section title={<>2 &middot; Choose what to recover</>}>
        {!chosen ? (
          <p className="hint">Pick a drop first.</p>
        ) : (
          <>
            <table className="share-table">
              <tbody>
                {holdings.map((row) => {
                  const empty = (row.balance ?? 0n) === 0n
                  return (
                    <tr key={row.token}>
                      <td>
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={selected.includes(row.token)}
                            onChange={() => toggle(row.token)}
                          />
                          {row.info ? <TokenLogo token={row.info} chainId={chosen.chainId} /> : null}
                          {row.token === NATIVE ? chainLabel(chosen.chainId) + ' native' : row.symbol}
                        </label>
                      </td>
                      <td className={empty ? 'hint' : 'ok'}>
                        {row.balance === null
                          ? 'reading…'
                          : `${formatUnits(row.balance, row.decimals)}${empty ? ' — empty' : ''}`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            <div className="grid">
              <TokenPicker
                label="Add a token"
                tokens={tokens}
                value={(adding || NATIVE) as Address}
                chainId={chosen.chainId}
                onChange={addToken}
              />
              <label>
                <span className="label-text">
                  Send to
                  <Tooltip title="Recipient">Blank means the connected account.</Tooltip>
                </span>
                <input placeholder="0x… — blank means you" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </div>

            <div className="actions">
              <button
                onClick={() => void recover()}
                disabled={busy || loading || !isOwner || blocked || !anythingToRecover}
              >
                {busy ? 'Recovering…' : 'Recover funds'}
              </button>
              <button onClick={() => void load()} disabled={loading}>
                {loading ? 'Reading…' : 'Refresh balances'}
              </button>
            </div>

            <p className="hint">
              Empty balances are skipped, so ticking one that is not there is harmless.
              <Tooltip title="Orders already placed">
                A sweep moves balances but does not retire orders the drop already signed, so a drop
                swept mid-schedule still trades whatever arrives next.
              </Tooltip>
            </p>

            {result && (
              <p className={result.ok ? 'ok' : 'error'} role={result.ok ? undefined : 'alert'}>
                {result.text}
              </p>
            )}
          </>
        )}
      </Section>
    </>
  )
}
