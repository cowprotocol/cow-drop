// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

/// @notice The drop holds none of the token the step wants to move.
///
/// @dev Declared at file level rather than on a contract so every step contract in `steps/` raises
///      the *same* selector. All of them read `address(this)`'s balance at activation, so "nothing
///      arrived" is the one failure they have in common, and a caller decoding a reverted activation
///      should not have to know which step contract produced it to recognise the commonest cause.
error NothingToSell();
