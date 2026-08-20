/**
 * The Bungee API as it comes over the wire.
 *
 * Transcribed from `cowprotocol/cow-sdk`'s bungee provider, narrowed to the fields this package
 * reads. Fields it does not read are typed `unknown` rather than dropped, so that a response shape
 * change shows up as a type error at the boundary rather than as `undefined` several layers in.
 *
 * Every amount is a decimal string here: JSON has no bigint, and these are token atoms.
 */

/** A bridge name as Bungee spells it in `includeBridges`. */
export type BridgeName = string

/**
 * There was a `DESTINATION_EXECUTING_BRIDGES` allowlist here. It is now `bungee/capability.ts`.
 *
 * Worth knowing why, because the shape of the mistake is easy to make again. It was three bridge
 * names in a `const`, asserted to run a destination payload, and **Bungee gives no signal for that**:
 * `destinationExec` in a response is a verbatim echo of what you sent (send `0xdeadbeef` and
 * `0xdeadbeef` comes back), and no field on a route says whether the bridge will do anything with it.
 * So the list was a belief with nothing to confront it — and it was wrong about the one name that
 * mattered.
 *
 * A list of names has nowhere to put the transaction that would prove an entry, which is exactly why
 * it stayed unproven. The registry demands the transaction.
 */

export const BUNGEE_BASE_URL = 'https://public-backend.bungee.exchange'
export const BUNGEE_API_PATH = '/api/v1/bungee'
export const BUNGEE_MANUAL_API_PATH = '/api/v1/bungee-manual'

export interface BungeeTokenWire {
  chainId: number
  address: string
  name: string
  symbol: string
  decimals: number
  logoURI?: string
}

export interface BungeeQuoteRequestWire {
  userAddress: string
  originChainId: string
  destinationChainId: string
  inputToken: string
  inputAmount: string
  receiverAddress: string
  outputToken: string
  /** Manual routes only: `enableManual` with auto and swapping off is the plain-bridge configuration. */
  enableManual: true
  disableSwapping: true
  disableAuto: true
  includeBridges?: string
  /** ABI-encoded calldata run on the destination chain after the tokens are delivered. */
  destinationPayload?: string
  /** Gas for that call. Bungee adds its own receiver overhead on top. */
  destinationGasLimit?: string
}

export interface BungeeRouteWire {
  quoteId: string
  /** Unix seconds. */
  quoteExpiry: number
  output: {
    token: BungeeTokenWire
    amount: string
    minAmountOut: string
  }
  approvalData: {
    spenderAddress: string
    amount: string
    tokenAddress: string
    userAddress: string
  } | null
  estimatedTime: number
  routeDetails: {
    name: string
  }
}

export interface BungeeQuoteResponseWire {
  success: boolean
  statusCode: number
  result: {
    originChainId: number
    destinationChainId: number
    userAddress: string
    receiverAddress: string
    input: { token: BungeeTokenWire; amount: string }
    manualRoutes: BungeeRouteWire[]
  }
}

export interface BungeeBuildTxResponseWire {
  success: boolean
  statusCode: number
  result: {
    approvalData: {
      spenderAddress: string
      amount: string
      tokenAddress: string
      userAddress: string
    } | null
    txData: {
      data: string
      to: string
      chainId: number
      value: string
    }
    userOp: unknown
  }
}

export interface BungeeTokenListResponseWire {
  success: boolean
  statusCode: number
  result: BungeeTokenWire[]
}
