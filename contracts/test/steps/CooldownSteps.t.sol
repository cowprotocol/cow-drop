// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {DropExecutor} from "src/DropExecutor.sol";
import {CooldownSteps} from "src/steps/CooldownSteps.sol";
import {GuardSteps} from "src/steps/GuardSteps.sol";
import {TwapSteps} from "src/steps/TwapSteps.sol";

import {Call} from "cow-shed/ICOWAuthHook.sol";

import {StepsBase} from "./StepsBase.sol";

contract DropCooldownTest is StepsBase {
    uint256 internal constant PARTS = 12;
    uint256 internal constant PART_DURATION = 1 hours;
    uint256 internal constant SCHEDULE = PARTS * PART_DURATION;

    /// @dev A reusable TWAP recipe: refuse under `minAmount`, then claim the window, then register.
    ///      That order is load-bearing — see `test_dustCannotPushTheWindowOut`.
    function _reusableTwapRecipe(uint256 minAmount, uint256 cooldown) internal view returns (bytes memory) {
        Call[] memory calls = new Call[](3);
        calls[0] = _step(address(guards), abi.encodeCall(GuardSteps.requireMinBalance, (address(sellToken), minAmount)));
        calls[1] = _step(address(cooldowns), abi.encodeCall(CooldownSteps.claimCooldown, (cooldown)));
        calls[2] = _step(
            address(twapSteps),
            abi.encodeCall(
                TwapSteps.twapFromBalance,
                (
                    address(sellToken),
                    address(buyToken),
                    address(0),
                    PARTS,
                    PART_DURATION,
                    uint256(0),
                    uint256(95),
                    uint256(100),
                    bytes32(0),
                    bytes32(0)
                )
            )
        );
        return _recipeOf("twap reusable", false, calls);
    }

    /// @dev The whole point: the address keeps working for the next arrival, but never has two live
    ///      schedules drawing on one balance. One TWAP at a time, forever.
    function test_concurrencyOfOne_oneScheduleAtATime() external {
        bytes memory recipe = _reusableTwapRecipe(1000e18, SCHEDULE);
        address drop = executor.dropOf(owner, recipe);

        sellToken.mint(drop, 1200e18);
        vm.prank(keeper);
        executor.activate(owner, recipe);
        assertEq(composableCow.createCount(), 1, "first activation did not register");

        // A second payroll run lands while the first schedule is still working through its parts.
        sellToken.mint(drop, 1200e18);
        vm.warp(block.timestamp + SCHEDULE - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CooldownSteps.CooldownNotElapsed.selector, block.timestamp + 1));
        executor.activate(owner, recipe);
        assertEq(composableCow.createCount(), 1, "a second schedule was registered over the first");

        // One second later the first TWAP has run out of parts, and the drop takes the new money.
        vm.warp(block.timestamp + 1);
        vm.prank(keeper);
        executor.activate(owner, recipe);
        assertEq(composableCow.createCount(), 2, "the drop did not reactivate after the cooldown");
    }

    /// @dev The first activation of a never-claimed drop must pass: an unwritten slot reads as zero,
    ///      which is already in the past.
    function test_firstActivationIsNotGated() external {
        bytes memory recipe = _reusableTwapRecipe(1e18, SCHEDULE);
        address drop = executor.dropOf(owner, recipe);

        sellToken.mint(drop, 100e18);
        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertEq(composableCow.createCount(), 1, "a fresh drop was gated by a cooldown it never claimed");
        assertEq(
            uint256(vm.load(drop, cooldowns.COOLDOWN_SLOT())),
            block.timestamp + SCHEDULE,
            "the deadline was not recorded in the drop"
        );
    }

    /// @dev Activation is permissionless, so the cooldown is griefable without a balance floor: anyone
    ///      could re-activate on dust the moment the window opens and push the next honest activation
    ///      out by another full cooldown. The balance guard is what prevents it, and it only does so
    ///      because it runs *before* the claim — the revert takes the claim down with it.
    function test_dustCannotPushTheWindowOut() external {
        bytes memory recipe = _reusableTwapRecipe(1000e18, SCHEDULE);
        address drop = executor.dropOf(owner, recipe);

        sellToken.mint(drop, 1000e18);
        executor.activate(owner, recipe);
        uint256 deadline = block.timestamp + SCHEDULE;

        // The schedule runs its course and the solvers take the balance with it.
        vm.prank(drop);
        sellToken.transfer(recipient, 1000e18);

        // The window opens and a griefer gets there first with nothing to trade.
        vm.warp(deadline);
        sellToken.mint(drop, 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(GuardSteps.BalanceTooLow.selector, 1, 1000e18));
        executor.activate(owner, recipe);

        assertEq(uint256(vm.load(drop, cooldowns.COOLDOWN_SLOT())), deadline, "a failed activation moved the deadline");

        // So the real funds still activate in the same block.
        sellToken.mint(drop, 1000e18);
        executor.activate(owner, recipe);
        assertEq(composableCow.createCount(), 2, "the honest activation was blocked by the griefer");
    }

    /// @dev A zero cooldown gates nothing, which is what leaving the step out already means. Refused
    ///      so a recipe cannot look protected while it is not.
    function test_rejectsAZeroCooldown() external {
        bytes memory recipe = _recipe("zero", address(cooldowns), abi.encodeCall(CooldownSteps.claimCooldown, (0)));
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 1e18);

        vm.expectRevert(CooldownSteps.ZeroCooldown.selector);
        executor.activate(owner, recipe);
    }

    /// @dev The deadline is the drop's, not the step contract's. Two drops sharing a recipe — and
    ///      therefore the same `CooldownSteps` address — must not gate each other.
    function test_cooldownIsPerDrop() external {
        bytes memory recipe = _reusableTwapRecipe(1e18, SCHEDULE);
        address dropA = executor.dropOf(owner, recipe);
        address dropB = executor.dropOf(keeper, recipe);

        sellToken.mint(dropA, 100e18);
        sellToken.mint(dropB, 100e18);

        executor.activate(owner, recipe);
        // Same block, same step contract, different drop: unaffected.
        executor.activate(keeper, recipe);

        assertEq(composableCow.createCount(), 2, "one drop's cooldown gated another's");
        assertEq(uint256(vm.load(address(cooldowns), cooldowns.COOLDOWN_SLOT())), 0, "the step contract kept state");
    }

    /// @dev The slot is namespaced so it cannot land on cow-shed's own state. Asserted rather than
    ///      assumed, because a collision would corrupt the shed's admin rather than fail loudly.
    function test_slotIsNamespacedAwayFromTheShed() external view {
        bytes32 slot = cooldowns.COOLDOWN_SLOT();
        assertEq(slot, keccak256("cow-drop.cooldown.notBefore"), "slot preimage changed");
        assertTrue(slot != keccak256("COWShed.State"), "collides with COWShedStorage");
        assertTrue(
            slot != bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1), "collides with the EIP-1967 slot"
        );
        // Low slots are what a plain `uint256 x;` would occupy; a namespaced one is nowhere near them.
        assertTrue(uint256(slot) > 1e18, "slot is not namespaced");
    }

    /// @dev `once` and a cooldown are alternatives, not layers: `once` wins and the cooldown it wrote
    ///      is never consulted again. The SDK refuses the combination; the contracts simply do not
    ///      pretend otherwise.
    function test_onceStillWinsOverACooldown() external {
        Call[] memory calls = new Call[](1);
        calls[0] = _step(address(cooldowns), abi.encodeCall(CooldownSteps.claimCooldown, (1 hours)));
        bytes memory recipe = _recipeOf("once and cooldown", true, calls);

        executor.activate(owner, recipe);
        vm.warp(block.timestamp + 2 hours);

        vm.expectRevert(DropExecutor.AlreadyConsumed.selector);
        executor.activate(owner, recipe);
    }
}
