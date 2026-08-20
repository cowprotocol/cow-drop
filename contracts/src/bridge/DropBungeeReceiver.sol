// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {DropExecutor} from "../DropExecutor.sol";
import {IBungeeExecutor} from "../interfaces/IBungeeExecutor.sol";
import {DropDelivery} from "./DropDelivery.sol";

/// @title DropBungeeReceiver
/// @notice Bungee's destination payload, delivered into a drop.
///
/// @dev The whole contract is the ABI translation: Bungee's `executeData` shape in, `DropDelivery`'s
///      `(owner, setupData, onFailure)` payload out. Everything with a decision in it lives in the
///      base — see `DropDelivery` for why a receiver is a separate contract from `DropExecutor`, and
///      for what happens when a recipe declines to run.
///
///      One contract per bridge ABI, rather than one contract answering to several. A receiver's
///      address is what a bridge route is quoted against, and folding a second bridge's entry point
///      in here would change this contract's code and therefore its address — retiring routes that
///      have nothing to do with the change. Adding `DropAcrossReceiver` later must cost this address
///      nothing.
///
///      Modelled on `OrderFlowFactory.executeData` in `cowprotocol/bridge-and-swap`, which does the
///      same job for a contract that commits to exactly one order. The mapping is direct:
///      `getOrderFlowAddress` is `DropExecutor.dropOf`, and `triggerOrderCreation` is
///      `DropExecutor.activate`.
contract DropBungeeReceiver is DropDelivery, IBungeeExecutor {
    constructor(DropExecutor executor) DropDelivery(executor) {}

    /// @inheritdoc IBungeeExecutor
    ///
    /// @dev `requestHash` and `amounts` are both ignored, deliberately.
    ///
    ///      `amounts` because `_forward` moves the balance actually held rather than the balance
    ///      claimed — see there for why that is the safer of the two. `tokens` is still read, as the
    ///      list of which balances to look at.
    ///
    ///      `requestHash` because there is nothing here to correlate it against. This contract holds
    ///      no per-request state: the payload names the drop, the drop's address is the authorization,
    ///      and a delivery that arrives twice is a second funding of a re-triggerable address rather
    ///      than a replay to defend against. Bungee's own event carries the hash for anyone tracking
    ///      the bridge leg off-chain.
    function executeData(bytes32, uint256[] calldata, address[] calldata tokens, bytes memory callData)
        external
        payable
        override
    {
        _deliver(callData, tokens);
    }
}
