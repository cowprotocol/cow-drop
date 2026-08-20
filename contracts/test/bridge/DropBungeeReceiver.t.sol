// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Vm} from "forge-std/Test.sol";

import {DropExecutor} from "src/DropExecutor.sol";
import {DropBungeeReceiver} from "src/bridge/DropBungeeReceiver.sol";
import {DropDelivery} from "src/bridge/DropDelivery.sol";
import {ICoWSwapOnchainOrders} from "src/interfaces/ICoWSwapOnchainOrders.sol";
import {Orders} from "src/lib/Orders.sol";
import {GuardSteps} from "src/steps/GuardSteps.sol";
import {PresignSteps} from "src/steps/PresignSteps.sol";
import {TokenSteps} from "src/steps/TokenSteps.sol";

import {Call} from "cow-shed/ICOWAuthHook.sol";
import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {MockBungeeRouter, MockReentrantERC20} from "../mocks/Mocks.sol";
import {StepsBase} from "../steps/StepsBase.sol";

/// @notice The atomic path: a bridge fills on the destination chain and the drop's order is live in
///         the same transaction.
///
/// @dev Every test goes through `MockBungeeRouter`, which transfers and then calls in one
///      transaction. That is not incidental — it is the property the "a malformed payload may safely
///      revert" argument rests on, and a test that transferred separately would prove the opposite of
///      what it claimed.
contract DropBungeeReceiverTest is StepsBase {
    DropBungeeReceiver internal receiver;
    MockBungeeRouter internal router;

    address internal constant BUNGEE_NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    function setUp() public override {
        super.setUp();
        receiver = new DropBungeeReceiver(executor);
        router = new MockBungeeRouter();
    }

    // --- helpers ---------------------------------------------------------------------------

    function _payload(bytes memory setupData, DropDelivery.OnFailure onFailure) internal view returns (bytes memory) {
        return abi.encode(owner, setupData, onFailure);
    }

    function _one(address token) internal pure returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = token;
    }

    function _one(uint256 amount) internal pure returns (uint256[] memory amounts) {
        amounts = new uint256[](1);
        amounts[0] = amount;
    }

    /// @dev `requireMinBalance` then `presignSellAll` — the shape a tranche-paying bridge needs.
    function _guardedPresignRecipe(uint256 minAmount) internal view returns (bytes memory) {
        Call[] memory calls = new Call[](2);
        calls[0] = _step(address(guards), abi.encodeCall(GuardSteps.requireMinBalance, (address(sellToken), minAmount)));
        calls[1] = _step(
            address(presign),
            abi.encodeCall(
                PresignSteps.presignSellAll,
                (address(sellToken), address(buyToken), recipient, 95, 100, 1 hours, bytes32(0))
            )
        );
        return _recipeOf("guarded bridge", false, calls);
    }

    function _assertReceiverHoldsNothing() internal view {
        assertEq(sellToken.balanceOf(address(receiver)), 0, "receiver kept tokens");
        assertEq(address(receiver).balance, 0, "receiver kept native");
    }

    // --- the happy path --------------------------------------------------------------------

    /// @dev The whole feature in one test: money arrives from a bridge and the CoW order exists,
    ///      with no keeper, no second transaction and nobody's signature.
    function test_executeData_deliversAndActivatesInOneTransaction() external {
        bytes memory recipe = _presignRecipe(95, 100);
        address drop = executor.dropOf(owner, recipe);

        uint256 arrived = 1234.5e18;
        sellToken.mint(address(router), arrived);

        vm.recordLogs();
        router.deliver(
            address(receiver),
            _one(address(sellToken)),
            _one(arrived),
            _payload(recipe, DropDelivery.OnFailure.LeaveAtDrop)
        );

        assertGt(drop.code.length, 0, "the drop was not deployed");
        assertEq(sellToken.balanceOf(drop), arrived, "the drop did not receive the delivery");
        _assertReceiverHoldsNothing();

        // The order the recipe committed to, rebuilt and checked against what was signed.
        LibCowOrder.Data memory expected = LibCowOrder.Data({
            sellToken: IERC20(address(sellToken)),
            buyToken: IERC20(address(buyToken)),
            receiver: recipient,
            sellAmount: arrived,
            buyAmount: (arrived * 95) / 100,
            validTo: uint32(block.timestamp + 1 hours),
            appData: bytes32(0),
            feeAmount: 0,
            kind: Orders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: Orders.BALANCE_ERC20,
            buyTokenBalance: Orders.BALANCE_ERC20
        });
        bytes memory uid =
            Orders.packUid(LibCowOrder.hash(expected, settlement.domainSeparator()), drop, expected.validTo);
        assertGt(settlement.preSignature(uid), 0, "the order was not pre-signed");
        assertEq(settlement.signerOf(keccak256(uid)), drop, "the drop is not the signer");

        // And the log a poster keys off is emitted by the drop, exactly as on the keeper path — the
        // watch tower must not be able to tell the two apart.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool placed;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == ICoWSwapOnchainOrders.OrderPlacement.selector) {
                assertEq(logs[i].emitter, drop, "OrderPlacement not emitted by the drop");
                placed = true;
            }
        }
        assertTrue(placed, "OrderPlacement not emitted");
    }

    function test_executeData_announcesTheDelivery() external {
        bytes memory recipe = _presignRecipe(95, 100);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(address(router), 100e18);

        vm.expectEmit(true, true, false, true, address(receiver));
        emit DropDelivery.DropDelivered(drop, owner, true);

        router.deliver(
            address(receiver),
            _one(address(sellToken)),
            _one(100e18),
            _payload(recipe, DropDelivery.OnFailure.LeaveAtDrop)
        );
    }

    /// @dev The reason `amounts` is ignored. A route that over-delivers, a fee-on-transfer token, or
    ///      dust another delivery left behind must all end up at the drop rather than sitting in a
    ///      contract anyone can sweep — so what moves is the balance held, not the balance claimed.
    function test_executeData_forwardsTheBalanceHeldRatherThanTheAmountReported() external {
        bytes memory recipe = _presignRecipe(95, 100);
        address drop = executor.dropOf(owner, recipe);

        // 250 arrives out of band — a route that sent more than it declared, or a remainder somebody
        // else left here. The bridge then declares, and delivers, 250 of its own.
        sellToken.mint(address(receiver), 250e18);
        sellToken.mint(address(router), 250e18);

        router.deliver(
            address(receiver),
            _one(address(sellToken)),
            _one(250e18),
            _payload(recipe, DropDelivery.OnFailure.LeaveAtDrop)
        );

        assertEq(sellToken.balanceOf(drop), 500e18, "the drop did not receive everything held");
        _assertReceiverHoldsNothing();
    }

    // --- when the recipe declines ----------------------------------------------------------

    /// @dev The tranche case, which is the one this design exists for. The guard refuses, the bridge
    ///      fill still succeeds, and the money waits at the drop for the rest to arrive.
    function test_executeData_leavesTokensAtTheDropWhenAGuardDeclines() external {
        bytes memory recipe = _guardedPresignRecipe(1000e18);
        address drop = executor.dropOf(owner, recipe);

        sellToken.mint(address(router), 250e18);

        vm.expectEmit(true, true, false, true, address(receiver));
        emit DropDelivery.DropDelivered(drop, owner, false);

        router.deliver(
            address(receiver),
            _one(address(sellToken)),
            _one(250e18),
            _payload(recipe, DropDelivery.OnFailure.LeaveAtDrop)
        );

        assertEq(sellToken.balanceOf(drop), 250e18, "the first tranche did not reach the drop");
        assertEq(drop.code.length, 0, "the drop was deployed by a declined activation");
        _assertReceiverHoldsNothing();

        // The second tranche lands and a keeper finishes the job — the ordinary path, unchanged.
        sellToken.mint(address(router), 750e18);
        router.deliver(
            address(receiver),
            _one(address(sellToken)),
            _one(750e18),
            _payload(recipe, DropDelivery.OnFailure.LeaveAtDrop)
        );

        assertGt(drop.code.length, 0, "the full delivery did not activate");
        assertEq(sellToken.balanceOf(drop), 1000e18, "the drop does not hold both tranches");
    }

    function test_executeData_refundsTheOwnerWhenTheRecipeCannotRun() external {
        bytes memory recipe = _guardedPresignRecipe(1000e18);
        address drop = executor.dropOf(owner, recipe);

        sellToken.mint(address(router), 250e18);

        vm.expectEmit(true, true, false, true, address(receiver));
        emit DropDelivery.DropRefunded(drop, owner);

        router.deliver(
            address(receiver),
            _one(address(sellToken)),
            _one(250e18),
            _payload(recipe, DropDelivery.OnFailure.RefundOwner)
        );

        assertEq(sellToken.balanceOf(owner), 250e18, "the owner was not refunded");
        assertEq(sellToken.balanceOf(drop), 0, "the drop kept a refunded delivery");
        _assertReceiverHoldsNothing();
    }

    /// @dev A `once` recipe that has already run is the other way an activation legitimately refuses.
    function test_executeData_leavesTokensAtTheDropWhenAOnceRecipeIsSpent() external {
        Call[] memory calls = new Call[](1);
        calls[0] = _step(
            address(presign),
            abi.encodeCall(
                PresignSteps.presignSellAll,
                (address(sellToken), address(buyToken), recipient, 95, 100, 1 hours, bytes32(0))
            )
        );
        bytes memory recipe = _recipeOf("once", true, calls);
        address drop = executor.dropOf(owner, recipe);

        sellToken.mint(drop, 100e18);
        vm.prank(keeper);
        executor.activate(owner, recipe);
        assertTrue(executor.consumed(drop), "the run was not spent");

        // A later bridge arrival cannot re-run it, and must not be lost because of that.
        sellToken.mint(address(router), 50e18);
        router.deliver(
            address(receiver),
            _one(address(sellToken)),
            _one(50e18),
            _payload(recipe, DropDelivery.OnFailure.LeaveAtDrop)
        );

        assertEq(sellToken.balanceOf(drop), 150e18, "the late arrival did not reach the drop");
        _assertReceiverHoldsNothing();
    }

    // --- native ----------------------------------------------------------------------------

    /// @dev Native is swept whether or not the sentinel is named, and lands at an address that does
    ///      not exist yet — which the activation then deploys straight over.
    function test_executeData_deliversNativeToACounterfactualDrop() external {
        bytes memory recipe =
            _recipe("native", address(tokenOps), abi.encodeCall(TokenSteps.sweep, (address(0), recipient)));
        address drop = executor.dropOf(owner, recipe);

        vm.deal(address(router), 3 ether);
        router.deliver{value: 3 ether}(
            address(receiver), _one(BUNGEE_NATIVE), _one(3 ether), _payload(recipe, DropDelivery.OnFailure.LeaveAtDrop)
        );

        assertGt(drop.code.length, 0, "the drop was not deployed over its native balance");
        assertEq(recipient.balance, 3 ether, "the native delivery did not reach the recipe");
        _assertReceiverHoldsNothing();
    }

    // --- payloads that are simply wrong ------------------------------------------------------

    /// @dev The claim the whole "reverting is safe" argument rests on: the bridge's transfer and its
    ///      call are one transaction, so a rejected payload leaves the tokens with the bridge rather
    ///      than stranded in a contract anyone can sweep.
    function test_executeData_revertsTheBridgeTransferOnAMalformedRecipe() external {
        sellToken.mint(address(router), 100e18);

        vm.expectRevert(DropExecutor.MalformedRecipe.selector);
        router.deliver(
            address(receiver),
            _one(address(sellToken)),
            _one(100e18),
            _payload(hex"1234", DropDelivery.OnFailure.LeaveAtDrop)
        );

        assertEq(sellToken.balanceOf(address(router)), 100e18, "the bridge's transfer was not rolled back");
        _assertReceiverHoldsNothing();
    }

    /// @dev `owner == address(0)` is a real recipe option — a drop nobody can interfere with — but it
    ///      has no refund address, so pairing it with `RefundOwner` would burn the delivery. Rejected
    ///      up front rather than in the branch that would do the burning.
    function test_executeData_refusesARefundWithNoOwnerToRefund() external {
        bytes memory recipe = _presignRecipe(95, 100);
        sellToken.mint(address(router), 100e18);

        vm.expectRevert(DropDelivery.NoRefundAddress.selector);
        router.deliver(
            address(receiver),
            _one(address(sellToken)),
            _one(100e18),
            abi.encode(address(0), recipe, DropDelivery.OnFailure.RefundOwner)
        );

        assertEq(sellToken.balanceOf(address(router)), 100e18, "the bridge's transfer was not rolled back");
    }

    /// @dev The one moment a pass-through is genuinely holding funds: part-way through forwarding a
    ///      multi-token delivery. A hostile token delivered alongside a real one gets a transfer hook
    ///      there, and without the guard it could redirect everything not yet sent into a drop of its
    ///      own choosing.
    function test_executeData_cannotBeReenteredWhileHoldingTheRestOfADelivery() external {
        bytes memory recipe = _presignRecipe(95, 100);
        address drop = executor.dropOf(owner, recipe);

        MockReentrantERC20 hostile = new MockReentrantERC20();

        // The attacker's own drop, which the reentrant call tries to divert the delivery into.
        address attacker = makeAddr("attacker");
        bytes memory attackRecipe =
            _recipe("attack", address(tokenOps), abi.encodeCall(TokenSteps.sweep, (address(hostile), attacker)));
        address attackerDrop = executor.dropOf(attacker, attackRecipe);
        hostile.arm(address(receiver), abi.encode(attacker, attackRecipe, DropDelivery.OnFailure.LeaveAtDrop));

        // Two tokens in one delivery: the hostile one moves first and re-enters mid-forward.
        address[] memory tokens = new address[](2);
        tokens[0] = address(hostile);
        tokens[1] = address(sellToken);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 10e18;
        amounts[1] = 100e18;

        hostile.mint(address(router), 10e18);
        sellToken.mint(address(router), 100e18);

        router.deliver(address(receiver), tokens, amounts, _payload(recipe, DropDelivery.OnFailure.LeaveAtDrop));

        assertTrue(hostile.reentryReverted(), "the reentrant delivery was not rejected");
        assertEq(sellToken.balanceOf(attackerDrop), 0, "the attacker diverted the rest of the delivery");
        assertEq(sellToken.balanceOf(drop), 100e18, "the honest delivery did not complete");
        _assertReceiverHoldsNothing();
    }

    // --- gas -------------------------------------------------------------------------------

    /// @dev Destination gas is *prepaid* on the source chain: the quote names a limit, the user pays
    ///      for it, and a relayer that runs out mid-delivery fails the fill. So this is not a
    ///      micro-optimisation guard — it is the number `getDestinationGasLimit` has to be at least as
    ///      large as, and a silent growth past the quoted limit would break deliveries in flight.
    ///
    ///      Measured on the worst path: a drop that does not exist yet, so the cost includes the
    ///      CREATE2 proxy deployment and its initialisation as well as the order.
    ///
    ///      The bound has generous headroom over the measured cost — this exists to catch a step
    ///      change, not to be re-baselined on every refactor.
    function test_gas_aFirstDeliveryFitsInTheQuotedLimit() external {
        bytes memory recipe = _presignRecipe(95, 100);
        bytes memory payload = _payload(recipe, DropDelivery.OnFailure.LeaveAtDrop);
        address[] memory tokens = _one(address(sellToken));
        uint256[] memory amounts = _one(100e18);

        // The bridge's own transfer, done here so the measurement covers `executeData` alone.
        sellToken.mint(address(receiver), 100e18);

        uint256 before = gasleft();
        receiver.executeData(keccak256("request"), amounts, tokens, payload);
        uint256 used = before - gasleft();

        emit log_named_uint("executeData gas (first delivery, deploys the drop)", used);
        assertLt(used, 600_000, "delivery no longer fits the quoted destination gas limit");
    }

    function test_deliverAndActivate_rejectsADirectCaller() external {
        bytes memory recipe = _presignRecipe(95, 100);

        vm.prank(keeper);
        vm.expectRevert(DropDelivery.NotSelf.selector);
        receiver.deliverAndActivate(owner, recipe, _one(address(sellToken)));
    }
}
