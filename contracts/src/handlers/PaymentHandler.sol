// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {LibString} from "solady/utils/LibString.sol";

import {DropExecutor} from "../DropExecutor.sol";
import {IConditionalOrderHandler} from "../interfaces/IConditionalOrderHandler.sol";
import {IERC20Like} from "../interfaces/IDropExternal.sol";
import {Orders} from "../lib/Orders.sol";
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
///      appData is rebuilt around that calldata, sell token included, as `SellBalanceHandler` does.
///
///      A payment made in `buyToken` itself has no order to place. It is forwarded by activating
///      with that token, which takes a transaction.
contract PaymentHandler is IConditionalOrderHandler {
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

    DropExecutor public immutable EXECUTOR;

    constructor(DropExecutor executor) {
        EXECUTOR = executor;
    }

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

        if (LibCowOrder.hash(order, domainSeparator) != hash) revert OrderNotValid("invalid hash");
        if (address(order.buyToken) != data.buyToken) revert OrderNotValid("buy token");
        if (sellToken == data.buyToken) revert OrderNotValid("already the buy token");
        if (order.receiver != data.receiver) revert OrderNotValid("receiver");
        if (order.kind != Orders.KIND_SELL) revert OrderNotValid("not a sell order");
        if (order.partiallyFillable) revert OrderNotValid("partially fillable");
        if (order.feeAmount != 0) revert OrderNotValid("fee");
        if (order.sellTokenBalance != Orders.BALANCE_ERC20) revert OrderNotValid("sell token balance");
        // gitleaks:allow (balance-kind constant, not a secret)
        if (order.buyTokenBalance != Orders.BALANCE_ERC20) revert OrderNotValid("buy token balance");

        uint256 balance = IERC20Like(sellToken).balanceOf(owner);
        if (balance == 0 || order.sellAmount != balance) revert OrderNotValid("not the whole balance");

        if (data.buyAmount == 0 || order.buyAmount < data.buyAmount) revert OrderNotValid("below the price");
        if (order.validTo > block.timestamp + data.validitySeconds) revert OrderNotValid("valid for too long");
        if (order.appData != _appData(owner, sellToken, data, offchainInput)) revert OrderNotValid("appData");
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

    /// @inheritdoc IConditionalOrderHandler
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == this.getTradeableOrder.selector || interfaceId == this.supportsInterface.selector;
    }

    /// @notice The appData hash an order selling `sellToken` for `owner` must carry.
    /// @param offchainInput `abi.encode(address shedOwner, bytes setupData)`: the recipe `owner` is
    ///        the drop of. Unused when the appData is fixed.
    function _appData(address owner, address sellToken, Data memory data, bytes calldata offchainInput)
        internal
        view
        returns (bytes32)
    {
        if (data.appDataPrefix.length == 0) return data.appData;
        if (offchainInput.length == 0) revert OrderNotValid("appData needs the recipe as offchain input");

        (address shedOwner, bytes memory setupData) = abi.decode(offchainInput, (address, bytes));
        if (EXECUTOR.dropOf(shedOwner, setupData) != owner) revert OrderNotValid("not this drop's recipe");

        // The hook must name the token this order sells, or the drop approves a different one.
        bytes memory hook = abi.encodeCall(PaymentSteps.activatePayment, (shedOwner, setupData, sellToken));
        return keccak256(abi.encodePacked(data.appDataPrefix, LibString.toHexStringNoPrefix(hook), data.appDataSuffix));
    }
}
