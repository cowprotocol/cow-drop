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
///      ## Two kinds of recipe
///
///      A registration and an approval outlive the activation that made them, and CoW's hooks
///      trampoline ignores a hook that reverts. What follows from that depends on the recipe.
///
///      **Not strict**: the recipe only approves and registers. The hook matters once, to deploy the
///      drop; without it the drop has no code and cannot sign. After that an order needs nothing the
///      hook does, so it may also come with no hook at all, under the fixed `appData` the recipe
///      commits to. Whoever posts picks: the hook when the drop is not deployed or the relayer is
///      not yet approved for the token, the fixed appData otherwise.
///
///      **Strict**: the recipe has something to re-check on every order, a guard or a ration. Then a
///      hook that reverts must take the order with it. The recipe ends by calling `markRan`, which
///      records in transient storage that this drop's recipe completed in this transaction for this
///      sell token, and `_check` requires it. A guard that reverts takes the mark with it, so an
///      order only settles in a transaction whose own hook ran the whole recipe. There is no
///      hook-free form.
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
        /// @dev Whether every order needs its own hook to have run the recipe. See the contract notes.
        bool strict;
        /// @dev The appData of an order that carries no recipe: one with no hook.
        bytes32 appData;
        /// @dev The JSON around the hook's calldata. Empty means no order carries a hook.
        bytes appDataPrefix;
        bytes appDataSuffix;
    }

    string internal constant NEEDS_RECIPE = "this recipe needs its hook on every order";

    /// @dev Base slot of the mark. Hashed with the drop and the token, so one drop cannot vouch for
    ///      another, nor one order's hook for another order's.
    bytes32 private constant RAN_SLOT = keccak256("cow-drop.HookOrderBase.ran");

    DropExecutor public immutable EXECUTOR;

    constructor(DropExecutor executor) {
        EXECUTOR = executor;
    }

    /// @notice Record that the caller's recipe ran to completion in this transaction, for an order
    ///         selling `sellToken`.
    /// @dev A plain call made by the drop from its recipe. Keyed by `msg.sender`, so only a drop can
    ///      mark itself; transient, so the mark cannot outlive the transaction.
    function markRan(address sellToken) external {
        bytes32 slot = _ranSlot(msg.sender, sellToken);
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
    }

    /// @notice Whether `drop`'s recipe has run in this transaction for an order selling `sellToken`.
    function ranThisTransaction(address drop, address sellToken) public view returns (bool ran) {
        bytes32 slot = _ranSlot(drop, sellToken);
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
        if (terms.strict && !ranThisTransaction(owner, terms.sellToken)) {
            revert OrderNotValid("recipe did not run in this transaction");
        }
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

    function _ranSlot(address drop, address sellToken) private pure returns (bytes32) {
        return keccak256(abi.encode(RAN_SLOT, drop, sellToken));
    }

    /// @notice The appData hash an order for `owner` must carry.
    /// @param offchainInput `abi.encode(address shedOwner, bytes setupData)`, the recipe `owner` is
    ///        the drop of, for an order that carries the hook. Empty for one that does not.
    function _appData(address owner, Terms memory terms, bytes calldata offchainInput) internal view returns (bytes32) {
        if (offchainInput.length == 0) {
            // No recipe, so no hook. Refused where the recipe has a template and every order needs
            // the hook; with no template at all, the fixed appData is the only form there is.
            if (terms.strict && terms.appDataPrefix.length != 0) revert OrderNotValid(NEEDS_RECIPE);
            return terms.appData;
        }
        if (terms.appDataPrefix.length == 0) revert OrderNotValid("no appData template for a hook");

        (address shedOwner, bytes memory setupData) = abi.decode(offchainInput, (address, bytes));
        // The hook must activate this drop, not merely some drop.
        if (EXECUTOR.dropOf(shedOwner, setupData) != owner) revert OrderNotValid("not this drop's recipe");

        bytes memory hook = _hook(shedOwner, setupData, terms.sellToken);
        return
            keccak256(abi.encodePacked(terms.appDataPrefix, LibString.toHexStringNoPrefix(hook), terms.appDataSuffix));
    }
}
