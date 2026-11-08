// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

/// @title CooldownSteps
/// @notice The step that makes a drop reusable *on a schedule*: run now, and not again until a
///         cooldown has elapsed.
///
/// @dev ## Every function here is meant to be DELEGATECALLED by the shed
///
/// Steps that target this contract must set `Call.isDelegateCall = true`. For the other step contracts
/// that is about *reading* `balanceOf(address(this))`; here it is about writing, which makes this the
/// first step that keeps state. Under delegatecall the `sstore` lands in the drop, which is the only
/// place it could mean anything: a cooldown belongs to one drop, and a step contract is shared by all
/// of them.
///
/// ## What it is for
///
/// `DropExecutor.Recipe.once` offers two settings, and for a recipe that registers a conditional order
/// neither is right. Reusable means a second activation registers a *second* order over the balance
/// the first is still working through, so two schedules compete for one balance. One-shot means the
/// address is spent after a single arrival, which throws away the thing a drop address is good at.
///
/// A cooldown is the third setting. Sized to the length of the schedule it guards — `n * t` for a TWAP
/// — it gives concurrency of exactly one: by the time a re-activation is allowed, the previous order
/// has run out of parts and is not merely stale but finished. The address keeps working for the next
/// arrival, and never has two live orders drawing on the same balance.
///
/// ## Why this is a contract of its own
///
/// Two reasons, both hard constraints rather than preferences.
///
/// A step's target sits inside the committed bytes of every recipe that reaches it, so it is part of
/// that drop's address. Adding a function to `GuardSteps` would change its bytecode, which changes its
/// address, which moves every drop that uses any guard — nearly all of them. A new contract moves
/// nothing: only recipes that name it reach it. That is the same reason `PaymentSteps` and
/// `ConvertSteps` could join generation 2 after it was cut, and it is why this one needs no new
/// generation either.
///
/// And `GuardSteps` is deliberately write-free: its one general-purpose guard is a `staticcall`
/// precisely so that the worst a malformed guard can do is revert. A guard that writes does not belong
/// in a contract that promises it never does.
///
/// ## Why the drop has to hold state at all
///
/// `GuardSteps.requireTimeWindow` takes absolute timestamps, and says why: a relative delay needs a
/// reference point, and the only honest one is activation time — which is the thing it is trying to
/// constrain. That reasoning holds for a *stateless* guard. A cooldown escapes it by recording the
/// reference point as the activation happens, so the next activation has a real one to measure from.
///
/// This contract itself has no storage variables, and could not use them if it did: storage under
/// delegatecall is the drop's, not this contract's. The slot below is addressed explicitly for that
/// reason.
///
/// ## Reading the deadline back
///
/// A drop is a `COWShedProxy`, so calling `cooldownNotBefore()` *on a drop address* reaches the shed
/// implementation, which has no such function, and reverts. Off-chain readers use
/// `eth_getStorageAt(drop, COOLDOWN_SLOT)` instead, or index `CooldownClaimed`. The slot is public
/// here so that it never has to be transcribed.
contract CooldownSteps {
    /// @notice Activated inside the cooldown the previous activation opened.
    error CooldownNotElapsed(uint256 notBefore);

    /// @notice A zero cooldown gates nothing, which is what leaving the step out of a recipe already
    ///         means. Refused so that it cannot be mistaken for protection the recipe does not have.
    error ZeroCooldown();

    /// @notice Carries the timestamp the *next* activation becomes possible, not the one just spent.
    event CooldownClaimed(uint256 notBefore);

    /// @notice The slot in the drop's storage holding the next timestamp an activation is allowed.
    ///
    /// @dev Namespaced, so it cannot collide with cow-shed's own state: `COWShedStorage` keeps its
    ///      struct under `keccak256("COWShed.State")` and the implementation pointer under the
    ///      EIP-1967 slot. A different preimage is a different slot.
    bytes32 public constant COOLDOWN_SLOT = keccak256("cow-drop.cooldown.notBefore");

    /// @notice Revert unless the previous cooldown has elapsed, then open a new one of
    ///         `cooldownSeconds`.
    ///
    /// @dev Claim-then-act, and the order matters. The write happens before the rest of the recipe
    ///      runs, for the same reason `DropExecutor` sets `consumed` before executing a `once` recipe:
    ///      a step later in the recipe must not be able to re-enter activation and claim the window
    ///      again. The first ever activation passes, since an unwritten slot reads as zero.
    ///
    ///      **Put it after the recipe's balance guard, not before it.** Activation is permissionless,
    ///      so whoever activates picks the moment; with no floor on the balance, anyone can re-activate
    ///      on dust the instant the window opens, place a negligible order and push the next honest
    ///      activation out by another full cooldown. The balance guard is what makes that revert — and
    ///      a revert rolls the claim back with it, because it is all one transaction.
    ///
    /// @param cooldownSeconds How long until the next activation is allowed, measured from now.
    function claimCooldown(uint256 cooldownSeconds) external {
        if (cooldownSeconds == 0) revert ZeroCooldown();

        bytes32 slot = COOLDOWN_SLOT;
        uint256 notBefore;
        assembly ("memory-safe") {
            notBefore := sload(slot)
        }
        if (block.timestamp < notBefore) revert CooldownNotElapsed(notBefore);

        // Checked arithmetic: a cooldown large enough to overflow reverts rather than wrapping to a
        // deadline in the past, which would silently gate nothing.
        uint256 next = block.timestamp + cooldownSeconds;
        assembly ("memory-safe") {
            sstore(slot, next)
        }

        emit CooldownClaimed(next);
    }

    /// @notice The timestamp this drop's next activation becomes possible. Zero when never claimed.
    /// @dev Delegatecall-only, like everything else here — called on this contract directly it reads
    ///      this contract's own slot and always answers zero. See the note above on reading it from
    ///      outside.
    function cooldownNotBefore() external view returns (uint256 notBefore) {
        bytes32 slot = COOLDOWN_SLOT;
        assembly ("memory-safe") {
            notBefore := sload(slot)
        }
    }
}
