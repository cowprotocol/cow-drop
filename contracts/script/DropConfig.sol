// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

/// @title DropConfig
/// @notice Per-chain addresses of the contracts cow-drop builds on.
/// @dev The CoW Protocol core and composable-cow contracts are CREATE2-deployed to the same
///      address on every chain; only the wrapped native token differs. See
///      https://github.com/cowprotocol/composable-cow/blob/main/networks.json
library DropConfig {
    error UnsupportedChain(uint256 chainId);

    uint256 internal constant MAINNET = 1;
    uint256 internal constant GNOSIS = 100;
    uint256 internal constant ARBITRUM_ONE = 42161;
    uint256 internal constant SEPOLIA = 11155111;

    address internal constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    address internal constant VAULT_RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;
    address internal constant COMPOSABLE_COW = 0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74;
    address internal constant TWAP_HANDLER = 0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5;
    address internal constant CURRENT_BLOCK_TIMESTAMP_FACTORY = 0x52eD56Da04309Aca4c3FECC595298d80C2f16BAc;

    function wrappedNative(uint256 chainId) internal pure returns (address) {
        if (chainId == GNOSIS) return 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d; // WXDAI
        if (chainId == MAINNET) return 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2; // WETH
        if (chainId == ARBITRUM_ONE) return 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1; // WETH
        if (chainId == SEPOLIA) return 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14; // WETH
        revert UnsupportedChain(chainId);
    }
}
