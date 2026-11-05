import { keccak256, toBytes, type Hex } from 'viem'

/**
 * The appData every drop's orders carry, so CoW can attribute them.
 *
 * A string literal rather than a serialised object: the order book files the document under
 * `keccak256(document)` and rejects an upload that does not hash to its key, so the bytes uploaded
 * and the bytes hashed must be the same bytes, with no JSON encoder in between.
 */
export const COW_DROP_APP_CODE = 'cow-drop'

export const COW_DROP_APP_DATA_DOCUMENT = `{"appCode":"${COW_DROP_APP_CODE}","metadata":{},"version":"1.1.0"}`

export const COW_DROP_APP_DATA: Hex = keccak256(toBytes(COW_DROP_APP_DATA_DOCUMENT))

/** Shaped for the watch tower's `AppDataResolver`, for a tower with no keeper behind it. */
export function knownAppDataDocument(hash: Hex): string | undefined {
  return hash.toLowerCase() === COW_DROP_APP_DATA.toLowerCase() ? COW_DROP_APP_DATA_DOCUMENT : undefined
}
