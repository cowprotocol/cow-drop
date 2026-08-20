import { describe, expect, it } from 'vitest'

import { deliveryCapability, destinationExecutionOf, observedBridges } from './capability.js'

describe('the destination-execution registry', () => {
  it('records that the Gnosis native bridge cannot reach our receiver at all', () => {
    const execution = destinationExecutionOf('gnosis-native-bridge')

    expect(execution.status).toBe('broken')
    // The reason names both selectors, because "it did not work" is not a reason anyone can act on.
    expect(execution.status === 'broken' ? execution.reason : '').toMatch(/onTokenBridged/)
    expect(execution.status === 'broken' ? execution.reason : '').toMatch(/executeData/)
  })

  it('records that Symbiosis quotes a payload and then ignores it', () => {
    expect(destinationExecutionOf('symbiosis').status).toBe('broken')
  })

  /**
   * The regression guard on the old allowlist. These two were listed as payload-executing on faith and
   * never once watched. They must not read as available merely because somebody used to believe they
   * were.
   */
  it('does not treat the bridges from the old allowlist as observed', () => {
    for (const name of ['across', 'cctp']) {
      const execution = destinationExecutionOf(name)
      expect(execution.status).toBe('unobserved')
      expect(execution.status === 'unobserved' ? execution.reason : '').toMatch(/on faith/)
    }
  })

  /**
   * Asserted as the intended state, not as an accident of an empty table. Atomic delivery is off
   * because nothing has earned it, and the only thing that changes this is an `observed` entry with a
   * transaction behind it.
   */
  it('has nothing observed, so atomic delivery is unavailable', () => {
    expect(observedBridges()).toEqual([])
    expect(deliveryCapability().atomicAvailable).toBe(false)
  })

  it('lists every verdict it knows, so a UI can explain a fully disabled list', () => {
    const known = deliveryCapability().known.map((entry) => entry.name)

    expect(known).toContain('gnosis-native-bridge')
    expect(known).toContain('symbiosis')
    expect(known).toContain('across')
    expect(known).toContain('cctp')
  })

  /** Fail-closed. An unknown bridge is refused, never permitted. */
  it('refuses a bridge it has never heard of', () => {
    const execution = destinationExecutionOf('some-new-bridge')

    expect(execution.status).toBe('unobserved')
    expect(execution.status === 'unobserved' ? execution.reason : '').toMatch(/not in the destination-execution/)
  })

  /**
   * `routeDetails.name` is display-cased while `includeBridges` takes slugs, and the old code never
   * compared the two — so this mismatch was invisible until a verdict started depending on the name.
   */
  it('resolves the spellings a route actually arrives with', () => {
    for (const spelling of ['Across', 'across', ' ACROSS ', 'across_v3', 'Across V3']) {
      expect(destinationExecutionOf(spelling).status).toBe('unobserved')
    }
    for (const spelling of ['Gnosis Native Bridge', 'gnosis_native_bridge', 'Gnosis Bridge']) {
      expect(destinationExecutionOf(spelling).status).toBe('broken')
    }
  })

  it('honours an override at the point of use, not only in the summary', () => {
    const overrides = {
      across: {
        status: 'observed' as const,
        evidence: {
          chainId: 100,
          txHash: `0x${'11'.repeat(32)}` as const,
          url: 'https://example.invalid/tx',
          observedOn: '2026-01-01',
        },
      },
    }

    // Both readings of the same table have to agree. If only the summary honoured an override, a
    // bridge could be advertised as available and then refused at the moment it was used.
    expect(deliveryCapability(overrides).atomicAvailable).toBe(true)
    expect(destinationExecutionOf('Across', overrides).status).toBe('observed')
  })

  /**
   * A machine-checkable bar on the promotion discipline. The registry is only as strong as the
   * evidence it demands, and "just add across, it obviously works" is the pressure this resists.
   */
  it('requires real evidence behind every observed entry', () => {
    for (const { name, execution } of deliveryCapability().known) {
      if (execution.status !== 'observed') continue

      expect(execution.evidence.txHash, `${name} needs a transaction hash`).toMatch(/^0x[0-9a-fA-F]{64}$/)
      expect(Number.isNaN(Date.parse(execution.evidence.observedOn)), `${name} needs a date`).toBe(false)
      expect(execution.evidence.chainId, `${name} needs a chain`).toBeGreaterThan(0)
    }
  })
})
