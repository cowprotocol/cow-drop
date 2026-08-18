// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

/// @title Orders
/// @notice Shared CoW Protocol order plumbing: the flag constants, order UID packing and the
///         limit-price arithmetic used by every recipe primitive.
/// @dev Order *hashing* is not reimplemented here — `cow-shed/LibCowOrder.sol` already carries
///      the canonical assembly implementation, and having two would be one too many.
library Orders {
    /// @notice Rounding to zero would produce an order with no minimum output.
    error LimitPriceTooLow();

    /// @notice `validTo` must fit in the uint32 the CoW order struct declares.
    error ValidToOverflow();

    bytes32 internal constant KIND_SELL = keccak256("sell");
    bytes32 internal constant KIND_BUY = keccak256("buy");
    bytes32 internal constant BALANCE_ERC20 = keccak256("erc20");

    /// @notice The 56-byte order UID the settlement contract keys pre-signatures and fills by.
    /// @dev `orderDigest ++ owner ++ validTo`, per GPv2Order.packOrderUidParams.
    function packUid(bytes32 orderDigest, address owner, uint32 validTo) internal pure returns (bytes memory) {
        return abi.encodePacked(orderDigest, owner, validTo);
    }

    /// @notice Apply a limit price expressed as the fraction `numerator / denominator`
    ///         (buy units per sell unit) to a sell amount.
    /// @dev Reverts rather than returning zero: a zero minimum output is an order that can be
    ///      filled for nothing, and a recipe is committed to an address, so there is no
    ///      opportunity to notice and fix it later.
    function applyLimitPrice(uint256 sellAmount, uint256 numerator, uint256 denominator)
        internal
        pure
        returns (uint256 buyAmount)
    {
        buyAmount = (sellAmount * numerator) / denominator;
        if (buyAmount == 0) revert LimitPriceTooLow();
    }

    /// @notice `block.timestamp + validitySeconds`, checked to fit a uint32.
    function deadline(uint256 validitySeconds) internal view returns (uint32) {
        uint256 validTo = block.timestamp + validitySeconds;
        if (validTo > type(uint32).max) revert ValidToOverflow();
        // casting to 'uint32' is safe because the bound is checked on the line above
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint32(validTo);
    }
}
