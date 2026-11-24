// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {LibString} from "solady/utils/LibString.sol";

import {DropExecutor} from "../DropExecutor.sol";
import {IConditionalOrderHandler} from "../interfaces/IConditionalOrderHandler.sol";
import {IERC20Like} from "../interfaces/IDropExternal.sol";
import {Orders} from "../lib/Orders.sol";

/// @title SellBalanceHandler
/// @notice A ComposableCoW handler for "sell my whole balance of X for Y, at no worse than this price".
///
/// @dev The order is checked when it settles rather than fixed when the drop is activated, which is
///      what lets it be posted *before* activation: the amount and deadline are chosen off-chain, and
///      a pre-hook in the order's appData activates the drop inside the settlement that fills it.
///
///      ## Binding the appData
///
///      The hook carries the recipe, so the appData depends on the recipe and the recipe cannot
///      commit to its hash. The recipe commits to the JSON around the hook's calldata instead, and
///      `verify` rebuilds the document: `prefix ++ hex(activate calldata) ++ suffix`. Nobody can
///      post the order under a different appData, e.g. one naming themselves as fee recipient.
///
///      An empty prefix switches to a fixed `appData`, for orders that reach the chain without a
///      hook carrying the recipe.
///
///      ## What is not re-checked
///
///      A registration outlives the activation that made it. Guards in the recipe gate that first
///      activation only; later arrivals are sold under the same rule without running them again.
contract SellBalanceHandler is IConditionalOrderHandler {
    /// @dev `staticInput`. Must not mention the drop, which is derived from it.
    struct Data {
        address sellToken;
        address buyToken;
        address receiver;
        /// @dev Buy units per sell unit.
        uint256 limitNumerator;
        uint256 limitDenominator;
        /// @dev The furthest `validTo` may sit from the block the order settles in.
        uint256 validitySeconds;
        /// @dev The order's appData when `appDataPrefix` is empty. Ignored otherwise.
        bytes32 appData;
        bytes appDataPrefix;
        bytes appDataSuffix;
    }

    string internal constant NEEDS_RECIPE = "appData needs the recipe as offchain input";

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

        if (LibCowOrder.hash(order, domainSeparator) != hash) revert OrderNotValid("invalid hash");
        if (address(order.sellToken) != data.sellToken) revert OrderNotValid("sell token");
        if (address(order.buyToken) != data.buyToken) revert OrderNotValid("buy token");
        if (order.receiver != data.receiver) revert OrderNotValid("receiver");
        if (order.kind != Orders.KIND_SELL) revert OrderNotValid("not a sell order");
        if (order.partiallyFillable) revert OrderNotValid("partially fillable");
        if (order.feeAmount != 0) revert OrderNotValid("fee");
        if (order.sellTokenBalance != Orders.BALANCE_ERC20) revert OrderNotValid("sell token balance");
        if (order.buyTokenBalance != Orders.BALANCE_ERC20) revert OrderNotValid("buy token balance");

        // The whole balance or nothing: a smaller order would leave a remainder to be sold again,
        // and each fill pays for itself out of the surplus.
        uint256 balance = IERC20Like(data.sellToken).balanceOf(owner);
        if (balance == 0 || order.sellAmount != balance) revert OrderNotValid("not the whole balance");

        if (order.buyAmount < Orders.applyLimitPrice(balance, data.limitNumerator, data.limitDenominator)) {
            revert OrderNotValid("below the limit price");
        }
        if (order.validTo > block.timestamp + data.validitySeconds) revert OrderNotValid("valid for too long");
        if (order.appData != _appData(owner, data, offchainInput)) revert OrderNotValid("appData");
    }

    /// @inheritdoc IConditionalOrderHandler
    /// @dev `validTo` is the end of a `validitySeconds` bucket rather than `now + validitySeconds`,
    ///      so every poll inside a bucket returns the same order instead of a new one per block.
    function getTradeableOrder(
        address owner,
        address,
        bytes32,
        bytes calldata staticInput,
        bytes calldata offchainInput
    ) external view override returns (LibCowOrder.Data memory) {
        Data memory data = abi.decode(staticInput, (Data));

        // A watch tower polls with no offchain input, and cannot produce the recipe.
        if (data.appDataPrefix.length != 0 && offchainInput.length == 0) revert PollNever(NEEDS_RECIPE);

        uint256 balance = IERC20Like(data.sellToken).balanceOf(owner);
        if (balance == 0) revert PollTryNextBlock("nothing to sell");

        uint256 validTo = block.timestamp;
        if (data.validitySeconds != 0) validTo = (validTo / data.validitySeconds + 1) * data.validitySeconds;
        if (validTo > type(uint32).max) revert PollNever("validTo overflow");

        return LibCowOrder.Data({
            sellToken: IERC20(data.sellToken),
            buyToken: IERC20(data.buyToken),
            receiver: data.receiver,
            sellAmount: balance,
            buyAmount: Orders.applyLimitPrice(balance, data.limitNumerator, data.limitDenominator),
            // casting to 'uint32' is safe because the bound is checked above
            // forge-lint: disable-next-line(unsafe-typecast)
            validTo: uint32(validTo),
            appData: _appData(owner, data, offchainInput),
            feeAmount: 0,
            kind: Orders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: Orders.BALANCE_ERC20,
            buyTokenBalance: Orders.BALANCE_ERC20
        });
    }

    /// @inheritdoc IConditionalOrderHandler
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        // composable-cow's `IConditionalOrderGenerator` declares one function of its own.
        return interfaceId == this.getTradeableOrder.selector || interfaceId == this.supportsInterface.selector;
    }

    /// @notice The appData hash an order for `owner` must carry.
    /// @param offchainInput `abi.encode(address shedOwner, bytes setupData)`: the recipe `owner` is
    ///        the drop of. Unused when the appData is fixed.
    function _appData(address owner, Data memory data, bytes calldata offchainInput) internal view returns (bytes32) {
        if (data.appDataPrefix.length == 0) return data.appData;
        if (offchainInput.length == 0) revert OrderNotValid(NEEDS_RECIPE);

        (address shedOwner, bytes memory setupData) = abi.decode(offchainInput, (address, bytes));
        // The hook must activate this drop, not merely some drop.
        if (EXECUTOR.dropOf(shedOwner, setupData) != owner) revert OrderNotValid("not this drop's recipe");

        bytes memory hook = abi.encodeCall(DropExecutor.activate, (shedOwner, setupData));
        return keccak256(abi.encodePacked(data.appDataPrefix, LibString.toHexStringNoPrefix(hook), data.appDataSuffix));
    }
}
