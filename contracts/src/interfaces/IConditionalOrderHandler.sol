// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";

/// @dev The handler side of composable-cow's `IConditionalOrderGenerator`, copied rather than
///      imported. `LibCowOrder.Data` has the same tuple as `GPv2Order.Data`, so the selectors — and
///      therefore the ERC-165 id ComposableCoW asks for — are the upstream ones.
interface IConditionalOrderHandler {
    /// @notice The order does not satisfy the handler.
    error OrderNotValid(string reason);

    /// @notice Tells a watch tower to stop polling this order.
    error PollNever(string reason);

    /// @notice Tells a watch tower to poll again on the next block.
    error PollTryNextBlock(string reason);

    /// @notice Reverts unless `order` is one the owner's conditional order allows.
    function verify(
        address owner,
        address sender,
        bytes32 hash,
        bytes32 domainSeparator,
        bytes32 ctx,
        bytes calldata staticInput,
        bytes calldata offchainInput,
        LibCowOrder.Data calldata order
    ) external view;

    /// @notice An order that would pass `verify` right now.
    function getTradeableOrder(
        address owner,
        address sender,
        bytes32 ctx,
        bytes calldata staticInput,
        bytes calldata offchainInput
    ) external view returns (LibCowOrder.Data memory);

    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}
