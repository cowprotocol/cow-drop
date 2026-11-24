// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";

import {DropExecutor} from "../DropExecutor.sol";
import {IConditionalOrderHandler} from "../interfaces/IConditionalOrderHandler.sol";
import {HookOrderBase} from "../lib/HookOrderBase.sol";
import {PaymentSteps} from "../steps/PaymentSteps.sol";

/// @title PaymentHandler
/// @notice A ComposableCoW handler for "pay me `buyAmount` of `buyToken`, in any token".
///
/// @dev `SellBalanceHandler` with the sell token left open. The recipe commits to what the receiver
///      gets and not to what is sold, so the order names the token: the drop's whole balance of it,
///      for at least `buyAmount`. Whoever posts the order picks which held token pays, and every
///      choice still pays the committed price, with any surplus going to the receiver.
///
///      The order's pre-hook is `PaymentSteps.activatePayment(owner, setupData, sellToken)`, which is
///      how the recipe's `HookPaymentSteps.approvePayment` step learns which token to approve. The
///      appData is rebuilt around that calldata, so an order cannot carry a hook that approves a
///      different token.
///
///      A payment made in `buyToken` itself has no order to place. It is forwarded by activating
///      with that token, which takes a transaction.
contract PaymentHandler is HookOrderBase {
    /// @dev `staticInput`. Must not mention the drop, which is derived from it.
    struct Data {
        address buyToken;
        /// @dev The price: the least the receiver gets, whatever is sold.
        uint256 buyAmount;
        address receiver;
        /// @dev The furthest `validTo` may sit from the block the order settles in.
        uint256 validitySeconds;
        /// @dev The order's appData when `appDataPrefix` is empty. Ignored otherwise.
        bytes32 appData;
        bytes appDataPrefix;
        bytes appDataSuffix;
    }

    constructor(DropExecutor executor) HookOrderBase(executor) {}

    /// @inheritdoc IConditionalOrderHandler
    /// @dev `sender` is ignored: by the time a check reaches here through `DropExecutor` it is the
    ///      drop, not the settlement contract.
    function verify(
        address owner,
        address,
        bytes32 hash,
        bytes32 domainSeparator,
        bytes32,
        bytes calldata staticInput,
        bytes calldata offchainInput,
        LibCowOrder.Data calldata order
    ) external view override {
        Data memory data = abi.decode(staticInput, (Data));
        address sellToken = address(order.sellToken);
        if (sellToken == data.buyToken) revert OrderNotValid("already the buy token");

        _wholeBalance(owner, sellToken, order);
        _check(
            owner,
            hash,
            domainSeparator,
            order,
            Terms({
                sellToken: sellToken,
                buyToken: data.buyToken,
                receiver: data.receiver,
                minBuyAmount: data.buyAmount,
                validitySeconds: data.validitySeconds,
                appData: data.appData,
                appDataPrefix: data.appDataPrefix,
                appDataSuffix: data.appDataSuffix
            }),
            offchainInput
        );
    }

    /// @inheritdoc IConditionalOrderHandler
    /// @dev Never answers: which token to sell is the poster's choice, so there is no one order to return.
    function getTradeableOrder(address, address, bytes32, bytes calldata, bytes calldata)
        external
        pure
        override
        returns (LibCowOrder.Data memory)
    {
        revert PollNever("the poster chooses the sell token");
    }

    /// @inheritdoc HookOrderBase
    /// @dev Names the token, or the drop would approve a different one from the order's.
    function _hook(address shedOwner, bytes memory setupData, address sellToken)
        internal
        pure
        override
        returns (bytes memory)
    {
        return abi.encodeCall(PaymentSteps.activatePayment, (shedOwner, setupData, sellToken));
    }
}
