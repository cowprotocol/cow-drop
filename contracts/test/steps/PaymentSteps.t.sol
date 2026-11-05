// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Vm} from "forge-std/Test.sol";

import {ICoWSwapOnchainOrders} from "src/interfaces/ICoWSwapOnchainOrders.sol";
import {NothingToSell} from "src/lib/Errors.sol";
import {Orders} from "src/lib/Orders.sol";
import {PaymentSteps} from "src/steps/PaymentSteps.sol";

import {Call} from "cow-shed/ICOWAuthHook.sol";
import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {MockERC20} from "../mocks/Mocks.sol";
import {StepsBase} from "./StepsBase.sol";

contract PaymentStepsTest is StepsBase {
    uint256 internal constant PRICE = 100e18;

    function _paymentRecipe(bytes32 label, address receiver_, uint256 price) internal view returns (bytes memory) {
        return _recipe(
            label,
            address(payments),
            abi.encodeCall(PaymentSteps.presignPayment, (address(buyToken), price, receiver_, 1 hours, bytes32(0)))
        );
    }

    function _expected(address token, uint256 sellAmount) internal view returns (LibCowOrder.Data memory) {
        return LibCowOrder.Data({
            sellToken: IERC20(token),
            buyToken: IERC20(address(buyToken)),
            receiver: owner,
            sellAmount: sellAmount,
            buyAmount: PRICE,
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

    function test_activatePayment_sellsTheChosenTokenForAtLeastTheCommittedPrice() external {
        bytes memory recipe = _paymentRecipe("pay", owner, PRICE);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 123.4e18);

        vm.prank(keeper);
        address activated = payments.activatePayment(owner, recipe, address(sellToken));
        assertEq(activated, drop, "returned the wrong drop");

        bytes memory uid = _uid(_expected(address(sellToken), 123.4e18), drop);
        assertGt(settlement.preSignature(uid), 0, "order was not pre-signed");
        assertEq(settlement.signerOf(keccak256(uid)), drop, "the drop is not the signer");
        assertEq(sellToken.allowance(drop, VAULT_RELAYER), type(uint256).max, "relayer not approved");
    }

    function test_activatePayment_acceptsAnyTokenWithoutChangingTheAddress() external {
        bytes memory recipe = _paymentRecipe("pay", owner, PRICE);
        address drop = executor.dropOf(owner, recipe);
        MockERC20 other = new MockERC20();
        other.mint(drop, 7e6);

        vm.prank(keeper);
        payments.activatePayment(owner, recipe, address(other));

        assertGt(settlement.preSignature(_uid(_expected(address(other), 7e6), drop)), 0, "order was not pre-signed");
    }

    function test_activatePayment_emitsOrderPlacementFromTheDrop() external {
        bytes memory recipe = _paymentRecipe("pay", owner, PRICE);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 150e18);

        vm.recordLogs();
        vm.prank(keeper);
        payments.activatePayment(owner, recipe, address(sellToken));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] != ICoWSwapOnchainOrders.OrderPlacement.selector) continue;
            assertEq(logs[i].emitter, drop, "OrderPlacement not emitted by the drop");
            (LibCowOrder.Data memory order,,) =
                abi.decode(logs[i].data, (LibCowOrder.Data, ICoWSwapOnchainOrders.OnchainSignature, bytes));
            assertEq(address(order.sellToken), address(sellToken), "wrong sell token");
            assertEq(order.sellAmount, 150e18, "sell amount is not the balance");
            assertEq(order.buyAmount, PRICE, "buy amount is not the committed price");
            assertEq(order.receiver, owner, "receiver is not the owner");
            assertEq(order.kind, Orders.KIND_SELL, "not a sell order");
            found = true;
        }
        assertTrue(found, "OrderPlacement not emitted");
    }

    function test_plainActivate_revertsWithoutAPaymentToken() external {
        bytes memory recipe = _paymentRecipe("pay", owner, PRICE);
        sellToken.mint(executor.dropOf(owner, recipe), 150e18);

        vm.prank(keeper);
        vm.expectRevert(PaymentSteps.NoPaymentToken.selector);
        executor.activate(owner, recipe);
    }

    function test_activatePayment_rejectsTheZeroToken() external {
        bytes memory recipe = _paymentRecipe("pay", owner, PRICE);
        vm.expectRevert(PaymentSteps.NoPaymentToken.selector);
        payments.activatePayment(owner, recipe, address(0));
    }

    function test_activatePayment_revertsWhenNothingArrived() external {
        bytes memory recipe = _paymentRecipe("pay", owner, PRICE);
        vm.prank(keeper);
        vm.expectRevert(NothingToSell.selector);
        payments.activatePayment(owner, recipe, address(sellToken));
    }

    function test_payingInTheBuyTokenForwardsItWithoutAnOrder() external {
        bytes memory recipe = _paymentRecipe("pay", owner, PRICE);
        address drop = executor.dropOf(owner, recipe);
        buyToken.mint(drop, 101e18);

        vm.recordLogs();
        vm.prank(keeper);
        payments.activatePayment(owner, recipe, address(buyToken));

        assertEq(buyToken.balanceOf(owner), 101e18, "payment not forwarded");
        assertEq(buyToken.balanceOf(drop), 0, "drop kept the payment");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != ICoWSwapOnchainOrders.OrderPlacement.selector, "placed an order");
        }
    }

    function test_theInputIsClearedAfterActivation() external {
        bytes memory recipe = _paymentRecipe("pay", owner, PRICE);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 150e18);

        payments.activatePayment(owner, recipe, address(sellToken));
        assertEq(payments.paymentToken(drop), address(0), "input survived the activation");

        // A second payment in the same transaction must name its token again, not inherit one.
        sellToken.mint(drop, 150e18);
        vm.expectRevert(PaymentSteps.NoPaymentToken.selector);
        executor.activate(owner, recipe);
    }

    /// @dev The input is keyed by drop: a payment drop activated from inside another drop's activation
    ///      must not see the token the outer activation named.
    function test_theInputIsScopedToTheDrop() external {
        bytes memory other = _paymentRecipe("other", owner, PRICE);
        address otherDrop = executor.dropOf(owner, other);
        sellToken.mint(otherDrop, 150e18);

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(executor),
            value: 0,
            callData: abi.encodeCall(executor.activate, (owner, other)),
            allowFailure: false,
            isDelegateCall: false
        });
        bytes memory outer = _recipeOf("outer", false, calls);

        vm.expectRevert(PaymentSteps.NoPaymentToken.selector);
        payments.activatePayment(owner, outer, address(sellToken));
    }

    function test_rejectsAZeroPrice() external {
        bytes memory recipe = _paymentRecipe("pay", owner, 0);
        sellToken.mint(executor.dropOf(owner, recipe), 1e18);
        vm.expectRevert(PaymentSteps.ZeroBuyAmount.selector);
        payments.activatePayment(owner, recipe, address(sellToken));
    }

    function test_rejectsAZeroReceiver() external {
        bytes memory recipe = _paymentRecipe("pay", address(0), PRICE);
        sellToken.mint(executor.dropOf(owner, recipe), 1e18);
        vm.expectRevert(PaymentSteps.InvalidRecipient.selector);
        payments.activatePayment(owner, recipe, address(sellToken));
    }
}
