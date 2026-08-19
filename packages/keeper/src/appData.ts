import { keccak256, toHex, type Address, type Hex } from 'viem'

/** A partner fee the keeper can count on before the order fills. */
export interface VerifiedFee {
  /** Basis points of volume. The protocol caps this at 100 (1%). */
  volumeBps: number
  recipient: Address
  /** The committed hash this fee was found under. */
  appData: Hex
}

export type AppDataProblem =
  /** The document does not hash to what the recipe committed to. */
  | { error: 'hash-mismatch'; expected: Hex; actual: Hex }
  | { error: 'not-json' }
  /** No `partnerFee` at all, or none naming the recipient we require. */
  | { error: 'no-fee-for-recipient'; recipient: Address }
  /**
   * A fee that only pays out of surplus or price improvement. Real revenue, but not *predictable*
   * revenue — see `feeFor`.
   */
  | { error: 'fee-not-volume-based' }

/**
 * Check that an appData document really is the one a recipe committed to.
 *
 * ## Hash the string, never a re-serialisation
 *
 * The appData hash is `keccak256` of the exact UTF-8 bytes of the document, and JSON has many
 * spellings of the same object — key order, whitespace, unicode escapes. So the keeper hashes the
 * **string it was given, verbatim**, and never parses-and-restringifies before hashing. Anything else
 * would reject documents that are perfectly valid and, worse, could accept one that is not.
 *
 * This is also why the keeper does not need the SDK's `getAppDataInfo`: that helper exists to
 * *produce* a canonical document, and we are only ever *verifying* one. If the bytes we were handed
 * hash to the committed value, those bytes are by definition the pre-image — whatever scheme produced
 * them.
 */
export function appDataHash(document: string): Hex {
  return keccak256(toHex(document))
}

/**
 * The fee this document promises `recipient`, if any.
 *
 * @param document The full appData JSON, exactly as it will be uploaded to the order book.
 * @param committed The `appData` hash the recipe committed to.
 */
export function feeFor(document: string, committed: Hex, recipient: Address): VerifiedFee | AppDataProblem {
  const actual = appDataHash(document)
  if (actual.toLowerCase() !== committed.toLowerCase()) {
    return { error: 'hash-mismatch', expected: committed, actual }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(document)
  } catch {
    return { error: 'not-json' }
  }

  const partnerFee = (parsed as { metadata?: { partnerFee?: unknown } })?.metadata?.partnerFee
  if (partnerFee === undefined) return { error: 'no-fee-for-recipient', recipient }

  // The schema allows one fee or an array of them.
  const fees = Array.isArray(partnerFee) ? partnerFee : [partnerFee]
  const mine = fees.filter(
    (fee): fee is Record<string, unknown> =>
      typeof fee === 'object' &&
      fee !== null &&
      typeof (fee as { recipient?: unknown }).recipient === 'string' &&
      (fee as { recipient: string }).recipient.toLowerCase() === recipient.toLowerCase(),
  )

  if (mine.length === 0) return { error: 'no-fee-for-recipient', recipient }

  // Only `volumeBps` is knowable before the order fills. `surplusBps` and `priceImprovementBps` are
  // real revenue but their *guaranteed* value is zero — a fill with no surplus pays nothing — so
  // counting them would be subsidising against income that may never arrive.
  const volume = mine.find((fee) => typeof fee['volumeBps'] === 'number')
  if (!volume) return { error: 'fee-not-volume-based' }

  return {
    volumeBps: volume['volumeBps'] as number,
    recipient: recipient.toLowerCase() as Address,
    appData: committed,
  }
}

export function isProblem(result: VerifiedFee | AppDataProblem): result is AppDataProblem {
  return 'error' in result
}

/**
 * Pair each supplied document with the committed hash it belongs to.
 *
 * A document matching nothing the recipe committed to is returned rather than ignored: it means the
 * client and the recipe disagree about what will be posted, and quietly dropping it would leave the
 * order unpostable later for a reason nobody could trace back to here.
 */
export function matchDocuments(
  committed: readonly Hex[],
  documents: readonly string[],
): { matched: Record<Hex, string>; unmatched: { document: string; hash: Hex }[] } {
  const matched: Record<Hex, string> = {}
  const unmatched: { document: string; hash: Hex }[] = []

  for (const document of documents) {
    const hash = appDataHash(document)
    const found = committed.find((candidate) => candidate.toLowerCase() === hash.toLowerCase())
    if (found) matched[found] = document
    else unmatched.push({ document, hash })
  }

  return { matched, unmatched }
}
