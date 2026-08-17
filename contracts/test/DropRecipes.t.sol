// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Test, Vm} from "forge-std/Test.sol";

import {DropExecutor} from "src/DropExecutor.sol";
import {DropOrders} from "src/DropOrders.sol";
import {DropRecipes} from "src/DropRecipes.sol";
import {IComposableCowLike, ISettlementLike} from "src/interfaces/IDropExternal.sol";

import {COWShed} from "cow-shed/COWShed.sol";
import {COWShedExecutorFactory} from "cow-shed/COWShedExecutorFactory.sol";
import {Call} from "cow-shed/ICOWAuthHook.sol";
import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {MockComposableCow, MockERC20, MockSettlement, MockWrappedNative} from "./mocks/Mocks.sol";

/// @dev Exercises the recipe primitives the way they actually run: delegatecalled from inside a
///      drop, triggered by an activation that nobody signed.
contract DropRecipesTest is Test {
    COWShedExecutorFactory internal factory;
    DropExecutor internal executor;
    DropRecipes internal recipes;

    MockSettlement internal settlement;
    MockComposableCow internal composableCow;
    MockERC20 internal sellToken;
    MockERC20 internal buyToken;
    MockWrappedNative internal wrappedNative;

    address internal constant VAULT_RELAYER = address(0xC92E);
    address internal constant TWAP_HANDLER = address(0x7A9F);
    address internal constant TIMESTAMP_FACTORY = address(0x715);

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal recipient = makeAddr("recipient");

    function setUp() public {
        factory = new COWShedExecutorFactory(address(new COWShed()));
        executor = new DropExecutor(factory);

        settlement = new MockSettlement(keccak256("domain"));
        composableCow = new MockComposableCow(keccak256("ccow-domain"));
        sellToken = new MockERC20();
        buyToken = new MockERC20();
        wrappedNative = new MockWrappedNative();

        recipes = new DropRecipes(
            ISettlementLike(address(settlement)),
            VAULT_RELAYER,
            IComposableCowLike(address(composableCow)),
            TWAP_HANDLER,
            TIMESTAMP_FACTORY
        );

        // Timestamps below uint32 max, so `validTo` arithmetic is meaningful.
        vm.warp(1_800_000_000);
    }

    // --- helpers ---------------------------------------------------------------------------

    /// @dev Wraps one delegatecall into the recipe primitives as a complete recipe.
    function _recipe(bytes32 label, bytes memory callData) internal view returns (bytes memory) {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            target: address(recipes),
            value: 0,
            callData: callData,
            allowFailure: false,
            isDelegateCall: true
        });
        return abi.encode(DropExecutor.Recipe({label: label, salt: bytes32(0), once: false, calls: calls}));
    }

    function _presignRecipe(uint256 limitNum, uint256 limitDen) internal view returns (bytes memory) {
        return _recipe(
            "presign",
            abi.encodeCall(
                DropRecipes.presignSellAll,
                (address(sellToken), address(buyToken), recipient, limitNum, limitDen, 1 hours, bytes32(0))
            )
        );
    }

    function _twapRecipe(uint256 n, uint256 t) internal view returns (bytes memory) {
        return _recipe(
            "twap",
            abi.encodeCall(
                DropRecipes.twapFromBalance,
                (address(sellToken), address(buyToken), address(0), n, t, 0, 95, 100, bytes32(0), bytes32(0))
            )
        );
    }

    // --- path P: pre-sign -------------------------------------------------------------------

    function test_presignSellAll_signsAnOrderForWhateverArrived() external {
        bytes memory recipe = _presignRecipe(95, 100);
        address drop = executor.dropOf(owner, recipe);

        // An arbitrary amount lands at the drop — the recipe never committed to a number.
        sellToken.mint(drop, 1234.5e18);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        uint256 arrived = 1234.5e18;
        LibCowOrder.Data memory expected = LibCowOrder.Data({
            sellToken: IERC20(address(sellToken)),
            buyToken: IERC20(address(buyToken)),
            receiver: recipient,
            sellAmount: arrived,
            buyAmount: (arrived * 95) / 100,
            validTo: uint32(block.timestamp + 1 hours),
            appData: bytes32(0),
            feeAmount: 0,
            kind: DropOrders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: DropOrders.BALANCE_ERC20,
            buyTokenBalance: DropOrders.BALANCE_ERC20
        });
        bytes32 digest = LibCowOrder.hash(expected, settlement.domainSeparator());
        bytes memory uid = DropOrders.packUid(digest, drop, expected.validTo);

        assertGt(settlement.preSignature(uid), 0, "order was not pre-signed");
        assertEq(settlement.signerOf(keccak256(uid)), drop, "the drop is not the signer");
        assertEq(sellToken.allowance(drop, VAULT_RELAYER), type(uint256).max, "relayer not approved");
    }

    function test_presignSellAll_emitsTheOrderFromTheDropAddress() external {
        bytes memory recipe = _presignRecipe(95, 100);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 100e18);

        vm.recordLogs();
        vm.prank(keeper);
        executor.activate(owner, recipe);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == DropRecipes.DropOrderPlaced.selector) {
                // The poster keys off this: the log's emitter must be the drop, not the helper.
                assertEq(logs[i].emitter, drop, "DropOrderPlaced not emitted by the drop");
                found = true;
            }
        }
        assertTrue(found, "DropOrderPlaced not emitted");
    }

    function test_presignSellAll_revertsWhenNothingArrived() external {
        bytes memory recipe = _presignRecipe(95, 100);

        vm.prank(keeper);
        vm.expectRevert(DropRecipes.NothingToSell.selector);
        executor.activate(owner, recipe);
    }

    function test_presignSellAll_revertsOnAPriceThatRoundsToZero() external {
        bytes memory recipe = _presignRecipe(1, 1e30);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 1e6);

        vm.prank(keeper);
        vm.expectRevert(DropOrders.LimitPriceTooLow.selector);
        executor.activate(owner, recipe);
    }

    // --- path C: composable -----------------------------------------------------------------

    function test_twapFromBalance_splitsWhateverArrivedIntoParts() external {
        bytes memory recipe = _twapRecipe(12, 1 hours);
        address drop = executor.dropOf(owner, recipe);

        // Deliberately not divisible by 12, as a real bridge payout would not be.
        uint256 arrived = 1000e18 + 7;
        sellToken.mint(drop, arrived);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        uint256 part = arrived / 12;
        DropRecipes.TwapData memory expected = DropRecipes.TwapData({
            sellToken: address(sellToken),
            buyToken: address(buyToken),
            receiver: address(0),
            partSellAmount: part,
            minPartLimit: (part * 95) / 100,
            t0: 0,
            n: 12,
            t: 1 hours,
            span: 0,
            appData: bytes32(0)
        });
        bytes32 paramsHash = keccak256(
            abi.encode(
                IConditionalOrderParams({handler: TWAP_HANDLER, salt: bytes32(0), staticInput: abi.encode(expected)})
            )
        );

        assertTrue(composableCow.singleOrders(drop, paramsHash), "conditional order not registered for the drop");
        assertEq(composableCow.lastValueFactory(), TIMESTAMP_FACTORY, "start time not seeded from the value factory");
        assertTrue(composableCow.lastDispatch(), "dispatch must be true so the watch tower sees it");
        assertEq(
            uint256(composableCow.cabinet(drop, paramsHash)), block.timestamp, "cabinet not seeded with the start time"
        );
        assertEq(sellToken.allowance(drop, VAULT_RELAYER), type(uint256).max, "relayer not approved");
    }

    function test_twapFromBalance_keepsParamsOwnerIndependent() external {
        // The same recipe run by two different owners must produce byte-identical params: that is
        // what makes the address a commitment to the recipe rather than a cycle.
        bytes memory recipe = _twapRecipe(4, 1 hours);

        address dropA = executor.dropOf(owner, recipe);
        address dropB = executor.dropOf(keeper, recipe);
        sellToken.mint(dropA, 400e18);
        sellToken.mint(dropB, 400e18);

        executor.activate(owner, recipe);
        executor.activate(keeper, recipe);

        DropRecipes.TwapData memory expected = DropRecipes.TwapData({
            sellToken: address(sellToken),
            buyToken: address(buyToken),
            receiver: address(0),
            partSellAmount: 100e18,
            minPartLimit: 95e18,
            t0: 0,
            n: 4,
            t: 1 hours,
            span: 0,
            appData: bytes32(0)
        });
        bytes32 paramsHash = keccak256(
            abi.encode(
                IConditionalOrderParams({handler: TWAP_HANDLER, salt: bytes32(0), staticInput: abi.encode(expected)})
            )
        );

        assertTrue(composableCow.singleOrders(dropA, paramsHash), "owner A");
        assertTrue(composableCow.singleOrders(dropB, paramsHash), "owner B");
    }

    function test_twapFromBalance_rejectsASinglePart() external {
        bytes memory recipe = _twapRecipe(1, 1 hours);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 100e18);

        vm.expectRevert(DropRecipes.TooFewParts.selector);
        executor.activate(owner, recipe);
    }

    function test_twapFromBalance_revertsWhenPartsWouldBeZero() external {
        bytes memory recipe = _twapRecipe(12, 1 hours);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 5); // fewer wei than parts

        vm.expectRevert(DropRecipes.NothingToSell.selector);
        executor.activate(owner, recipe);
    }

    // --- guards -----------------------------------------------------------------------------

    /// @dev The point of the guard: a one-shot recipe cannot be spent on a part-delivered balance,
    ///      even though anyone may activate it. The guard reverts, so the run survives intact.
    function test_requireMinBalance_protectsAOneShotRecipeFromEarlyActivation() external {
        Call[] memory calls = new Call[](2);
        calls[0] = Call({
            target: address(recipes),
            value: 0,
            callData: abi.encodeCall(DropRecipes.requireMinBalance, (address(sellToken), 1000e18)),
            allowFailure: false,
            isDelegateCall: true
        });
        calls[1] = Call({
            target: address(recipes),
            value: 0,
            callData: abi.encodeCall(
                DropRecipes.twapFromBalance,
                (address(sellToken), address(buyToken), address(0), uint256(12), uint256(1 hours), uint256(0), uint256(95), uint256(100), bytes32(0), bytes32(0))
            ),
            allowFailure: false,
            isDelegateCall: true
        });
        bytes memory recipe = abi.encode(DropExecutor.Recipe({label: "guarded", salt: bytes32(0), once: true, calls: calls}));
        address drop = executor.dropOf(owner, recipe);

        // A bridge pays out a first tranche and an eager keeper tries to activate.
        sellToken.mint(drop, 250e18);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DropRecipes.BalanceTooLow.selector, 250e18, 1000e18));
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
    function test_guardIsEnforcedEvenWhenPlacedLast() external {
        Call[] memory calls = new Call[](2);
        calls[0] = Call({
            target: address(recipes),
            value: 0,
            callData: abi.encodeCall(
                DropRecipes.presignSellAll,
                (address(sellToken), address(buyToken), recipient, uint256(95), uint256(100), uint256(1 hours), bytes32(0))
            ),
            allowFailure: false,
            isDelegateCall: true
        });
        calls[1] = Call({
            target: address(recipes),
            value: 0,
            callData: abi.encodeCall(DropRecipes.requireMinBalance, (address(sellToken), 1000e18)),
            allowFailure: false,
            isDelegateCall: true
        });
        bytes memory recipe = abi.encode(DropExecutor.Recipe({label: "guard-last", salt: bytes32(0), once: true, calls: calls}));
        address drop = executor.dropOf(owner, recipe);

        sellToken.mint(drop, 100e18);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DropRecipes.BalanceTooLow.selector, 100e18, 1000e18));
        executor.activate(owner, recipe);

        // The pre-signature from step 1 was rolled back with everything else.
        assertEq(settlement.signerOf(keccak256(bytes(""))), address(0), "sanity");
        assertFalse(executor.consumed(drop), "the run was spent despite the guard failing");
        assertEq(drop.code.length, 0, "the drop should not exist after a reverted activation");
    }

    function test_requireMinBalance_guardsTheNativeBalanceToo() external {
        bytes memory recipe =
            _recipe("native-guard", abi.encodeCall(DropRecipes.requireMinBalance, (address(0), 2 ether)));
        address drop = executor.dropOf(owner, recipe);

        vm.deal(drop, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(DropRecipes.BalanceTooLow.selector, 1 ether, 2 ether));
        executor.activate(owner, recipe);

        vm.deal(drop, 2 ether);
        executor.activate(owner, recipe); // now passes
    }

    function test_requireTimeWindow_rejectsEarlyAndLateActivation() external {
        uint256 opens = block.timestamp + 1 days;
        uint256 closes = block.timestamp + 2 days;
        bytes memory recipe =
            _recipe("window", abi.encodeCall(DropRecipes.requireTimeWindow, (opens, closes)));

        vm.expectRevert(abi.encodeWithSelector(DropRecipes.TooEarly.selector, opens));
        executor.activate(owner, recipe);

        vm.warp(opens + 1 hours);
        executor.activate(owner, recipe); // inside the window

        vm.warp(closes + 1);
        vm.expectRevert(abi.encodeWithSelector(DropRecipes.TooLate.selector, closes));
        executor.activate(owner, recipe);
    }

    // --- generic steps ----------------------------------------------------------------------

    function test_wrapNative_wrapsWhateverNativeBalanceArrived() external {
        bytes memory recipe = _recipe("wrap", abi.encodeCall(DropRecipes.wrapNative, (address(wrappedNative))));
        address drop = executor.dropOf(owner, recipe);

        vm.deal(drop, 3 ether);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertEq(wrappedNative.balanceOf(drop), 3 ether, "native balance not wrapped");
        assertEq(drop.balance, 0, "native balance not fully wrapped");
    }

    // --- multi-step -------------------------------------------------------------------------

    /// @dev The shape the "bridge in, then swap" demo actually uses: wrap on arrival, then sell.
    function test_multiStepRecipeRunsInOrder() external {
        Call[] memory calls = new Call[](2);
        calls[0] = Call({
            target: address(recipes),
            value: 0,
            callData: abi.encodeCall(DropRecipes.approveMax, (address(sellToken), VAULT_RELAYER)),
            allowFailure: false,
            isDelegateCall: true
        });
        calls[1] = Call({
            target: address(recipes),
            value: 0,
            callData: abi.encodeCall(
                DropRecipes.presignSellAll,
                (address(sellToken), address(buyToken), recipient, 95, 100, 1 hours, bytes32(0))
            ),
            allowFailure: false,
            isDelegateCall: true
        });
        bytes memory recipe = abi.encode(DropExecutor.Recipe({label: "multi", salt: bytes32(0), once: false, calls: calls}));

        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 500e18);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertEq(sellToken.allowance(drop, VAULT_RELAYER), type(uint256).max, "approve step did not run");
        assertEq(composableCow.createCount(), 0, "presign path must not touch composable-cow");
    }
}

/// @dev Local mirror of `IConditionalOrder.ConditionalOrderParams` with `handler` as a plain
///      address, so tests can build the struct without importing the interface type.
struct IConditionalOrderParams {
    address handler;
    bytes32 salt;
    bytes staticInput;
}
