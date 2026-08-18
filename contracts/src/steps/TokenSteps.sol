// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

import {IERC20Like, IWrappedNative} from "../interfaces/IDropExternal.sol";
import {Allowance} from "../lib/Allowance.sol";
import {NothingToSell} from "../lib/Errors.sol";

/// @title TokenSteps
/// @notice Plain token moves: wrap, sweep, approve. No protocol knowledge, and the rescue primitive.
///
/// @dev ## Every function here is meant to be DELEGATECALLED by the shed
///
/// Steps that target this contract must set `Call.isDelegateCall = true`. That makes `address(this)`
/// the drop, so `balanceOf(address(this))` is *the amount that actually arrived* — which is the point.
/// A drop address cannot commit to an amount, because the amount is not known when the address is
/// computed: a bridge takes fees, a payroll run varies, a CEX withdrawal rounds.
///
/// ## Why this contract takes no constructor arguments, and why `sweep` lives here
///
/// A contract's CREATE2 address covers its constructor arguments as well as its code, and every
/// address a step reaches is committed into the drop address. Nothing here needs a protocol address —
/// `wrapNative` takes the wrapped-native token as an argument — so this address can only ever move if
/// the code below changes.
///
/// That property is the reason `sweep` is here rather than beside the order steps. `sweep` is the
/// rescue primitive, reached by `buildRescueTx` and `buildOwnerSweepTx` for a drop whose recipe can
/// never succeed. It is the last address that should move for an unrelated reason, and while it shared
/// a contract with the TWAP step it moved every time the TWAP handler did.
///
/// This contract has no storage: storage would not be readable under delegatecall anyway.
contract TokenSteps {
    /// @notice A sweep was pointed at the zero address.
    error InvalidRecipient();

    /// @notice The native-token transfer in a sweep was rejected by the recipient.
    error NativeTransferFailed();

    /// @notice Wrap the drop's entire native balance, so natively-funded drops can trade.
    /// @dev `COWShed` has a `receive()`, so a drop can be funded with plain ETH/xDAI.
    function wrapNative(address wrappedNative) external {
        uint256 balance = address(this).balance;
        if (balance == 0) revert NothingToSell();
        IWrappedNative(wrappedNative).deposit{value: balance}();
    }

    /// @notice Send the drop's entire balance of `token` to `to`. `token == address(0)` sweeps the
    ///         native balance.
    ///
    /// @dev The rescue primitive, for when a drop's committed recipe can never succeed and the funds
    ///      sent to it would otherwise be stranded. Not itself part of a recipe: rescue calls are
    ///      supplied at rescue time by the owner, either through
    ///      `COWShedExecutorFactory.initializeProxyWithoutSetup` (drop not yet deployed) or
    ///      `COWShed.trustedExecuteHooks` (drop already deployed, owner is admin so no signature is
    ///      needed).
    ///
    ///      Amount-independent, like the trading primitives — whoever is rescuing does not necessarily
    ///      know what arrived.
    ///
    ///      Unlike them, an empty balance is a no-op rather than a revert. A rescue naming five tokens
    ///      should move whatever it finds rather than fail because one of them was empty, and the
    ///      caller is the owner, who can see the result.
    function sweep(address token, address to) external {
        if (to == address(0)) revert InvalidRecipient();

        if (token == address(0)) {
            uint256 balance = address(this).balance;
            if (balance == 0) return;
            (bool ok,) = payable(to).call{value: balance}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            uint256 balance = IERC20Like(token).balanceOf(address(this));
            if (balance == 0) return;
            // SafeERC20 so tokens that return no boolean are handled — a rescue is the last thing
            // that should be defeated by a non-standard ERC20.
            SafeERC20.safeTransfer(IERC20(token), to, balance);
        }
    }

    /// @notice Allow `spender` to move an unlimited amount, unless it already can.
    ///
    /// @dev Conditional on purpose. A drop is re-triggerable, so a reusable deposit address runs its
    ///      recipe again on every arrival of funds — and an unlimited allowance survives between runs.
    ///      Writing it again would pay for an `SSTORE` of the value already there on every activation
    ///      after the first. Reading the allowance first costs an `SLOAD` and skips the write.
    ///
    ///      It also makes the step idempotent against tokens that refuse an `approve` while a non-zero
    ///      allowance stands. Those are rare, but a recurring drop is exactly where such a token would
    ///      succeed once and then fail forever.
    ///
    ///      The end state is the same either way, which is what makes this safe to do unconditionally:
    ///      after this runs, `spender` can move everything.
    function approveMax(address token, address spender) external {
        Allowance.ensureMax(token, spender, type(uint256).max);
    }

    /// @notice Allow `spender` to move exactly the balance that arrived, unless it already can.
    ///
    /// @dev The allowance step that *needs* to be a step. An allowance for a literal amount is an
    ///      ordinary call to the token and belongs in a `raw` step — but "the amount that arrived" is
    ///      not a literal, because the recipe is committed into the drop address before anything is
    ///      funded. Only code running at activation, with `address(this)` as the drop, can read it.
    ///
    ///      Reverts on an empty balance rather than approving nothing. A recipe that approves zero and
    ///      carries on has done nothing while appearing to succeed, and for a `once` recipe that spends
    ///      the single run — the failure mode this codebase turns into reverts everywhere else.
    function approveBalance(address token, address spender) external {
        uint256 balance = IERC20Like(token).balanceOf(address(this));
        if (balance == 0) revert NothingToSell();
        Allowance.ensureAtLeast(token, spender, balance);
    }
}
