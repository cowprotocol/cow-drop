import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeFunctionData, encodeAbiParameters, getAddress, keccak256, toBytes, type Address, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'

import { describeRecipe, hasWarnings } from './describe.js'
import { TOKEN_STEPS_ABI } from './generated/artifacts.js'
import { getDeployment } from './generated/deployments.js'
import {
  COW_VAULT_RELAYER,
  buildHookOrder,
  buildHookPaymentOrder,
  encodeHookPaymentData,
  findHookPayment,
  decodeSellBalanceData,
  encodeHookSignature,
  encodeSellBalanceData,
  findSellBalanceOrders,
  hookAppDataDocument,
  type SellBalanceData,
} from './hookOrder.js'
import { cowDomainSeparator, orderUidFor } from './orderUid.js'
import { compileRecipe } from './recipe.js'
import { paymentRequest, swapOnArrival } from './templates.js'
import { buildActivatePaymentTx, buildActivateTx } from './tx.js'

interface HookFixture {
  name: string
  executor: Address
  owner: Address
  setupData: Hex
  drop: Address
  appDataPrefix: string
  appDataSuffix: string
  staticInput: Hex
  offchainInput: Hex
  timestamp: number
  balance: string
  order: Record<string, string | number | boolean>
}

const here = dirname(fileURLToPath(import.meta.url))
const fixtures: {
  hookOrders: HookFixture[]
  hookPayments: (HookFixture & { hookTarget: Address })[]
} = JSON.parse(
  readFileSync(resolve(here, '../../../contracts/deployments/derivation-fixtures.json'), 'utf8'),
)

const OWNER: Address = '0x1111111111111111111111111111111111111111'
const WXDAI: Address = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d'
const COW: Address = '0x177127622c4A00F3d409B75571e12cB3c8973d3c'
const NOW = 1_800_000_000

/** The inputs `Fixtures.s.sol` feeds the handler, restated here so the encoding is what is compared. */
function fixtureData(fixture: HookFixture): SellBalanceData {
  const templated = fixture.appDataPrefix.length > 0
  return {
    sellToken: getAddress('0x0000000000000000000000000000000000005e11'),
    buyToken: getAddress('0x000000000000000000000000000000000000b111'),
    receiver: getAddress('0x000000000000000000000000000000000000beef'),
    limitPrice: { numerator: 95n, denominator: 100n },
    validitySeconds: 1800n,
    strict: false,
    appData: keccak256(toBytes('appData')),
    appDataTemplate: { prefix: fixture.appDataPrefix, suffix: fixture.appDataSuffix },
  }
}

/**
 * An order posted before activation is built here and checked by `SellBalanceHandler`. The fixtures
 * come from the compiled handler, so a drift in any of the three encodings fails here rather than as
 * an order the drop refuses to sign.
 */
describe('hook orders match the contract', () => {
  for (const fixture of fixtures.hookOrders) {
    describe(fixture.name, () => {
      const data = fixtureData(fixture)

      it('encodes the static input the handler decodes', () => {
        expect(encodeSellBalanceData(data)).toBe(fixture.staticInput)
        expect(decodeSellBalanceData(fixture.staticInput)).toEqual(data)
      })

      it('carries the recipe as the offchain input the handler decodes', () => {
        const signature = encodeHookSignature(
          {
            sellToken: data.sellToken,
            buyToken: data.buyToken,
            receiver: data.receiver,
            sellAmount: BigInt(fixture.balance),
            buyAmount: BigInt(fixture.order.buyAmount as string),
            validTo: Number(fixture.order.validTo),
            appData: fixture.order.appData as Hex,
            feeAmount: 0n,
            kind: fixture.order.kind as Hex,
            partiallyFillable: false,
            sellTokenBalance: fixture.order.sellTokenBalance as Hex,
            buyTokenBalance: fixture.order.buyTokenBalance as Hex,
          },
          { handler: OWNER, salt: `0x${'00'.repeat(32)}`, staticInput: fixture.staticInput },
          { owner: fixture.owner, setupData: fixture.setupData },
        )
        expect(signature).toContain(fixture.offchainInput.slice(2))
      })

      if (fixture.appDataPrefix.length > 0) {
        it('builds the document the handler hashes', () => {
          const document = hookAppDataDocument(data.appDataTemplate, {
            deployment: { executor: fixture.executor },
            owner: fixture.owner,
            setupData: fixture.setupData,
          })
          expect(keccak256(toBytes(document))).toBe(fixture.order.appData)
        })
      }

      it('prices the balance the way the handler does', () => {
        expect((BigInt(fixture.balance) * 95n) / 100n).toBe(BigInt(fixture.order.buyAmount as string))
      })
    })
  }
})

