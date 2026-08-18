// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {GuardSteps} from "src/steps/GuardSteps.sol";
import {PresignSteps} from "src/steps/PresignSteps.sol";
import {TwapSteps} from "src/steps/TwapSteps.sol";

import {Call} from "cow-shed/ICOWAuthHook.sol";

import {MockPriceFeed, MockReadable} from "../mocks/Mocks.sol";
import {StepsBase} from "./StepsBase.sol";

contract DropGuardsTest is StepsBase {
    /// @dev The point of the guard: a one-shot recipe cannot be spent on a part-delivered balance,
    ///      even though anyone may activate it. The guard reverts, so the run survives intact.
    function test_requireMinBalance_protectsAOneShotRecipeFromEarlyActivation() external {
        Call[] memory calls = new Call[](2);
        calls[0] = _step(address(guards), abi.encodeCall(GuardSteps.requireMinBalance, (address(sellToken), 1000e18)));
        calls[1] = _step(
            address(twapSteps),
            abi.encodeCall(
                TwapSteps.twapFromBalance,
                (
                    address(sellToken),
                    address(buyToken),
                    address(0),
                    uint256(12),
                    uint256(1 hours),
                    uint256(0),
                    uint256(95),
                    uint256(100),
                    bytes32(0),
                    bytes32(0)
                )
            )
        );
        bytes memory recipe = _recipeOf("guarded", true, calls);
        address drop = executor.dropOf(owner, recipe);

        // A bridge pays out a first tranche and an eager keeper tries to activate.
        sellToken.mint(drop, 250e18);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(GuardSteps.BalanceTooLow.selector, 250e18, 1000e18));
        executor.activate(owner, recipe);

        assertFalse(executor.consumed(drop), "the early activation spent the run");
        assertEq(composableCow.createCount(), 0, "a TWAP was registered on a partial balance");

        // The rest arrives and the recipe runs once, on the full amount.
        sellToken.mint(drop, 750e18);
        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertTrue(executor.consumed(drop), "run not spent after a valid activation");
        assertEq(composableCow.createCount(), 1, "TWAP not registered");
    }

    /// @dev A guard placed *after* the step it protects is still enforced, because the recipe is
    ///      atomic: one reverting call with `allowFailure: false` unwinds the whole activation. So
    ///      ordering is about what a guard measures and how early it fails, not about whether it
    ///      binds. Worth pinning, since the opposite would make the raw step builder a sharp edge.
    ///
    ///      It also spans two step contracts, which after the split is worth having: a recipe is free
    ///      to mix targets, and the atomicity is a property of the activation, not of one contract.
    function test_guardIsEnforcedEvenWhenPlacedLast() external {
        Call[] memory calls = new Call[](2);
        calls[0] = _step(
            address(presign),
            abi.encodeCall(
                PresignSteps.presignSellAll,
                (
                    address(sellToken),
                    address(buyToken),
                    recipient,
                    uint256(95),
                    uint256(100),
                    uint256(1 hours),
                    bytes32(0)
                )
            )
        );
        calls[1] = _step(address(guards), abi.encodeCall(GuardSteps.requireMinBalance, (address(sellToken), 1000e18)));
        bytes memory recipe = _recipeOf("guard-last", true, calls);
        address drop = executor.dropOf(owner, recipe);

        sellToken.mint(drop, 100e18);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(GuardSteps.BalanceTooLow.selector, 100e18, 1000e18));
        executor.activate(owner, recipe);

        // The pre-signature from step 1 was rolled back with everything else.
        assertEq(settlement.signerOf(keccak256(bytes(""))), address(0), "sanity");
        assertFalse(executor.consumed(drop), "the run was spent despite the guard failing");
        assertEq(drop.code.length, 0, "the drop should not exist after a reverted activation");
    }

    function test_requireMinBalance_guardsTheNativeBalanceToo() external {
        bytes memory recipe = _recipe(
            "native-guard", address(guards), abi.encodeCall(GuardSteps.requireMinBalance, (address(0), 2 ether))
        );
        address drop = executor.dropOf(owner, recipe);

        vm.deal(drop, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(GuardSteps.BalanceTooLow.selector, 1 ether, 2 ether));
        executor.activate(owner, recipe);

        vm.deal(drop, 2 ether);
        executor.activate(owner, recipe); // now passes
    }

    function test_requireTimeWindow_rejectsEarlyAndLateActivation() external {
        uint256 opens = block.timestamp + 1 days;
        uint256 closes = block.timestamp + 2 days;
        bytes memory recipe =
            _recipe("window", address(guards), abi.encodeCall(GuardSteps.requireTimeWindow, (opens, closes)));

        vm.expectRevert(abi.encodeWithSelector(GuardSteps.TooEarly.selector, opens));
        executor.activate(owner, recipe);

        vm.warp(opens + 1 hours);
        executor.activate(owner, recipe); // inside the window

        vm.warp(closes + 1);
        vm.expectRevert(abi.encodeWithSelector(GuardSteps.TooLate.selector, closes));
        executor.activate(owner, recipe);
    }

    // --- the generic read guard ---------------------------------------------------------------

    function _callGuard(
        address target,
        bytes memory callData,
        uint256 wordIndex,
        GuardSteps.Comparison cmp,
        int256 threshold
    ) internal view returns (bytes memory) {
        return _recipe(
            "read-guard",
            address(guards),
            abi.encodeCall(GuardSteps.requireCallResult, (target, callData, wordIndex, cmp, threshold))
        );
    }

    function test_requireCallResult_passesAndFailsOnASingleWordGetter() external {
        MockReadable readable = new MockReadable(500);

        bytes memory ok = _callGuard(
            address(readable), abi.encodeWithSignature("value()"), 0, GuardSteps.Comparison.GreaterThan, 100
        );
        executor.activate(owner, ok);

        bytes memory bad = _callGuard(
            address(readable), abi.encodeWithSignature("value()"), 0, GuardSteps.Comparison.GreaterThan, 900
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                GuardSteps.ComparisonFailed.selector, int256(500), GuardSteps.Comparison.GreaterThan, int256(900)
            )
        );
        executor.activate(owner, bad);
    }

    /// @dev The case `wordIndex` exists for: Chainlink puts `answer` at index 1 of five return values.
    function test_requireCallResult_readsAWordOtherThanTheFirst() external {
        MockPriceFeed feed = new MockPriceFeed(8, 3e8);

        bytes memory recipe = _callGuard(
            address(feed), abi.encodeWithSignature("latestRoundData()"), 1, GuardSteps.Comparison.GreaterOrEqual, 2e8
        );
        executor.activate(owner, recipe);

        // Index 0 is roundId (1), which fails the same comparison — so the index really is being used.
        bytes memory wrongWord = _callGuard(
            address(feed), abi.encodeWithSignature("latestRoundData()"), 0, GuardSteps.Comparison.GreaterOrEqual, 2e8
        );
        vm.expectRevert();
        executor.activate(owner, wrongWord);
    }

    function test_requireCallResult_surfacesAFailingCallRatherThanPassing() external {
        MockReadable readable = new MockReadable(1);
        bytes memory recipe =
            _callGuard(address(readable), abi.encodeWithSignature("boom()"), 0, GuardSteps.Comparison.GreaterThan, 0);

        vm.expectRevert();
        executor.activate(owner, recipe);
    }

    function test_requireCallResult_rejectsAWordIndexPastTheReturnData() external {
        MockReadable readable = new MockReadable(1);
        bytes memory recipe =
            _callGuard(address(readable), abi.encodeWithSignature("value()"), 7, GuardSteps.Comparison.GreaterThan, 0);

        vm.expectRevert(abi.encodeWithSelector(GuardSteps.ResultTooShort.selector, uint256(1), uint256(7)));
        executor.activate(owner, recipe);
    }

    /// @dev It is a `staticcall`, so a target that tries to write cannot. Worth pinning: this is the one
    ///      step that takes an arbitrary target from the recipe, and read-only is what bounds it.
    function test_requireCallResult_cannotWrite() external {
        // `mint` would change state; under staticcall it reverts, so the guard reports a failed call
        // rather than quietly mutating the token.
        bytes memory recipe = _callGuard(
            address(sellToken),
            abi.encodeWithSignature("mint(address,uint256)", owner, 1e18),
            0,
            GuardSteps.Comparison.GreaterThan,
            0
        );

        vm.expectRevert();
        executor.activate(owner, recipe);
        assertEq(sellToken.balanceOf(owner), 0, "a guard managed to write");
    }
}
