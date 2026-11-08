import { DROP_CHAINS } from '@cowprotocol/cow-drop-sdk'
import type { Address, EIP1193Provider } from 'viem'

import { viemChain } from './chain.js'
import { configuredReownProjectId } from './runtimeConfig.js'

/**
 * Wallet connection through Reown AppKit, when a project id is configured.
 *
 * Why at all: `window.ethereum` is one wallet on one device. It is absent on a phone browser, absent
 * in a desktop browser without an extension, and says nothing about the wallet somebody actually
 * keeps their funds in. A drop is frequently funded from a phone — the share card exists to be
 * scanned off one screen by another — and that is precisely the case the injected provider cannot
 * serve. AppKit adds WalletConnect, so the long tail of wallets and every mobile one can sign.
 *
 * Why it stays optional: AppKit needs a project id from `dashboard.reown.com`, which is an account
 * somebody has to create. Without one the page connects to an injected wallet exactly as it always
 * has. Nothing here is required to activate a drop — activation is permissionless and the
 * transaction authorises nothing, so a wallet is only ever paying gas.
 *
 * Why it is loaded lazily: AppKit and its WalletConnect transport are a far larger dependency than
 * the rest of this app put together. Importing it at module scope would make every visitor pay for
 * it — including the ones reading a share card, who never connect anything. The `import()` below
 * runs on the first click instead, so an unconfigured deployment ships none of it at all.
 */

/** Loosely typed so the AppKit types stay behind the dynamic import rather than in the main bundle. */
interface AppKitLike {
  open: (options?: unknown) => Promise<unknown>
  close: () => Promise<void>
  disconnect: (namespace?: string) => Promise<void>
  getAddress: (namespace?: string) => string | undefined
  getProvider: <T>(namespace: string) => T | undefined
  getIsConnectedState: () => boolean
  subscribeAccount: (callback: (state: { address?: string; isConnected?: boolean }) => void) => () => void
  subscribeState: (callback: (state: { open: boolean; initialized?: boolean }) => void) => () => void
}

/** Whether this deployment has AppKit configured at all. Cheap, and safe to call during render. */
export function walletModalEnabled(): boolean {
  return configuredReownProjectId() !== undefined
}

/** The single AppKit instance, created on first use. Creating two would race over the same storage. */
let appKit: Promise<AppKitLike> | null = null

function loadAppKit(): Promise<AppKitLike> {
  const projectId = configuredReownProjectId()
  if (!projectId) throw new Error('No Reown project id configured')

  appKit ??= (async () => {
    /*
     * The `core` entry point, not the default one. It is AppKit without a chain adapter: a modal, a
     * WalletConnect session and an EIP-1193 provider, which is the whole of what this app needs —
     * every call below already goes through viem against a provider. Pulling in the wagmi or ethers
     * adapter would add a second web3 stack beside viem to deliver the same object.
     */
    const { createAppKit } = await import('@reown/appkit/core')

    return createAppKit({
      projectId,
      // Every chain the SDK supports, mapped through viem so there is no second chain table.
      networks: DROP_CHAINS.map((chain) => viemChain(chain.chainId)) as never,
      metadata: {
        name: 'cow-drop',
        description: 'Drop tokens into an address, triggering your predefined intent permissionlessly.',
        url: window.location.origin,
        icons: [`${window.location.origin}/logo.png`],
      },
      // Email and social sign-in create a custodial-ish key this app has no use for: the owner of a
      // drop is an address that must still exist to rescue funds months later.
      features: { email: false, socials: false, analytics: false },
    }) as unknown as AppKitLike
  })()

  return appKit
}

/** The provider AppKit is connected through, or null when it is not connected. */
export async function modalProvider(): Promise<EIP1193Provider | null> {
  if (!walletModalEnabled() || appKit === null) return null
  const kit = await appKit
  if (!kit.getIsConnectedState()) return null
  return kit.getProvider<EIP1193Provider>('eip155') ?? null
}

/**
 * Synchronous view of the same thing, for the call sites that cannot await.
 *
 * Kept in step by `watchModalAccount` below rather than queried, because every wallet call in
 * `chain.ts` is sync at the point it picks a provider.
 */
let connectedProvider: EIP1193Provider | null = null

export function modalProviderSync(): EIP1193Provider | null {
  return connectedProvider
}

/**
 * Open the modal and resolve once an account is connected, or null if the user closed it.
 *
 * Resolving on the *subscription* rather than on `open()` returning is deliberate: `open()` resolves
 * when the modal is on screen, which is before anyone has chosen a wallet, scanned a QR or approved
 * anything.
 */
