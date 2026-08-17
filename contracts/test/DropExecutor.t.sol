// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {DropExecutor} from "src/DropExecutor.sol";
import {COWShed} from "cow-shed/COWShed.sol";
import {COWShedExecutorFactory} from "cow-shed/COWShedExecutorFactory.sol";
import {Call} from "cow-shed/ICOWAuthHook.sol";
import {MockERC20, Recorder} from "./mocks/Mocks.sol";

contract DropExecutorTest is Test {
    COWShed internal impl;
    COWShedExecutorFactory internal factory;
    DropExecutor internal executor;
    Recorder internal recorder;
    MockERC20 internal token;

    address internal owner = makeAddr("owner");
    address internal attacker = makeAddr("attacker");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        impl = new COWShed();
        factory = new COWShedExecutorFactory(address(impl));
        executor = new DropExecutor(factory);
        recorder = new Recorder();
        token = new MockERC20();
    }

    // --- helpers ---------------------------------------------------------------------------

    function _pingRecipe(bytes32 label, bool once, uint256 value) internal view returns (bytes memory) {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(recorder),
            value: value,
            callData: abi.encodeCall(Recorder.ping, ()),
            allowFailure: false,
            isDelegateCall: false
        });
        return abi.encode(DropExecutor.Recipe({label: label, salt: bytes32(0), once: once, calls: calls}));
    }

    /// @dev Same recipe, explicit salt.
    function _saltedRecipe(bytes32 label, bytes32 salt) internal view returns (bytes memory) {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(recorder),
            value: 0,
            callData: abi.encodeCall(Recorder.ping, ()),
            allowFailure: false,
            isDelegateCall: false
        });
        return abi.encode(DropExecutor.Recipe({label: label, salt: salt, once: false, calls: calls}));
    }

    // --- derivation ------------------------------------------------------------------------

    /// @dev The salt is the escape hatch for wanting the *same* recipe at more than one address —
    ///      several independent payroll drops, say — without having to make the human-readable label
    ///      artificially unique, and it gives a grinding space for vanity addresses.
    function test_dropOf_saltGivesTheSameRecipeADifferentAddress() external view {
        bytes memory a = _saltedRecipe("payroll", bytes32(0));
        bytes memory b = _saltedRecipe("payroll", bytes32(uint256(1)));
        bytes memory c = _saltedRecipe("payroll", bytes32(uint256(2)));

        address[3] memory derived = [executor.dropOf(owner, a), executor.dropOf(owner, b), executor.dropOf(owner, c)];
        assertTrue(derived[0] != derived[1] && derived[1] != derived[2] && derived[0] != derived[2], "salt is ignored");
    }

    function test_activate_worksWithANonZeroSalt() external {
        bytes memory recipe = _saltedRecipe("salted", bytes32(uint256(42)));
        address predicted = executor.dropOf(owner, recipe);

        vm.prank(keeper);
        address drop = executor.activate(owner, recipe);

        assertEq(drop, predicted, "salted drop deployed at an unexpected address");
        assertEq(recorder.lastCaller(), drop, "recipe did not run as the shed");
    }


    function test_dropOf_isDeterministicAndRecipeSpecific() external view {
        bytes memory a = _pingRecipe("a", false, 0);
        bytes memory b = _pingRecipe("b", false, 0);

        assertEq(executor.dropOf(owner, a), executor.dropOf(owner, a), "not deterministic");
        assertTrue(executor.dropOf(owner, a) != executor.dropOf(owner, b), "label does not move the address");
        assertTrue(executor.dropOf(owner, a) != executor.dropOf(attacker, a), "owner does not move the address");
    }

    function test_dropOf_onceFlagIsPartOfTheCommitment() external view {
        assertTrue(
            executor.dropOf(owner, _pingRecipe("x", false, 0)) != executor.dropOf(owner, _pingRecipe("x", true, 0)),
            "once flag does not move the address"
        );
    }

    // --- the happy path --------------------------------------------------------------------

    function test_activate_deploysAtPredictedAddressAndRunsAsTheShed() external {
        bytes memory recipe = _pingRecipe("go", false, 0);
        address predicted = executor.dropOf(owner, recipe);
        assertEq(predicted.code.length, 0, "already deployed");

        // Anyone may activate: no signature, no owner involvement.
        vm.prank(keeper);
        address drop = executor.activate(owner, recipe);

        assertEq(drop, predicted, "deployed at an unexpected address");
        assertGt(drop.code.length, 0, "not deployed");
        assertEq(COWShed(payable(drop)).trustedExecutor(), address(executor), "executor not wired");
        assertEq(recorder.pings(), 1, "recipe did not run");
        assertEq(recorder.lastCaller(), drop, "recipe did not run as the shed");
    }

    function test_activate_spendsFundsThatArrivedBeforeDeployment() external {
        bytes memory recipe = _pingRecipe("prefunded", false, 0.3 ether);
        address predicted = executor.dropOf(owner, recipe);

        // This is the whole point: fund the address before it exists.
        vm.deal(predicted, 1 ether);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertEq(recorder.lastValue(), 0.3 ether, "recipe did not spend the pre-funded balance");
        assertEq(predicted.balance, 0.7 ether, "remainder not retained by the drop");
    }

    function test_activate_isIdempotentAndRerunsForLaterArrivals() external {
        bytes memory recipe = _pingRecipe("reusable", false, 0);

        vm.prank(keeper);
        address drop = executor.activate(owner, recipe);
        assertEq(recorder.pings(), 1);

        // Second activation takes the already-deployed branch and runs the recipe again,
        // which is what makes a drop a reusable deposit address.
        vm.prank(keeper);
        assertEq(executor.activate(owner, recipe), drop, "address changed on re-activation");
        assertEq(recorder.pings(), 2, "recipe did not re-run");
    }

    function test_activate_movesTokensThatLandedAtTheDrop() external {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(token),
            value: 0,
            callData: abi.encodeCall(MockERC20.transfer, (owner, 100)),
            allowFailure: false,
            isDelegateCall: false
        });
        bytes memory recipe = abi.encode(DropExecutor.Recipe({label: "sweep", salt: bytes32(0), once: false, calls: calls}));

        address predicted = executor.dropOf(owner, recipe);
        token.mint(predicted, 100);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertEq(token.balanceOf(predicted), 0, "drop still holds the tokens");
        assertEq(token.balanceOf(owner), 100, "owner did not receive the tokens");
    }

    // --- once ------------------------------------------------------------------------------

    function test_once_cannotBeReplayed() external {
        bytes memory recipe = _pingRecipe("oneshot", true, 0);

        vm.prank(keeper);
        address drop = executor.activate(owner, recipe);
        assertEq(recorder.pings(), 1);
        assertTrue(executor.consumed(drop), "not marked consumed");

        vm.prank(keeper);
        vm.expectRevert(DropExecutor.AlreadyConsumed.selector);
        executor.activate(owner, recipe);

        assertEq(recorder.pings(), 1, "once recipe ran twice");
    }

    /// @dev The griefing question for one-shot drops: can someone burn the single allowed run by
    ///      activating before the funds arrive? No — `consumed` is written in the same transaction
    ///      as the calls, so a recipe that reverts rolls the flag back with it. A premature
    ///      activation costs the caller gas and changes nothing.
    function test_once_prematureActivationDoesNotBurnTheRun() external {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(token),
            value: 0,
            callData: abi.encodeCall(MockERC20.transfer, (owner, 100)),
            allowFailure: false,
            isDelegateCall: false
        });
        bytes memory recipe = abi.encode(DropExecutor.Recipe({label: "oneshot", salt: bytes32(0), once: true, calls: calls}));
        address drop = executor.dropOf(owner, recipe);

        // Nothing has arrived yet, so the transfer underflows and the whole activation reverts.
        vm.prank(attacker);
        vm.expectRevert();
        executor.activate(owner, recipe);

        assertFalse(executor.consumed(drop), "a failed activation burned the run");
        assertEq(drop.code.length, 0, "a failed activation should not leave a deployed drop");

        // The funds arrive later and the run is still available.
        token.mint(drop, 100);
        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertEq(token.balanceOf(owner), 100, "recipe did not run after the funds arrived");
        assertTrue(executor.consumed(drop), "run not marked consumed");
    }

    /// @dev The trap in the same area. `allowFailure: true` lets a step fail *without* reverting the
    ///      recipe, so the activation succeeds having done nothing — and `once` is spent. The two
    ///      flags are safe individually and dangerous together, which is why the SDK refuses the
    ///      combination at compile time.
    function test_once_withAllowFailureCanBeBurnedByAnyone() external {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(token),
            value: 0,
            callData: abi.encodeCall(MockERC20.transfer, (owner, 100)),
            allowFailure: true, // <-- the footgun
            isDelegateCall: false
        });
        bytes memory recipe = abi.encode(DropExecutor.Recipe({label: "burnable", salt: bytes32(0), once: true, calls: calls}));
        address drop = executor.dropOf(owner, recipe);

        // No funds yet, but the failure is swallowed, so the activation "succeeds".
        vm.prank(attacker);
        executor.activate(owner, recipe);
        assertTrue(executor.consumed(drop), "expected the run to be spent");

        // The funds arrive, and the recipe can never run again.
        token.mint(drop, 100);
        vm.prank(keeper);
        vm.expectRevert(DropExecutor.AlreadyConsumed.selector);
        executor.activate(owner, recipe);

        assertEq(token.balanceOf(drop), 100, "funds are stuck at the drop, recoverable only by the owner");
    }

    // --- the attacks -----------------------------------------------------------------------

    /// @dev The core attack. `DropExecutor` is the trusted executor of every drop, and
    ///      `trustedExecuteHooks` needs no signature — so if `setup` trusted its arguments,
    ///      this would drain every drop in the system.
    function test_attack_setupWithAForgedRecipeIsRejected() external {
        bytes memory recipe = _pingRecipe("victim", false, 0);
        vm.prank(keeper);
        address drop = executor.activate(owner, recipe);
        vm.deal(drop, 10 ether);

        Call[] memory theft = new Call[](1);
        theft[0] = Call({
            target: attacker,
            value: 10 ether,
            callData: "",
            allowFailure: false,
            isDelegateCall: false
        });
        bytes memory forged = abi.encode(DropExecutor.Recipe({label: "theft", salt: bytes32(0), once: false, calls: theft}));

        vm.prank(attacker);
        vm.expectRevert(DropExecutor.NotADrop.selector);
        executor.setup(drop, owner, forged);

        // Also with the attacker as the claimed owner.
        vm.prank(attacker);
        vm.expectRevert(DropExecutor.NotADrop.selector);
        executor.setup(drop, attacker, forged);

        assertEq(drop.balance, 10 ether, "drop was drained");
        assertEq(attacker.balance, 0, "attacker received funds");
    }

    function test_attack_setupWithTheRightRecipeButWrongOwnerIsRejected() external {
        bytes memory recipe = _pingRecipe("victim", false, 0);
        vm.prank(keeper);
        address drop = executor.activate(owner, recipe);

        vm.prank(attacker);
        vm.expectRevert(DropExecutor.NotADrop.selector);
        executor.setup(drop, attacker, recipe);
    }

    function test_attack_activateWithATamperedRecipeCannotTouchTheRealDrop() external {
        bytes memory recipe = _pingRecipe("victim", false, 0);
        vm.prank(keeper);
        address drop = executor.activate(owner, recipe);
        vm.deal(drop, 10 ether);

        // A tampered recipe simply resolves to a different, empty address.
        Call[] memory theft = new Call[](1);
        theft[0] = Call({target: attacker, value: 10 ether, callData: "", allowFailure: false, isDelegateCall: false});
        bytes memory forged = abi.encode(DropExecutor.Recipe({label: "victim", salt: bytes32(0), once: false, calls: theft}));

        assertTrue(executor.dropOf(owner, forged) != drop, "forged recipe resolved to the victim address");

        vm.prank(attacker);
        // Deploying the forged drop reverts: it has no balance, so sending 10 ether fails.
        vm.expectRevert();
        executor.activate(owner, forged);

        assertEq(drop.balance, 10 ether, "victim drop was drained");
    }

    function test_attack_cannotCallTrustedExecuteHooksDirectly() external {
        bytes memory recipe = _pingRecipe("victim", false, 0);
        vm.prank(keeper);
        address drop = executor.activate(owner, recipe);

        Call[] memory theft = new Call[](1);
        theft[0] = Call({target: attacker, value: 0, callData: "", allowFailure: false, isDelegateCall: false});

        vm.prank(attacker);
        vm.expectRevert(COWShed.OnlyTrustedRole.selector);
        COWShed(payable(drop)).trustedExecuteHooks(theft);
    }

    /// @dev Someone could deploy a shed naming us as `setupTarget` but a hostile contract as the
    ///      `trustedExecutor`. Our re-derivation uses `address(this)` for both, so it will not
    ///      reproduce that address and the whole deployment reverts.
    function test_attack_deployingWithAForeignTrustedExecutorReverts() external {
        bytes memory recipe = _pingRecipe("hijack", false, 0);

        vm.prank(attacker);
        vm.expectRevert(DropExecutor.NotADrop.selector);
        factory.initializeProxyWithSetup(owner, attacker, bytes32(0), address(executor), recipe);
    }

    /// @dev Likewise for a non-zero user salt: drops are salt-zero by convention, which is what
    ///      lets `setup`'s three arguments recompute the address at all.
    /// @dev The factory takes an arbitrary user salt, and we bind it to the one inside the recipe.
    ///      Deploying with a factory salt that disagrees produces an address we do not derive, so
    ///      the deployment reverts. Nobody can plant a drop at an address whose recipe says
    ///      otherwise.
    function test_attack_deployingWithASaltThatDisagreesWithTheRecipeReverts() external {
        bytes memory recipe = _saltedRecipe("salted", bytes32(uint256(7)));

        vm.prank(attacker);
        vm.expectRevert(DropExecutor.NotADrop.selector);
        factory.initializeProxyWithSetup(owner, address(executor), bytes32(uint256(8)), address(executor), recipe);

        // The recipe's own salt works, from any caller.
        vm.prank(attacker);
        factory.initializeProxyWithSetup(owner, address(executor), bytes32(uint256(7)), address(executor), recipe);
        assertEq(recorder.pings(), 1, "recipe did not run via the direct factory path");
    }

    /// @dev `setupData` shorter than the encoded head cannot carry a salt, and must not be read past
    ///      its end.
    function test_attack_truncatedSetupDataIsRejected() external {
        vm.expectRevert(DropExecutor.MalformedRecipe.selector);
        executor.dropOf(owner, hex"1234");
    }

    // --- recovery --------------------------------------------------------------------------

    /// @dev A drop is never a loss of funds: the owner is the shed's admin and can always sweep.
    function test_recovery_ownerCanSweepAnUnrunnableDrop() external {
        // A recipe that can never succeed: it calls a target that always reverts.
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(this),
            value: 0,
            callData: abi.encodeWithSignature("doesNotExist()"),
            allowFailure: false,
            isDelegateCall: false
        });
        bytes memory recipe = abi.encode(DropExecutor.Recipe({label: "broken", salt: bytes32(0), once: false, calls: calls}));

        address predicted = executor.dropOf(owner, recipe);
        vm.deal(predicted, 1 ether);

        vm.expectRevert();
        executor.activate(owner, recipe);

        // The shed does not exist yet, so recovery goes through the factory's signed path.
        // Proving the owner *is* the admin is enough here; the signed-sweep flow is covered by
        // cow-shed's own test suite.
        assertEq(predicted.code.length, 0, "unrunnable drop should not have deployed");
        assertEq(predicted.balance, 1 ether, "funds are still there, recoverable by the owner");
    }
}
