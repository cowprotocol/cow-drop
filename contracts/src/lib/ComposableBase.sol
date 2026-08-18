// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {IConditionalOrder} from "cow-shed/IConditionalOrder.sol";

import {IComposableCowLike, IERC20Like} from "../interfaces/IDropExternal.sol";
import {Allowance} from "./Allowance.sol";
import {NothingToSell} from "./Errors.sol";

/// @title ComposableBase
/// @notice The handler-agnostic half of a ComposableCoW step: read what arrived, register the order.
///
/// @dev ## Abstract, so it has no address of its own
///
/// One step contract per handler, because a handler needs its own typed function to build its own
/// `staticInput` — and a new function changes the contract's bytecode, which changes its address, which
/// changes every drop address that named the old one. Separate contracts keep that from happening to
/// handlers already in use.
///
/// That leaves the shared half needing a home which is *not* an address. It cannot be a library:
/// `_register` reads `COMPOSABLE_COW`, and a Solidity library cannot hold a non-constant state
/// variable, so a library version would have to thread the address through every call. An `abstract
/// contract` can hold it and is never deployed, so it costs no address either way. Immutables stay
/// readable under delegatecall because they live in the *concrete* contract's code.
///
/// ## Adding a handler
///
/// Extend this, take the handler's address as a constructor argument, and write one external function
/// that builds its `staticInput` struct and calls `_register`. Two requirements are not checkable from
/// here and have to be checked when adding one:
///
/// - **The handler must implement the generator side**, not just `verify`. The watch tower posts orders
///   by calling `getTradeableOrderWithSignature`; a verify-only handler reverts there and the order
///   never appears, having registered perfectly happily.
/// - **The handler must ignore `sender`.** cow-shed's `ERC1271Forwarder` passes the original caller as
///   `sender`, but by the time a drop's signature check reaches `DropExecutor.isValidSignature` the drop
///   has become `msg.sender` and the settlement contract is lost. TWAP ignores it; a handler or swap
///   guard that inspects it would see the drop.
///
/// The `staticInput` must also be **owner-independent**, or the address derivation becomes circular.
/// `receiver = address(0)` is GPv2's pay-the-owner sentinel and is the usual way to satisfy that.
///
/// A handler whose `staticInput` carries no amount at all needs none of this — `TradeAboveThreshold`
/// reads the owner's balance itself, so registering it is an ordinary `raw` call to ComposableCoW. A
/// step contract earns its place exactly when the amount has to be resolved at activation.
abstract contract ComposableBase {
    address public immutable VAULT_RELAYER;
    IComposableCowLike public immutable COMPOSABLE_COW;

    constructor(address vaultRelayer, IComposableCowLike composableCow) {
        VAULT_RELAYER = vaultRelayer;
        COMPOSABLE_COW = composableCow;
    }

    /// @dev The amount side of a conditional order, which is the part no recipe can commit to.
    ///
    ///      `divisor` is 1 for "sell the whole balance" and `n` for an n-part schedule. The relayer is
    ///      approved for the *whole* balance rather than `divisor * amount`, because the integer
    ///      division leaves a dust remainder in the drop and a later top-up should not need a fresh
    ///      approval.
    function _amountFromBalance(address sellToken, uint256 divisor) internal returns (uint256 amount) {
        uint256 balance = IERC20Like(sellToken).balanceOf(address(this));
        if (balance == 0) revert NothingToSell();

        amount = balance / divisor;
        // Reachable with a balance smaller than the number of parts, where every part rounds to zero.
        if (amount == 0) revert NothingToSell();

        Allowance.ensureMax(sellToken, VAULT_RELAYER, balance);
    }

    /// @dev Register handler-built `staticInput` with ComposableCoW as the drop.
    ///
    ///      `dispatch = true` so the watch tower sees it.
    ///
    ///      A non-zero `valueFactory` routes through `createWithContext`, which seeds ComposableCoW's
    ///      `cabinet` — that is how a handler reads activation time instead of having a start timestamp
    ///      committed into the drop address, which would make the drop expire before it was ever funded.
    ///      Handlers with no such field pass `address(0)` and get a plain `create`; passing a factory
    ///      they never read would seed a cabinet entry nothing consults.
    function _register(address handler, bytes32 orderSalt, bytes memory staticInput, address valueFactory)
        internal
        returns (bytes32 paramsHash)
    {
        IConditionalOrder.ConditionalOrderParams memory params = IConditionalOrder.ConditionalOrderParams({
            handler: IConditionalOrder(handler), salt: orderSalt, staticInput: staticInput
        });

        if (valueFactory == address(0)) {
            COMPOSABLE_COW.create(params, true);
        } else {
            COMPOSABLE_COW.createWithContext(params, valueFactory, "", true);
        }

        paramsHash = keccak256(abi.encode(params));
    }
}
