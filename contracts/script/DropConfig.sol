// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

/// @title DropConfig
/// @notice Per-chain addresses of the contracts cow-drop builds on.
/// @dev The CoW Protocol core and composable-cow contracts are CREATE2-deployed to the same address
///      on every chain, so these are constants rather than a per-chain table. See
///      https://github.com/cowprotocol/composable-cow/blob/main/networks.json
///
///      The wrapped native token is the one address that does differ per chain, and it is deliberately
///      absent: a table here would have to be extended for every new chain, and was already missing
///      Base. `ConvertSteps` reads it from CoW's ETH Flow instead, which answers per chain from one
///      address, and `TokenSteps.wrapNative` takes it as a step argument supplied by the recipe.
library DropConfig {
    address internal constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    address internal constant VAULT_RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;
    address internal constant COMPOSABLE_COW = 0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74;
    address internal constant TWAP_HANDLER = 0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5;
    address internal constant CURRENT_BLOCK_TIMESTAMP_FACTORY = 0x52eD56Da04309Aca4c3FECC595298d80C2f16BAc;
    address internal constant STOP_LOSS_HANDLER = 0x412c36e5011CD2517016D243a2dfB37f73A242E7;
}