export async function openWalletModal(): Promise<Address | null> {
  const kit = await loadAppKit()

  /*
   * End any session AppKit still holds before opening.
   *
   * This used to short-circuit instead — if AppKit reported a connection, it returned that address
   * without opening anything. That reads as an optimisation and is a trap: the only way to reach
   * this function is by pressing **Connect wallet**, which is only on screen when the page has *no*
   * account. So arriving here with AppKit still connected means the two have come apart, and the
   * one thing that must not happen is handing back the same wallet again.
   *
   * It is exactly what a refused chain switch produced: connect a wallet that will not move to the
   * selected chain, and every further press re-offered that same wallet and failed the same way,
   * with no route to a different one. `offerChain` in `chain.ts` fixes the cause; this makes the
   * retry honest regardless — pressing Connect always ends up at the chooser.
   */
  if (kit.getIsConnectedState()) {
    try {
      await kit.disconnect('eip155')
    } catch {
      // Already gone, or the wallet would not say. Opening the modal is still the right next step.
    }
    connectedProvider = null
  }

  return new Promise<Address | null>((resolve, reject) => {
    let settled = false
    const stop: (() => void)[] = []
    const finish = (address: Address | null) => {
      if (settled) return
      settled = true
      for (const off of stop) off()
      resolve(address)
    }

    stop.push(
      kit.subscribeAccount((state) => {
        if (state.isConnected && state.address) {
          connectedProvider = kit.getProvider<EIP1193Provider>('eip155') ?? null
          finish(state.address as Address)
        }
      }),
    )

    /*
     * The modal dismissed without connecting, which has to resolve the promise or the button spins
     * for ever. AppKit's own `open` flag, not the DOM: `<w3m-modal>` is mounted once and stays in
     * the document when closed, so looking for the element answers "has it ever opened", not "is it
     * open" — and a timeout would abandon anyone part-way through scanning a QR code.
     *
     * Guarded on having seen it open first, because the subscription fires immediately with the
     * current state, which is `open: false` until the modal mounts.
     */
    /*
     * Armed only once the modal is both open and initialised.
     *
     * `open` goes true the moment `open()` is called, while AppKit is still loading its UI and
     * fetching the wallet list — and it passes back through false on the way to being ready. Treating
     * the first false as a dismissal closed the connection attempt about 400ms after the click,
     * every time, before the modal had drawn anything: the button returned to "Connect wallet" and
     * it looked as though nothing had happened at all.
     */
    let armed = false
    stop.push(
      kit.subscribeState((state) => {
        if (state.open && state.initialized) armed = true
        else if (armed && !state.open) finish(null)
      }),
    )

    /*
     * A failure to open is not a dismissal, and must not be reported as one. Swallowing it here is
     * what made this undiagnosable: the button returned to its resting state in under half a second
     * with no modal, no error and nothing in the console.
     */
    void kit.open().catch((cause: unknown) => {
      if (settled) return
      settled = true
      for (const off of stop) off()
      reject(cause instanceof Error ? cause : new Error(String(cause)))
    })
  })
}

/** Follow AppKit's account, so a disconnection from inside the modal reaches the page. */
export function watchModalAccount(listener: (account: Address | null) => void): () => void {
  if (!walletModalEnabled()) return () => {}

  let unsubscribe: (() => void) | null = null
  let cancelled = false

  // Only once AppKit exists: loading it here would defeat the lazy import for every visitor.
  void (async () => {
    if (appKit === null) return
    const kit = await appKit
    if (cancelled) return
    unsubscribe = kit.subscribeAccount((state) => {
      connectedProvider = state.isConnected ? (kit.getProvider<EIP1193Provider>('eip155') ?? null) : null
      listener(state.isConnected && state.address ? (state.address as Address) : null)
    })
  })()

  return () => {
    cancelled = true
    unsubscribe?.()
  }
}

/** Whether a modal session is what is currently connected, as opposed to a browser extension. */
export function hasModalSession(): boolean {
  return connectedProvider !== null
}

/**
 * End the modal's session, if that is what is connected.
 *
 * Only half the job: an injected wallet is disconnected by `chain.ts`, which is the only place that
 * knows about the extension. See `disconnect` there, which calls this one first.
 */
export async function disconnectModal(): Promise<void> {
  connectedProvider = null
  if (appKit === null) return
  const kit = await appKit
  await kit.disconnect('eip155')
}
