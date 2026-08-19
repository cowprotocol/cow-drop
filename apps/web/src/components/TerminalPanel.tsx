import { buildActivateTx, type CompiledRecipe } from '@cowprotocol/cow-drop-sdk'

import { cowApiUrl, rpcUrl } from '../lib/chain.js'
import { CopyBlock } from './CopyBlock.js'

/**
 * Activation without the browser wallet — for a keeper, a server, or just checking before funding.
 *
 * A note on what curl can and cannot do here: activation is a state-changing transaction, so it needs
 * a signature, and curl has nothing to sign with. `eth_sendRawTransaction` would want a pre-signed
 * blob, which is not something to paste from a web page. So curl gets the two jobs it genuinely does
 * well — simulating the activation, and reading back the resulting orders — and the actual send is a
 * `cast` command.
 *
 * The simulation is the useful one: it runs the whole recipe against current state and needs no key,
 * no wallet and no funds, so it answers "would this work?" before anyone sends money to the address.
 */
export function TerminalPanel({ compiled }: { compiled: CompiledRecipe }) {
  const chainId = compiled.deployment.chainId
  const rpc = rpcUrl(chainId)
  const tx = buildActivateTx({
    deployment: compiled.deployment,
    owner: compiled.owner,
    setupData: compiled.setupData,
  })

  const simulate = `curl -s ${rpc} \\
  -X POST -H 'content-type: application/json' \\
  --data '${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: tx.to, data: tx.data }, 'latest'],
  })}'`

  const activate = `cast send ${compiled.deployment.executor} \\
  'activate(address,bytes)' \\
  ${compiled.owner} \\
  ${compiled.setupData} \\
  --rpc-url ${rpc} \\
  --private-key $PRIVATE_KEY`

  const orders = `curl -s ${cowApiUrl(chainId)}/account/${compiled.address}/orders | jq '.[] | {uid, status, sellAmount, buyAmount}'`

  return (
    <details className="terminal">
      <summary>Activate from the terminal</summary>

      <p className="hint">
        Anyone can activate a drop, so none of this needs the owner — only gas. Useful for a keeper, or
        for checking a recipe before sending anything.
      </p>

      <CopyBlock
        label="1 · Would it work?"
        hint="Simulates the whole activation against current state — no key, no wallet, no funds needed.
        A successful result is the drop address. A revert is the reason it cannot run yet: NothingToSell
        before anything has arrived, or BalanceTooLow with the two amounts if a minimum guard is not met.
        An empty 0x result means the contracts are not deployed on this chain yet."
        command={simulate}
      />

      <CopyBlock
        label="2 · Actually activate"
        hint="A transaction needs a signature, which curl has nothing to offer — hence cast. Any funded
        key works; it is paying gas, not authorising anything."
        command={activate}
      />

      <CopyBlock
        label="3 · What did it place?"
        hint="Orders the drop owns, once activated. For the TWAP recipe this is how you watch parts appear
        without touching the page."
        command={orders}
      />

      <p className="hint">
        The raw call is <code>to</code> <code>{tx.to}</code>, <code>value</code> 0, and the calldata
        above — everything a relayer or multisig needs.
      </p>
    </details>
  )
}
