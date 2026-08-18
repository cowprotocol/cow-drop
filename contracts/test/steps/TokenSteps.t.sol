// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {NothingToSell} from "src/lib/Errors.sol";
import {PresignSteps} from "src/steps/PresignSteps.sol";
import {TokenSteps} from "src/steps/TokenSteps.sol";

import {Call} from "cow-shed/ICOWAuthHook.sol";

import {StepsBase} from "./StepsBase.sol";

contract DropTokenOpsTest is StepsBase {
    function test_wrapNative_wrapsWhateverNativeBalanceArrived() external {
        bytes memory recipe =
            _recipe("wrap", address(tokenOps), abi.encodeCall(TokenSteps.wrapNative, (address(wrappedNative))));
        address drop = executor.dropOf(owner, recipe);

        vm.deal(drop, 3 ether);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertEq(wrappedNative.balanceOf(drop), 3 ether, "native balance not wrapped");
        assertEq(drop.balance, 0, "native balance not fully wrapped");
    }

    function test_approveBalance_approvesExactlyWhatArrived() external {
        // The reason this is a step at all: the amount is not a literal, so no `raw` call can express
        // it. The recipe commits to "approve whatever lands here", not to a number.
        bytes memory recipe = _recipe(
            "approve-balance",
            address(tokenOps),
            abi.encodeCall(TokenSteps.approveBalance, (address(sellToken), VAULT_RELAYER))
        );
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 1234.5e18);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertEq(sellToken.allowance(drop, VAULT_RELAYER), 1234.5e18, "allowance is not the arrived balance");
    }

    function test_approveBalance_revertsOnAnEmptyBalance() external {
        bytes memory recipe = _recipe(
            "approve-nothing",
            address(tokenOps),
            abi.encodeCall(TokenSteps.approveBalance, (address(sellToken), VAULT_RELAYER))
        );

        vm.prank(keeper);
        vm.expectRevert(NothingToSell.selector);
        executor.activate(owner, recipe);
    }

    /// @dev A reusable drop runs its recipe again on every arrival, and an unlimited allowance survives
    ///      between runs — so re-writing it would pay for an `SSTORE` of the value already there, every
    ///      time, forever. Only the call count can show the skip, since the end state is identical.
    function test_approveMax_skipsTheWriteOnReactivation() external {
        bytes memory recipe = _recipe(
            "approve-max", address(tokenOps), abi.encodeCall(TokenSteps.approveMax, (address(sellToken), VAULT_RELAYER))
        );
        address drop = executor.dropOf(owner, recipe);

        vm.prank(keeper);
        executor.activate(owner, recipe);
        assertEq(sellToken.allowance(drop, VAULT_RELAYER), type(uint256).max, "not approved");
        assertEq(sellToken.approveCalls(drop), 1, "first activation should write the allowance");

        // Funds arrive again and a keeper re-triggers, which is the ordinary case for a reusable drop.
        vm.prank(keeper);
        executor.activate(owner, recipe);
        assertEq(sellToken.approveCalls(drop), 1, "re-activation rewrote an allowance that already stood");
        assertEq(sellToken.allowance(drop, VAULT_RELAYER), type(uint256).max, "allowance was disturbed");
    }

    /// @dev `approveBalance` is conditional the same way, so a drop already at max does not fall back to
    ///      a tighter allowance — the step asks for *at least* the balance, not exactly it.
    function test_approveBalance_leavesAWiderAllowanceAlone() external {
        Call[] memory calls = new Call[](2);
        calls[0] = _step(address(tokenOps), abi.encodeCall(TokenSteps.approveMax, (address(sellToken), VAULT_RELAYER)));
        calls[1] =
            _step(address(tokenOps), abi.encodeCall(TokenSteps.approveBalance, (address(sellToken), VAULT_RELAYER)));
        bytes memory recipe = _recipeOf("max-then-balance", false, calls);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 100e18);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertEq(sellToken.allowance(drop, VAULT_RELAYER), type(uint256).max, "the wider allowance was narrowed");
        assertEq(sellToken.approveCalls(drop), 1, "the second step wrote an allowance it did not need to");
    }

    /// @dev The shape the "bridge in, then swap" demo actually uses, and after the split it also
    ///      demonstrates a recipe spanning two step contracts: approve from `TokenSteps`, sell from
    ///      `PresignSteps`. Nothing in `DropExecutor` restricts a recipe to one target.
    function test_multiStepRecipeRunsInOrderAcrossStepContracts() external {
        Call[] memory calls = new Call[](2);
        calls[0] = _step(address(tokenOps), abi.encodeCall(TokenSteps.approveMax, (address(sellToken), VAULT_RELAYER)));
        calls[1] = _step(
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
        bytes memory recipe = _recipeOf("multi", false, calls);

        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 500e18);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertEq(sellToken.allowance(drop, VAULT_RELAYER), type(uint256).max, "approve step did not run");
        assertEq(composableCow.createCount(), 0, "presign path must not touch composable-cow");
    }
}
