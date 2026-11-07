import { useEffect, useState } from 'react'

import { ChainTag } from '../components/ChainTag.js'
import { CopyBlock } from '../components/CopyBlock.js'
import { Tooltip } from '../components/Tooltip.js'
import { explorerAddressUrl } from '../lib/chain.js'
import { keeperUrl } from '../lib/keeper.js'

/**
 * What a drop is, and what the keeper this page is pointed at will actually do.
 *
 * The prose is the short version of `docs/DESIGN.md`. The live panel exists because "will it pay for
 * mine?" and "are these the contracts my address was derived from?" are questions the keeper already
 * answers over HTTP and the page has never asked.
 */

interface About {
  chainId: number
  chain?: string
  generation: number
  contracts: Record<string, { name: string; address: string; dropAddress: boolean }>
  proxyCreationCodeHash: string
}

interface Policy {
  mode: string
  maxCostPerActivationWei: string
  dailyBudgetWei: string
  remainingTodayWei: string
  fee?: { recipient: string; minVolumeBps: number; minRevenueRatio: number }
  subsidising?: boolean
}

interface Health {
  ok: boolean
  payer: string
  payerBalanceWei: string
  counts: { total: number; watching: number; activating: number; retired: number }
}

export function AboutTab() {
  const base = keeperUrl()
  const [about, setAbout] = useState<About | null>(null)
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!base) return
    let live = true

    /*
     * `/v1/health` answers **503** with a populated body when the payer is below its floor, so a plain
     * `response.ok` check would throw away the one number an operator came here for. Read the body
     * whenever there is one and let `ok` carry the verdict.
     */
    const read = async (path: string) => {
      const response = await fetch(`${base}${path}`)
      return response.json() as Promise<unknown>
    }

    void Promise.all([read('/v1/about'), read('/v1/policy'), read('/v1/health')])
      .then(([a, p, h]) => {
        if (!live) return
        setAbout(a as About)
        setPolicy(p as Policy)
        setHealth(h as Health)
      })
      .catch(() => {
        if (live) setFailed(true)
      })

    return () => {
      live = false
    }
  }, [base])

  return (
    <>
      <section>
        <h2>What a drop is</h2>
        <p>
          An address that commits to a <strong>recipe</strong>, baked into how the address is derived.
          <Tooltip title="Compared to a plain cow-shed">
            A cow-shed address commits to one thing: its owner. Every action then needs that owner to
            sign, at the moment of acting. cow-drop inverts it.
          </Tooltip>
        </p>
        <CopyBlock
          label="The salt every drop address is derived from"
          command="salt = keccak256(abi.encode(owner, trustedExecutor, userSalt, setupTarget, keccak256(setupData)))"
          language="ts"
        />
        <p className="hint">
          <code>setupData</code> is the recipe. Change one byte and you get a different address, so
          nobody can substitute a recipe at this one. <strong>The address is the authorization.</strong>
        </p>
      </section>

      <section>
        <h2>What follows from that</h2>
        <ul className="hint-list">
          <li>
            <strong>Permissionless.</strong> Anyone can activate a drop.
            <Tooltip title="Permissionless">
              A keeper, a solver pre-interaction, a stranger. There is no privileged sender and nothing
              to steal.
            </Tooltip>
          </li>
          <li>
            <strong>Fund it before it exists.</strong> The recipe spends whatever it finds.
            <Tooltip title="Funding early">
              Funds sent to the counterfactual address are spent on activation. That is what makes it
              work behind a bridge whose payout amount and timing you do not control.
            </Tooltip>
          </li>
          <li>
            <strong>The amount is never committed.</strong> Only the instruction is.
            <Tooltip title="Why no amount">
              Recipe steps run as delegatecalls, so the balance that actually arrived is what gets sold.
              A drop commits to &ldquo;split whatever lands here into 12 parts&rdquo;, not to a number
              nobody could have known.
            </Tooltip>
          </li>
          <li>
            <strong>Recoverable — if you kept the recipe.</strong>{' '}
            <strong>Losing it after funding loses the money, for everyone including the owner.</strong>
            <Tooltip title="The two rescue paths">
              Both are owner-only and need no signature. But both need the recipe bytes, as does
              activation, and only their hash is on-chain. The recipe file is the key, not a
              convenience.
            </Tooltip>
          </li>
        </ul>
        <p className="hint warn-box">
          <strong>Unaudited, and it depends on an unmerged cow-shed PR stack.</strong> Do not put real
          money in it yet.
        </p>
      </section>

      {base ? (
        <section>
          <h2>This keeper</h2>
          {failed ? (
            <p className="hint">
              The keeper at <code>{base}</code> did not answer. The page works without one.
              <Tooltip title="What a keeper adds">
                It activates drops unattended and pays the gas. Nothing else depends on it.
              </Tooltip>
            </p>
          ) : null}

          {/*
            One list rather than one per endpoint: they read as a single set of facts about this keeper, and
            two adjacent `<ul>`s would space their rows differently from the rows inside each. The
            `label: <strong>value</strong>` shape is the same one the builder's status panel uses.
          */}
          {health || policy ? (
            <ul className="status">
              {health ? (
                <>
                  <li>
                    Status:{' '}
                    <strong className={health.ok ? '' : 'warn'}>
                      {health.ok ? 'ok' : 'payer below its floor'}
                    </strong>
                  </li>
                  <li>
                    Drops held:{' '}
                    <strong>
                      {health.counts.total} total · {health.counts.watching} watching ·{' '}
                      {health.counts.retired} retired
                    </strong>
                  </li>
                </>
              ) : null}
              {policy ? (
                <>
                  <li>
                    Policy: <strong>{policy.mode}</strong>
                  </li>
                  <li>
                    {/*
                      Tri-state on purpose. In `paying` mode the answer depends on the recipe, so the
                      honest answer is "it depends" rather than a boolean nobody can stand behind.
                    */}
                    Will it pay for mine?{' '}
                    <strong>
                      {policy.subsidising === undefined
                        ? 'it depends on the recipe — this keeper takes a fee'
                        : policy.subsidising
                          ? 'yes, while its daily budget lasts'
                          : 'not right now'}
                    </strong>
                  </li>
                </>
              ) : null}
            </ul>
          ) : null}

          {about ? (
            <>
              <p className="hint">
                <ChainTag chainId={about.chainId} label={about.chain ?? `chain ${about.chainId}`} />
                {' · '}generation {about.generation}
                <Tooltip title="Generations">
                  The contracts marked below feed the CREATE2 preimage of every drop address. That is
                  why they are versioned as a generation rather than updated in place — changing one
                  would move every address anyone has already funded.
                </Tooltip>
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Address</th>
                    <th>In the address?</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(about.contracts).map(([key, contract]) => {
                    // Linked for the question this table exists to answer: are these the contracts my
                    // address was derived from? That is checked on the explorer, not here.
                    const href = explorerAddressUrl(about.chainId, contract.address)
                    return (
                      <tr key={key}>
                        <td>{contract.name}</td>
                        <td>
                          {href ? (
                            <a href={href} target="_blank" rel="noreferrer">
                              <code>{contract.address}</code>
                            </a>
                          ) : (
                            <code>{contract.address}</code>
                          )}
                        </td>
                        <td>{contract.dropAddress ? 'yes' : 'no'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="hint">
                Its own API surface is at <code>{base}/v1/docs</code>.
              </p>
            </>
          ) : null}
        </section>
      ) : null}
    </>
  )
}
