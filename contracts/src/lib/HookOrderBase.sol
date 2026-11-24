// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {LibString} from "solady/utils/LibString.sol";

import {DropExecutor} from "../DropExecutor.sol";
import {IConditionalOrderHandler} from "../interfaces/IConditionalOrderHandler.sol";
import {IERC20Like} from "../interfaces/IDropExternal.sol";
import {Orders} from "./Orders.sol";

/// @title HookOrderBase
/// @notice What every handler for an order posted before its drop exists has to check.
///
/// @dev Abstract, so it has no address. A handler supplies the three things that differ: which token
///      is sold, the least it may fetch, and the hook that activates the drop. Everything else — the
///      fields an order is not allowed to vary, the whole-balance rule, the deadline, and rebuilding
///      the appData — is here once, because it is the part that guards the money.
///
///      ## Binding the appData
///
///      The hook carries the recipe, so the appData depends on the recipe and the recipe cannot
///      commit to its hash. The recipe commits to the JSON around the hook's calldata instead, and
///      `_appData` rebuilds the document: `prefix ++ hex(hook calldata) ++ suffix`. Nobody can post
///      the order under a different appData, e.g. one naming themselves as fee recipient.
///
///      An empty prefix switches to a fixed `appData`, for orders that reach the chain without a
///      hook carrying the recipe.
///
///      ## The recipe has to run, every time
///
///      A registration outlives the activation that made it, and CoW's hooks trampoline ignores a
///      hook that reverts. So without more, a recipe's guards would gate the first activation only:
///      on a later order they would revert the hook, and the order would settle anyway under the
///      registration already in place.
///
///      The recipe therefore ends by calling `markRan` on its handler, which records in transient
///      storage that this drop's recipe completed in this transaction, and `_check` requires it. A
///      guard that reverts takes the mark with it, so an order only ever settles in a transaction
///      whose hook ran the whole recipe.
abstract contract HookOrderBase is IConditionalOrderHandler {
    /// @dev What one order is held to, resolved by the handler from its own `staticInput`.
    struct Terms {
        address sellToken;
        address buyToken;
        address receiver;
        /// @dev The least the order may buy. Zero is refused: it would be an order filled for nothing.
        uint256 minBuyAmount;
        /// @dev The furthest `validTo` may sit from the block the order settles in.
        uint256 validitySeconds;
        /// @dev The order's appData when `appDataPrefix` is empty. Ignored otherwise.
        bytes32 appData;
        bytes appDataPrefix;
        bytes appDataSuffix;
    }

    string internal constant NEEDS_RECIPE = "appData needs the recipe as offchain input";

    /// @dev Base slot of the per-drop mark. Hashed with the drop, so one drop cannot vouch for another.
    bytes32 private constant RAN_SLOT = keccak256("cow-drop.HookOrderBase.ran");

    DropExecutor public immutable EXECUTOR;

    constructor(DropExecutor executor) {
        EXECUTOR = executor;
    }

    /// @notice Record that the caller's recipe ran to completion in this transaction.
    /// @dev A plain call, made by the drop as the last step of its recipe. Keyed by `msg.sender`, so
    ///      only a drop can mark itself; transient, so the mark cannot outlive the transaction.
    function markRan() external {
        bytes32 slot = _ranSlot(msg.sender);
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
    }

    /// @notice Whether `drop`'s recipe has run in this transaction.
    function ranThisTransaction(address drop) public view returns (bool ran) {
        bytes32 slot = _ranSlot(drop);
        assembly ("memory-safe") {
            ran := tload(slot)
        }
    }

    /// @inheritdoc IConditionalOrderHandler
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        // composable-cow's `IConditionalOrderGenerator` declares one function of its own.
        return interfaceId == this.getTradeableOrder.selector || interfaceId == this.supportsInterface.selector;
    }

    /// @notice The hook an order selling `sellToken` must carry to activate `shedOwner`'s drop.
    function _hook(address shedOwner, bytes memory setupData, address sellToken)
        internal
        view
        virtual
        returns (bytes memory);

    /// @notice `owner`'s balance of `sellToken`, which is what the order must sell: all of it.
    /// @dev A smaller order would leave a remainder to be sold again, and each fill pays for itself
    ///      out of the surplus.
    function _wholeBalance(address owner, address sellToken, LibCowOrder.Data calldata order)
        internal
        view
        returns (uint256 balance)
    {
        balance = IERC20Like(sellToken).balanceOf(owner);
        if (balance == 0 || order.sellAmount != balance) revert OrderNotValid("not the whole balance");
    }

    /// @notice Reverts unless `order` is a fee-less, fill-or-kill sell meeting `terms`.
    function _check(
        address owner,
        bytes32 hash,
        bytes32 domainSeparator,
        LibCowOrder.Data calldata order,
        Terms memory terms,
        bytes calldata offchainInput
    ) internal view {
        if (LibCowOrder.hash(order, domainSeparator) != hash) {
            revert OrderNotValid("invalid hash");
        }
        if (!ranThisTransaction(owner)) revert OrderNotValid("recipe did not run in this transaction");
        if (address(order.sellToken) != terms.sellToken) revert OrderNotValid("sell token");
        if (address(order.buyToken) != terms.buyToken) revert OrderNotValid("buy token");
        if (order.receiver != terms.receiver) revert OrderNotValid("receiver");
        if (order.kind != Orders.KIND_SELL) revert OrderNotValid("not a sell order");
        if (order.partiallyFillable) revert OrderNotValid("partially fillable");
        if (order.feeAmount != 0) revert OrderNotValid("fee");
        if (order.sellTokenBalance != Orders.BALANCE_ERC20) revert OrderNotValid("sell token balance");
        // gitleaks:allow (balance-kind constant, not a secret)
        if (order.buyTokenBalance != Orders.BALANCE_ERC20) revert OrderNotValid("buy token balance");

        if (terms.minBuyAmount == 0 || order.buyAmount < terms.minBuyAmount) revert OrderNotValid("below the minimum");
        if (order.validTo > block.timestamp + terms.validitySeconds) revert OrderNotValid("valid for too long");
        if (order.appData != _appData(owner, terms, offchainInput)) revert OrderNotValid("appData");
    }

    function _ranSlot(address drop) private pure returns (bytes32) {
        return keccak256(abi.encode(RAN_SLOT, drop));
    }

    /// @notice The appData hash an order for `owner` must carry.
    /// @param offchainInput `abi.encode(address shedOwner, bytes setupData)`: the recipe `owner` is
    ///        the drop of. Unused when the appData is fixed.
    function _appData(address owner, Terms memory terms, bytes calldata offchainInput) internal view returns (bytes32) {
        if (terms.appDataPrefix.length == 0) return terms.appData;
        if (offchainInput.length == 0) revert OrderNotValid(NEEDS_RECIPE);

        (address shedOwner, bytes memory setupData) = abi.decode(offchainInput, (address, bytes));
        // The hook must activate this drop, not merely some drop.
        if (EXECUTOR.dropOf(shedOwner, setupData) != owner) revert OrderNotValid("not this drop's recipe");

        bytes memory hook = _hook(shedOwner, setupData, terms.sellToken);
        return
            keccak256(abi.encodePacked(terms.appDataPrefix, LibString.toHexStringNoPrefix(hook), terms.appDataSuffix));
    }
}
