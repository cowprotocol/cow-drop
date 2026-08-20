// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

/// @title IBungeeExecutor
/// @notice The destination-side callback Bungee delivers a payload through.
///
/// @dev The bridge transfers the tokens to the implementing contract and then calls `executeData`,
///      both in the same transaction. That atomicity is what the receivers in `src/bridge/` are
///      built on: reverting rolls the transfer back too, so a rejected delivery leaves nothing
///      stranded at the receiver.
///
///      Transcribed from `cowprotocol/bridge-and-swap`, deliberately unchanged — `callData` is
///      `bytes memory` there and stays `bytes memory` here. The declaration has to keep matching the
///      one the bridge encodes against, and a signature this project invented would be a signature
///      no relayer calls.
interface IBungeeExecutor {
    function executeData(
        bytes32 requestHash,
        uint256[] calldata amounts,
        address[] calldata tokens,
        bytes memory callData
    ) external payable;
}
