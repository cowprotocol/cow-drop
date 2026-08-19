import type { EvmCall } from '@cowprotocol/cow-drop-sdk'
import { createPublicClient, http, keccak256, type Address, type Hex, type PublicClient } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'

/** What a simulation said. Never a boolean — the revert data is what classifies the drop. */
export type SimulationResult =
  | { ok: true; gas: bigint }
  | { ok: false; revertData?: Hex; message: string }

/**
 * The six things the keeper needs from a chain.
 *
 * Narrow for the same reason the watch tower's `ChainReader` is: everything interesting here is a
 * *decision* — is it ready, can we afford it, did it land — and a fake with six methods lets a test
 * drive a revert, a fee spike or a crash without a node.
 */
export interface KeeperChain {
  getBlockNumber(): Promise<bigint>
  /** One round trip for every balance in a tick. `token: null` is the native balance. */
  getBalances(requests: readonly { token: Address | null; holder: Address }[]): Promise<bigint[]>
  /** The authoritative readiness gate. Returns the gas as well, so one call does both jobs. */
  simulateActivation(params: { call: EvmCall; from: Address }): Promise<SimulationResult>
  getFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>
  getTransactionCount(address: Address): Promise<number>
  getReceipt(hash: Hex): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint; costWei: bigint } | undefined>
}

export interface PreparedActivation {
  /** The transaction hash — known from signing, before anything is broadcast. */
  ref: Hex
  nonce: number
  gasLimit: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  /** The raw signed transaction. Deliberately not persisted. */
  payload: Hex
}

/**
 * Who pays, and how a transaction gets out.
 *
 * **Two phases on purpose.** A single `sendTransaction` would leave a window where the transaction is
 * in the mempool and the store does not know about it — and a crash inside that window means either
 * re-sending (paying twice) or forgetting (a drop stuck `activating` forever). Signing locally yields
 * the hash *before* any bytes leave the process, so the record can be written first and the window
 * closes entirely.
 *
 * It is also the seam a relayer slots into: `ref` need not be a transaction hash, and nothing above
 * treats it as one beyond persisting it and asking `getReceipt` about it.
 */
export interface Submitter {
  payer(): Promise<Address>
  balance(): Promise<bigint>
  /** Sign or reserve, but do not broadcast. */
  prepare(params: {
    call: EvmCall
    gasLimit: bigint
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
    nonce: number
  }): Promise<PreparedActivation>
  /** Idempotent: re-broadcasting the same prepared activation is a no-op, not a second transaction. */
  broadcast(prepared: PreparedActivation): Promise<void>
}

const ERC20_BALANCE_OF = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/**
 * A viem client as the interface above.
 *
 * The client should be built with `batch: { multicall: true }` — see `keeperClient` — so a tick's
 * balance reads collapse into one request. The app's RPCs are public and unauthenticated, and N
 * sequential `balanceOf` calls per tick is how you get rate-limited off them.
 */
export function viemKeeperChain(client: PublicClient): KeeperChain {
  return {
    getBlockNumber: () => client.getBlockNumber(),

    getBalances: (requests) =>
      Promise.all(
        requests.map((request) =>
          request.token === null
            ? client.getBalance({ address: request.holder })
            : client
                .readContract({
                  address: request.token,
                  abi: ERC20_BALANCE_OF,
                  functionName: 'balanceOf',
                  args: [request.holder],
                })
                // A token that is not a token, or not deployed here. Zero is the honest answer and
                // the simulation is the real gate anyway.
                .catch(() => 0n),
        ),
      ),

    async simulateActivation({ call, from }) {
      try {
        // `estimateGas` answers both questions at once — would it work, and how much — and reverts
        // with the same data `eth_call` would.
        const gas = await client.estimateGas({ account: from, to: call.to, data: call.data, value: call.value })
        return { ok: true, gas }
      } catch (error) {
        return { ok: false, revertData: revertDataOf(error), message: messageOf(error) }
      }
    },

    async getFees() {
      const fees = await client.estimateFeesPerGas()
      return {
        maxFeePerGas: fees.maxFeePerGas ?? 0n,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
      }
    },

    getTransactionCount: (address) => client.getTransactionCount({ address, blockTag: 'pending' }),

    async getReceipt(hash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash })
        return {
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          costWei: receipt.gasUsed * receipt.effectiveGasPrice,
        }
      } catch {
        // Not mined yet, or never seen. The caller distinguishes those by the nonce.
        return undefined
      }
    },
  }
}

/** Dig the revert bytes out of whatever viem wrapped them in. */
function revertDataOf(error: unknown): Hex | undefined {
  const seen = new Set<unknown>()
  let cursor: unknown = error

  while (cursor && typeof cursor === 'object' && !seen.has(cursor)) {
    seen.add(cursor)
    const candidate = (cursor as { data?: unknown }).data
    if (typeof candidate === 'string' && candidate.startsWith('0x')) return candidate as Hex
    if (typeof candidate === 'object' && candidate !== null) {
      const nested = (candidate as { data?: unknown }).data
      if (typeof nested === 'string' && nested.startsWith('0x')) return nested as Hex
    }
    cursor = (cursor as { cause?: unknown }).cause
  }
  return undefined
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message
  return String(error)
}

/** A public client shaped for this workload: batched, so a tick is one request rather than dozens. */
export function keeperClient(rpcUrl: string): PublicClient {
  return createPublicClient({
    transport: http(rpcUrl, { batch: true }),
    batch: { multicall: true },
  })
}

/**
 * The hot key, as a `Submitter`.
 *
 * The only file that knows a private key exists. Everything above it sees `payer` / `prepare` /
 * `broadcast`, which is what makes a relayer a drop-in replacement rather than a rewrite.
 */
export function viemSubmitter(client: PublicClient, account: PrivateKeyAccount, chainId: number): Submitter {
  return {
    payer: async () => account.address,
    balance: () => client.getBalance({ address: account.address }),

    async prepare({ call, gasLimit, maxFeePerGas, maxPriorityFeePerGas, nonce }) {
      const payload = await account.signTransaction({
        chainId,
        to: call.to,
        data: call.data,
        value: call.value,
        gas: gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        nonce,
        type: 'eip1559',
      })

      // The hash of a signed transaction is knowable before anyone has seen it. That is the whole
      // point of the two-phase interface: the store can record it before it is broadcast.
      return { ref: keccak256(payload), nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, payload }
    },

    async broadcast(prepared) {
      try {
        await client.request({ method: 'eth_sendRawTransaction', params: [prepared.payload] })
      } catch (error) {
        // The node has it already — from a previous attempt, or another node gossiped it. Not a
        // failure: the transaction the caller wanted is in flight.
        if (/already known|nonce too low|already imported/i.test(messageOf(error))) return
        throw error
      }
    },
  }
}
