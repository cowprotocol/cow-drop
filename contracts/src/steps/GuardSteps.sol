// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {IERC20Like} from "../interfaces/IDropExternal.sol";

/// @title GuardSteps
/// @notice The steps that say "not yet" — the ones that make a premature activation revert.
///
/// @dev ## Every function here is meant to be DELEGATECALLED by the shed
///
/// Steps that target this contract must set `Call.isDelegateCall = true`. That makes `address(this)`
/// the drop, so `balanceOf(address(this))` is *the amount that actually arrived*.
///
/// ## Why guards are steps rather than arguments to activation
///
/// Activation is permissionless, so "nobody triggers this early" cannot be a promise made by whoever
/// activates — it has to be a property of the recipe. These are ordinary steps, committed into the
/// drop address like everything else, so no activator can skip them; and because they revert rather
/// than return false, a premature activation rolls back whole. That matters most for a `once` recipe,
/// where the alternative is spending the single run on a half-delivered balance.
///
/// ## Why this contract takes no constructor arguments
///
/// A contract's CREATE2 address covers its constructor arguments as well as its code, and every
/// address a step reaches is committed into the drop address. Guards depend on no protocol contract,
/// so they take nothing — which means this address can only ever move if the code below changes. It is
/// deliberately not merged with the trading steps, whose addresses track CoW and ComposableCoW.
///
/// This contract has no storage: storage would not be readable under delegatecall anyway.
contract GuardSteps {
    /// @notice The drop holds less than the recipe requires to proceed.
    error BalanceTooLow(uint256 available, uint256 required);

    /// @notice Activated before the recipe's window opened.
    error TooEarly(uint256 notBefore);

    /// @notice Activated after the recipe's window closed.
    error TooLate(uint256 notAfter);

    /// @notice The guarded call reverted, so there is no value to compare.
    error CallFailed(address target, bytes reason);

    /// @notice The guarded call returned too few words to read the one asked for.
    error ResultTooShort(uint256 returned, uint256 wordIndex);

    /// @notice The value read did not satisfy the comparison.
    error ComparisonFailed(int256 value, Comparison comparison, int256 threshold);

    /// @notice How a read value is compared against its threshold.
    enum Comparison {
        GreaterThan,
        GreaterOrEqual,
        LessThan,
        LessOrEqual,
        Equal
    }

    /// @notice Revert unless the drop holds at least `minAmount`. Pass `token == address(0)` for the
    ///         native balance.
    /// @dev Must be delegatecalled — reading the drop's balance is only possible when `address(this)`
    ///      *is* the drop. The drop address cannot be passed in as an argument, because arguments are
    ///      committed into that very address.
    function requireMinBalance(address token, uint256 minAmount) external view {
        uint256 available = token == address(0) ? address(this).balance : IERC20Like(token).balanceOf(address(this));
        if (available < minAmount) revert BalanceTooLow(available, minAmount);
    }

    /// @notice Revert outside the window `[notBefore, notAfter]`. Either bound may be 0 for
    ///         "unbounded".
    /// @dev Absolute timestamps, so they are fixed when the address is computed. A relative delay
    ///      would need a reference point, and the only honest one — activation time — is what this
    ///      is trying to constrain.
    function requireTimeWindow(uint256 notBefore, uint256 notAfter) external view {
        if (notBefore != 0 && block.timestamp < notBefore) revert TooEarly(notBefore);
        if (notAfter != 0 && block.timestamp > notAfter) revert TooLate(notAfter);
    }

    /// @notice Revert unless a read from another contract satisfies a comparison.
    ///
    /// @dev The general-purpose guard: it can express an oracle threshold, a balance somewhere else, a
    ///      protocol's utilisation, anything reachable by a `view`.
    ///
    ///      **`staticcall`, deliberately.** A guard has no business writing anything, and this is the
    ///      one step that takes an arbitrary target from the recipe. Making it read-only means the worst
    ///      a malformed one can do is revert, or pass when it should not — never move a balance. That is
    ///      also why the generic *write* step this resembles does not exist.
    ///
    ///      ## What it cannot promise
    ///
    ///      **A guard is a refusal, not a trigger.** It is evaluated once, at activation. Nothing is
    ///      watching for the moment the condition turns true, so "sell when the price crosses X" is not
    ///      this — that is a conditional order, where the watch tower polls (see `StopLossSteps`). Use
    ///      this to refuse to start on terms you would not accept, not to wait for terms you want.
    ///
    ///      **`wordIndex` is unchecked against meaning.** The return data is read as raw words, so an
    ///      index pointing at the wrong field of a multi-return function compares the wrong number and
    ///      may pass when it should fail. Chainlink's `latestRoundData` puts `answer` at index 1;
    ///      anything returning a dynamic type has an offset there instead, not a value. Getting this
    ///      wrong is silent, which is why a UI should show the target and calldata rather than a
    ///      friendly summary.
    ///
    /// @param target     The contract to read from.
    /// @param callData   The full calldata, selector included.
    /// @param wordIndex  Which 32-byte word of the return data to compare. `0` for a single return.
    /// @param comparison How `value` must relate to `threshold`.
    /// @param threshold  Signed, so both Chainlink answers and plain `uint256` getters fit. A `uint256`
    ///                   above `2**255` would read as negative, which no sane threshold is.
    function requireCallResult(
        address target,
        bytes calldata callData,
        uint256 wordIndex,
        Comparison comparison,
        int256 threshold
    ) external view {
        (bool ok, bytes memory returnData) = target.staticcall(callData);
        if (!ok) revert CallFailed(target, returnData);

        uint256 words = returnData.length / 32;
        if (wordIndex >= words) revert ResultTooShort(words, wordIndex);

        int256 value;
        uint256 offset = 32 + wordIndex * 32;
        assembly ("memory-safe") {
            value := mload(add(returnData, offset))
        }

        bool passed = comparison == Comparison.GreaterThan
            ? value > threshold
            : comparison == Comparison.GreaterOrEqual
                ? value >= threshold
                : comparison == Comparison.LessThan
                    ? value < threshold
                    : comparison == Comparison.LessOrEqual ? value <= threshold : value == threshold;

        if (!passed) revert ComparisonFailed(value, comparison, threshold);
    }
}