describe('sellBalanceViaHook', () => {
  const json = swapOnArrival({
    chainId: 100,
    owner: OWNER,
    sellToken: WXDAI,
    buyToken: COW,
    limitPrice: { numerator: '95', denominator: '100' },
    activation: 'hook',
  })
  const compiled = compileRecipe(json)
  const { deployment } = compiled

  it('compiles to an approval as the drop and a plain registration', () => {
    const [approve, register] = compiled.recipe.calls

    expect(approve!.target).toBe(deployment.tokenSteps)
    expect(approve!.isDelegateCall).toBe(true)
    expect(decodeFunctionData({ abi: TOKEN_STEPS_ABI, data: approve!.callData }).args).toEqual([
      WXDAI,
      COW_VAULT_RELAYER,
    ])

    expect(register!.target).toBe(deployment.composableCow)
    expect(register!.isDelegateCall).toBe(false)

    const [found] = findSellBalanceOrders(deployment, compiled.setupData)
    expect(found!.params.handler).toBe(deployment.sellBalanceHandler)
    expect(found!.data.receiver).toBe(OWNER)
    expect(found!.data.validitySeconds).toBe(1800n)
  })

  it('reads as a recipe with nothing to warn about', () => {
    const described = describeRecipe(compiled.setupData, deployment)
    expect(described.steps.map((step) => step.known?.contract)).toEqual(['TokenSteps', 'ComposableCoW'])
    expect(hasWarnings(described)).toBe(false)
  })

  it('is refused on a generation without the handler', () => {
    expect(() => compileRecipe({ ...json, generation: 1 })).toThrow(/SellBalanceHandler/)
  })

  it('is refused together with an oracle limit', () => {
    expect(() =>
      swapOnArrival({
        chainId: 100,
        owner: OWNER,
        sellToken: WXDAI,
        buyToken: COW,
        limitPrice: { numerator: '95', denominator: '100' },
        activation: 'hook',
        oracle: { sellTokenPriceOracle: OWNER, buyTokenPriceOracle: OWNER },
      }),
    ).toThrow(/oracle/)
  })
})

describe('buildHookOrder', () => {
  const compiled = compileRecipe(
    swapOnArrival({
      chainId: 100,
      owner: OWNER,
      sellToken: WXDAI,
      buyToken: COW,
      limitPrice: { numerator: '95', denominator: '100' },
      activation: 'hook',
    }),
  )
  const { deployment, setupData } = compiled
  const built = buildHookOrder({ deployment, owner: OWNER, setupData, balance: 10n ** 19n, now: NOW })

  it('sells the whole balance at the committed limit, from the drop', () => {
    expect(built.drop).toBe(compiled.address)
    expect(built.payload).toMatchObject({
      sellToken: WXDAI,
      buyToken: COW,
      receiver: OWNER,
      sellAmount: (10n ** 19n).toString(),
      buyAmount: ((10n ** 19n * 95n) / 100n).toString(),
      feeAmount: '0',
      kind: 'sell',
      partiallyFillable: false,
      signingScheme: 'eip1271',
      from: compiled.address,
    })
  })

  it('stops short of the furthest deadline the handler allows', () => {
    expect(built.order.validTo).toBe(NOW + 1800 - 60)
  })

  it('carries the activation as the only pre-hook of its appData', () => {
    const document = JSON.parse(built.appDataDocument!)
    expect(document.metadata.hooks.pre).toEqual([
      {
        callData: buildActivateTx({ deployment, owner: OWNER, setupData }).data,
        gasLimit: '800000',
        target: deployment.executor,
      },
    ])
    expect(built.order.appData).toBe(keccak256(toBytes(built.appDataDocument!)))
  })

  it('computes the uid the settlement contract will key the fill by', () => {
    expect(built.orderUid).toBe(
      orderUidFor(built.order, compiled.address, cowDomainSeparator(100, deployment.settlement)),
    )
  })

  it('signs with the recipe, so the handler can rebuild the appData', () => {
    const offchainInput = encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], [OWNER, setupData])
    expect(built.signature).toContain(offchainInput.slice(2))
  })

  it('refuses an empty drop and a recipe with nothing to post', () => {
    expect(() => buildHookOrder({ deployment, owner: OWNER, setupData, balance: 0n, now: NOW })).toThrow(
      /nothing to sell/,
    )

    const presigned = compileRecipe(
      swapOnArrival({
        chainId: 100,
        owner: OWNER,
        sellToken: WXDAI,
        buyToken: COW,
        limitPrice: { numerator: '95', denominator: '100' },
      }),
    )
    expect(() =>
      buildHookOrder({ deployment, owner: OWNER, setupData: presigned.setupData, balance: 1n, now: NOW }),
    ).toThrow(/no SellBalanceHandler order/)
  })

  it('uses the latest generation, which is the one with the handler', () => {
    expect(getDeployment(100).sellBalanceHandler).toBe(deployment.sellBalanceHandler)
  })
})

