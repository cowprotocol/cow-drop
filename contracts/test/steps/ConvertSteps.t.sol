// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Vm} from "forge-std/Test.sol";

import {ICoWSwapOnchainOrders} from "src/interfaces/ICoWSwapOnchainOrders.sol";
import {NothingToSell} from "src/lib/Errors.sol";
import {Orders} from "src/lib/Orders.sol";
import {ConvertSteps} from "src/steps/ConvertSteps.sol";

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {MockERC20} from "../mocks/Mocks.sol";
import {StepsBase} from "./StepsBase.sol";

/// @notice A reusable address whose price comes from the activator, not the recipe. With no committed
///         price, who may activate is the whole security story — hence the weight on the gate.
contract ConvertStepsTest is StepsBase {
    /// @dev `keeper` and `owner` come from the base harness; a zero `pricer` opens the drop.
    function _convertRecipe(address pricer, address receiver_) internal view returns (bytes memory) {
        return _recipe(
            "convert",
            address(converts),
            abi.encodeCall(
                ConvertSteps.presignConvert, (address(buyToken), receiver_, owner, pricer, 1 hours, bytes32(0))
            )
        );
    }

    function _expected(address token, uint256 sellAmount, uint256 minBuyAmount)
        internal
        view
        returns (LibCowOrder.Data memory)
    {
        return LibCowOrder.Data({
            sellToken: IERC20(token),
            buyToken: IERC20(address(buyToken)),
            receiver: owner,
            sellAmount: sellAmount,
            buyAmount: minBuyAmount,
            validTo: uint32(block.timestamp + 1 hours),
            appData: bytes32(0),
            feeAmount: 0,
            kind: Orders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: Orders.BALANCE_ERC20,
            buyTokenBalance: Orders.BALANCE_ERC20 // gitleaks:allow (balance-kind constant, not a secret)
        });
    }

    function _uid(LibCowOrder.Data memory order, address drop) internal view returns (bytes memory) {
        return Orders.packUid(LibCowOrder.hash(order, settlement.domainSeparator()), drop, order.validTo);
    }

    // --- the happy path ----------------------------------------------------------------------

    function test_thePricerSetsTheMinimumForThisActivation() external {
        bytes memory recipe = _convertRecipe(keeper, owner);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 10e18);

        vm.prank(keeper);
        address activated = converts.activateConvert(owner, recipe, address(sellToken), 950e18);
        assertEq(activated, drop, "returned the wrong drop");

        bytes memory uid = _uid(_expected(address(sellToken), 10e18, 950e18), drop);
        assertGt(settlement.preSignature(uid), 0, "order was not pre-signed");
        assertEq(settlement.signerOf(keccak256(uid)), drop, "the drop is not the signer");
        assertEq(sellToken.allowance(drop, VAULT_RELAYER), type(uint256).max, "relayer not approved");
    }

    /// @dev The point of it: one address, reused, priced afresh each time.
    function test_theSameDropPricesEachArrivalSeparately() external {
        bytes memory recipe = _convertRecipe(keeper, owner);
        address drop = executor.dropOf(owner, recipe);

        sellToken.mint(drop, 10e18);
        vm.prank(keeper);
        converts.activateConvert(owner, recipe, address(sellToken), 950e18);

        // A second arrival, at a moved market.
        sellToken.mint(drop, 5e18);
        vm.prank(keeper);
        converts.activateConvert(owner, recipe, address(sellToken), 400e18);

        assertGt(
            settlement.preSignature(_uid(_expected(address(sellToken), 15e18, 400e18), drop)),
            0,
            "the second order should carry its own price"
        );
    }

    function test_anyArrivingTokenConvertsWithoutMovingTheAddress() external {
        bytes memory recipe = _convertRecipe(keeper, owner);
        address drop = executor.dropOf(owner, recipe);

        MockERC20 other = new MockERC20();
        other.mint(drop, 7e6);

        vm.prank(keeper);
        converts.activateConvert(owner, recipe, address(other), 100e18);

        assertEq(executor.dropOf(owner, recipe), drop, "the address must not depend on what arrived");
        assertGt(
            settlement.preSignature(_uid(_expected(address(other), 7e6, 100e18), drop)), 0, "order was not pre-signed"
        );
    }

    function test_emitsOrderPlacementFromTheDrop() external {
        bytes memory recipe = _convertRecipe(keeper, owner);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 150e18);

        vm.recordLogs();
        vm.prank(keeper);
        converts.activateConvert(owner, recipe, address(sellToken), 42e18);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] != ICoWSwapOnchainOrders.OrderPlacement.selector) continue;
            assertEq(logs[i].emitter, drop, "OrderPlacement not emitted by the drop");
            (LibCowOrder.Data memory order,,) =
                abi.decode(logs[i].data, (LibCowOrder.Data, ICoWSwapOnchainOrders.OnchainSignature, bytes));
            assertEq(order.sellAmount, 150e18, "sell amount is not the balance");
            assertEq(order.buyAmount, 42e18, "buy amount is not the pricer's minimum");
            assertEq(order.receiver, owner, "receiver is not the committed one");
            assertEq(order.kind, Orders.KIND_SELL, "not a sell order");
            found = true;
        }
        assertTrue(found, "OrderPlacement not emitted");
    }

    // --- the gate ----------------------------------------------------------------------------

    /// @dev The attack the pricer exists to stop.
    function test_aStrangerCannotActivateAtAnyPrice() external {
        bytes memory recipe = _convertRecipe(keeper, owner);
        sellToken.mint(executor.dropOf(owner, recipe), 10e18);

        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ConvertSteps.NotThePricer.selector, attacker, keeper));
        converts.activateConvert(owner, recipe, address(sellToken), 1);
    }

    /// @dev The realistic attempt: the attacker holds the public recipe and calls the executor.
    function test_plainActivateIsRefused() external {
        bytes memory recipe = _convertRecipe(keeper, owner);
        sellToken.mint(executor.dropOf(owner, recipe), 10e18);

        vm.expectRevert(abi.encodeWithSelector(ConvertSteps.NotThePricer.selector, address(0), keeper));
        executor.activate(owner, recipe);
    }

    /// @dev Admitted too, so a dead pricer cannot strand them.
    function test_theOwnerMayAlsoActivate() external {
        bytes memory recipe = _convertRecipe(keeper, owner);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 10e18);

        vm.prank(owner);
        converts.activateConvert(owner, recipe, address(sellToken), 900e18);

        assertGt(
            settlement.preSignature(_uid(_expected(address(sellToken), 10e18, 900e18), drop)),
            0,
            "the owner's activation should price the order"
        );
    }

    /// @dev Two drops in one transaction must not read each other's input.
    function test_theInputIsScopedToTheDrop() external {
        address otherPricer = makeAddr("other-pricer");
        bytes memory theirs = _convertRecipe(otherPricer, owner);
        sellToken.mint(executor.dropOf(owner, theirs), 10e18);

        // `keeper` prices a different recipe, so this drop's slot holds nothing for them.
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ConvertSteps.NotThePricer.selector, keeper, otherPricer));
        converts.activateConvert(owner, theirs, address(sellToken), 950e18);
    }

    function test_theInputIsClearedAfterActivation() external {
        bytes memory recipe = _convertRecipe(keeper, owner);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 10e18);

        vm.prank(keeper);
        converts.activateConvert(owner, recipe, address(sellToken), 950e18);

        (address token, uint256 amount, address activator) = converts.pendingInput(drop);
        assertEq(token, address(0), "sell token should be cleared");
        assertEq(amount, 0, "minimum should be cleared");
        assertEq(activator, address(0), "activator should be cleared");
    }

    // --- refusals ----------------------------------------------------------------------------

    function test_rejectsAZeroMinimum() external {
        bytes memory recipe = _convertRecipe(keeper, owner);
        sellToken.mint(executor.dropOf(owner, recipe), 10e18);

        vm.prank(keeper);
        vm.expectRevert(ConvertSteps.ZeroBuyAmount.selector);
        converts.activateConvert(owner, recipe, address(sellToken), 0);
    }

    function test_rejectsTheZeroSellToken() external {
        bytes memory recipe = _convertRecipe(keeper, owner);
        vm.prank(keeper);
        vm.expectRevert(ConvertSteps.NoSellToken.selector);
        converts.activateConvert(owner, recipe, address(0), 1e18);
    }

    // --- the open mode ------------------------------------------------------------------------

    /// @dev The deliberate opt-out: anybody activates, anybody names the minimum.
    function test_aZeroPricerLetsAnyoneActivate() external {
        bytes memory recipe = _convertRecipe(address(0), owner);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 10e18);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        converts.activateConvert(owner, recipe, address(sellToken), 1);

        assertGt(
            settlement.preSignature(_uid(_expected(address(sellToken), 10e18, 1), drop)),
            0,
            "an open drop accepts any activator's minimum, one atom included"
        );
    }

    /// @dev Even open, no order can have no minimum.
    function test_anOpenDropStillRefusesAZeroMinimum() external {
        bytes memory recipe = _convertRecipe(address(0), owner);
        sellToken.mint(executor.dropOf(owner, recipe), 10e18);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(ConvertSteps.ZeroBuyAmount.selector);
        converts.activateConvert(owner, recipe, address(sellToken), 0);
    }

    /// @dev A plain `activate` records no minimum, so it cannot slip past an open gate either.
    function test_plainActivateIsRefusedOnAnOpenDropToo() external {
        bytes memory recipe = _convertRecipe(address(0), owner);
        sellToken.mint(executor.dropOf(owner, recipe), 10e18);

        vm.expectRevert(ConvertSteps.ZeroBuyAmount.selector);
        executor.activate(owner, recipe);
    }

    function test_rejectsAZeroReceiver() external {
        bytes memory recipe = _convertRecipe(keeper, address(0));
        sellToken.mint(executor.dropOf(owner, recipe), 10e18);

        vm.prank(keeper);
        vm.expectRevert(ConvertSteps.InvalidRecipient.selector);
        converts.activateConvert(owner, recipe, address(sellToken), 1e18);
    }

    function test_revertsWhenNothingArrived() external {
        bytes memory recipe = _convertRecipe(keeper, owner);
        vm.prank(keeper);
        vm.expectRevert(NothingToSell.selector);
        converts.activateConvert(owner, recipe, address(sellToken), 1e18);
    }

    /// @dev Already in the buy token: forwarded, not traded.
    function test_arrivingInTheBuyTokenIsForwardedWithoutAnOrder() external {
        bytes memory recipe = _convertRecipe(keeper, owner);
        address drop = executor.dropOf(owner, recipe);
        buyToken.mint(drop, 3e18);

        vm.prank(keeper);
        converts.activateConvert(owner, recipe, address(buyToken), 1e18);

        assertEq(buyToken.balanceOf(owner), 3e18, "the receiver should simply get it");
        assertEq(buyToken.balanceOf(drop), 0, "nothing should be left behind");
    }
}
