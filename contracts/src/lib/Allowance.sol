// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {IERC20Like} from "../interfaces/IDropExternal.sol";

/// @title Allowance
/// @notice The allowance handling shared by the step contracts that place orders.
///
/// @dev A library of `internal` functions, so it is inlined into each caller and never deployed. That
///      matters more than it usually would: a deployed library would need its own address, and every
///      address a step reaches is committed into the drop address — see `steps/`. Shared code that
///      costs no address is shared code that cannot move a drop address.
library Allowance {
    /// @notice Approve `spender` **without limit**, unless it is already allowed at least `required`.
    ///
    /// @dev Note the asymmetry, which is deliberate and is why this is not called `ensureAtLeast`: the
    ///      test is `required`, but the approval written is unlimited. That is what the order steps want
    ///      — a drop is re-triggerable, so a later top-up should not need a fresh approval — and it is
    ///      why the amount asked for and the amount granted are different things here.
    ///
    ///      Read-then-write rather than unconditional: the approval survives between activations, so a
    ///      reusable drop pays for it once rather than on every arrival of funds.
    function ensureMax(address token, address spender, uint256 required) internal {
        if (IERC20Like(token).allowance(address(this), spender) < required) {
            IERC20Like(token).approve(spender, type(uint256).max);
        }
    }

    /// @notice Approve `spender` for **exactly** `amount`, unless it is already allowed at least that.
    ///
    /// @dev The tight counterpart to `ensureMax`. Still conditional, and still upward-only: an allowance
    ///      that already exceeds `amount` is left alone rather than narrowed, because narrowing it could
    ///      break a step that ran earlier in the same recipe and is relying on the wider one.
    function ensureAtLeast(address token, address spender, uint256 amount) internal {
        if (IERC20Like(token).allowance(address(this), spender) < amount) {
            IERC20Like(token).approve(spender, amount);
        }
    }
}