/** The any-token handler: same three encodings, with the sell token inside the hook as well. */
describe('hook payments match the contract', () => {
  for (const fixture of fixtures.hookPayments) {
    const template = { prefix: fixture.appDataPrefix, suffix: fixture.appDataSuffix }

    it(`${fixture.name}: encodes the static input the handler decodes`, () => {
      expect(
        encodeHookPaymentData({
          buyToken: getAddress('0x000000000000000000000000000000000000b111'),
          buyAmount: 100n * 10n ** 18n,
          receiver: getAddress('0x000000000000000000000000000000000000beef'),
          validitySeconds: 1800n,
          appData: `0x${'00'.repeat(32)}`,
          appDataTemplate: template,
        }),
      ).toBe(fixture.staticInput)
    })

    it(`${fixture.name}: builds the document the handler accepted`, () => {
      const document = hookAppDataDocument(template, {
        deployment: { executor: fixture.executor, paymentSteps: fixture.hookTarget },
        owner: fixture.owner,
        setupData: fixture.setupData,
        sellToken: getAddress(fixture.order.sellToken as string),
      })
      expect(keccak256(toBytes(document))).toBe(fixture.order.appData)
    })
  }
})

describe('paymentViaHook', () => {
  const compiled = compileRecipe(
    paymentRequest({ chainId: 100, owner: OWNER, buyToken: COW, buyAmount: 100n * 10n ** 18n, activation: 'hook' }),
  )
  const { deployment, setupData } = compiled

  it('compiles to an approval step and a plain registration, naming no sell token', () => {
    const [approve, register] = compiled.recipe.calls
    expect(approve!.target).toBe(deployment.hookPaymentSteps)
    expect(approve!.isDelegateCall).toBe(true)
    expect(register!.target).toBe(deployment.composableCow)

    const found = findHookPayment(deployment, setupData)!
    expect(found.params.handler).toBe(deployment.paymentHandler)
    expect(found.data).toMatchObject({ buyToken: COW, buyAmount: 100n * 10n ** 18n, receiver: OWNER })
    expect(setupData.toLowerCase()).not.toContain(WXDAI.slice(2).toLowerCase())
  })

  it('reads as a recipe with nothing to warn about', () => {
    const described = describeRecipe(setupData, deployment)
    expect(described.steps.map((step) => step.known?.contract)).toEqual(['HookPaymentSteps', 'ComposableCoW'])
    expect(hasWarnings(described)).toBe(false)
  })

  it('builds an order in whichever token paid, with a hook that names it', () => {
    const built = buildHookPaymentOrder({
      deployment,
      owner: OWNER,
      setupData,
      sellToken: WXDAI,
      balance: 10n ** 21n,
      now: NOW,
    })

    expect(built.payload).toMatchObject({
      sellToken: WXDAI,
      buyToken: COW,
      receiver: OWNER,
      sellAmount: (10n ** 21n).toString(),
      buyAmount: (100n * 10n ** 18n).toString(),
      signingScheme: 'eip1271',
      from: compiled.address,
    })
    expect(JSON.parse(built.appDataDocument!).metadata.hooks.pre).toEqual([
      {
        callData: buildActivatePaymentTx({ deployment, owner: OWNER, setupData, sellToken: WXDAI }).data,
        gasLimit: '800000',
        target: deployment.paymentSteps,
      },
    ])
  })

  it('refuses an order for a payment already in the buy token', () => {
    expect(() =>
      buildHookPaymentOrder({ deployment, owner: OWNER, setupData, sellToken: COW, balance: 1n, now: NOW }),
    ).toThrow(/needs no order/)
  })

  it('cannot share a recipe with another order step', () => {
    const json = paymentRequest({ chainId: 100, owner: OWNER, buyToken: COW, buyAmount: 1n, activation: 'hook' })
    expect(() =>
      compileRecipe({
        ...json,
        steps: [
          ...json.steps,
          {
            type: 'sellBalanceViaHook',
            sellToken: WXDAI,
            buyToken: COW,
            limitPrice: { numerator: '1', denominator: '1' },
            validitySeconds: 1800,
          },
        ],
      }),
    ).toThrow(/cannot share a recipe/)
  })
})
