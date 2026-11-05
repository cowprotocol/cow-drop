import { describe, expect, it } from 'vitest'
import { keccak256, toBytes } from 'viem'

import {
  COW_DROP_APP_CODE,
  COW_DROP_APP_DATA,
  COW_DROP_APP_DATA_DOCUMENT,
  knownAppDataDocument,
} from './appData.js'
import { swapOnArrival } from './templates.js'

const OWNER = '0x1111111111111111111111111111111111111111'
const WXDAI = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d'
const COW = '0x177127622c4A00F3d409B75571e12cB3c8973d3c'

describe('cow-drop appData', () => {
  it('hashes the exact document the order book will be given', () => {
    expect(COW_DROP_APP_DATA).toBe(keccak256(toBytes(COW_DROP_APP_DATA_DOCUMENT)))
  })

  it('is valid appData JSON carrying the app code', () => {
    expect(JSON.parse(COW_DROP_APP_DATA_DOCUMENT)).toMatchObject({ appCode: COW_DROP_APP_CODE })
  })

  it('resolves its own hash and nothing else', () => {
    expect(knownAppDataDocument(COW_DROP_APP_DATA)).toBe(COW_DROP_APP_DATA_DOCUMENT)
    expect(knownAppDataDocument(`0x${'00'.repeat(32)}`)).toBeUndefined()
  })

  it('is what a template puts on an order', () => {
    const recipe = swapOnArrival({
      chainId: 100,
      owner: OWNER,
      sellToken: WXDAI,
      buyToken: COW,
      limitPrice: { price: '40', sellDecimals: 18, buyDecimals: 18 },
    })

    expect(recipe.steps[0]).toMatchObject({ appData: COW_DROP_APP_DATA })
  })

  it('still lets a caller choose their own', () => {
    const mine = `0x${'ab'.repeat(32)}` as const
    const recipe = swapOnArrival({
      chainId: 100,
      owner: OWNER,
      sellToken: WXDAI,
      buyToken: COW,
      limitPrice: { price: '40', sellDecimals: 18, buyDecimals: 18 },
      appData: mine,
    })

    expect(recipe.steps[0]).toMatchObject({ appData: mine })
  })
})
