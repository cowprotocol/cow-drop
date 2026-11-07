import { useMemo } from 'react'
import type { Address } from 'viem'

import type { TokenInfo } from '../lib/tokenList.js'
import { findToken } from '../lib/tokenList.js'
import { Select, type SelectOption } from './Select.js'
import { TokenLogo } from './TokenLogo.js'

/** Token selector: the shared dropdown, with logos and a filter over symbol, name and address. */
export function TokenPicker({
  label,
  tokens,
  value,
  chainId,
  onChange,
}: {
  label: string
  tokens: TokenInfo[]
  value: Address
  chainId: number
  onChange: (address: Address) => void
}) {
  const options = useMemo<SelectOption<Address>[]>(
    () =>
      tokens.map((token) => ({
        value: token.address,
        label: token.symbol,
        description: token.name,
        keywords: token.address,
        icon: <TokenLogo token={token} chainId={chainId} />,
      })),
    [tokens, chainId],
  )

  /*
   * Resolved through the list rather than passed straight down. Token lists disagree with each other
   * about checksum casing, and a recipe carries whatever casing it was written with — so comparing the
   * raw string against the option would leave the right token unmarked and the trigger blank.
   */
  const current = findToken(tokens, value)?.address ?? value

  return (
    <Select
      className="token-picker"
      label={label}
      value={current}
      options={options}
      onChange={onChange}
      searchable
      filterPlaceholder="Symbol, name or address"
      placeholder="Select a token"
      emptyText="No token matches"
    />
  )
}
