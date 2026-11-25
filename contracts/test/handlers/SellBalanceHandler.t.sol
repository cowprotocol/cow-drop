// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {DropExecutor} from "src/DropExecutor.sol";
import {SellBalanceHandler} from "src/handlers/SellBalanceHandler.sol";
import {IConditionalOrderHandler} from "src/interfaces/IConditionalOrderHandler.sol";
import {IComposableCowLike} from "src/interfaces/IDropExternal.sol";
import {HookOrderBase} from "src/lib/HookOrderBase.sol";
import {Orders} from "src/lib/Orders.sol";
import {GuardSteps} from "src/steps/GuardSteps.sol";
import {TokenSteps} from "src/steps/TokenSteps.sol";

import {Call} from "cow-shed/ICOWAuthHook.sol";
import {IConditionalOrder} from "cow-shed/IConditionalOrder.sol";
import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {SameTransaction} from "../mocks/Mocks.sol";
import {ConditionalOrderParamsMirror, StepsBase} from "../steps/StepsBase.sol";

/// @dev The handler, a recipe for it, and the two-calls-in-one-transaction verify both suites use.
abstract contract SellBalanceHandlerFixture is StepsBase {
    /// @dev Ends in `0x`: the handler appends the calldata as bare hex.
    string internal constant PREFIX = '{"appCode":"cow-drop","metadata":{"hooks":{"pre":[{"callData":"0x';
    string internal constant SUFFIX_HEAD = '","gasLimit":"900000","target":"';
    string internal constant SUFFIX_TAIL = '"}]}},"version":"1.1.0"}';

    bytes32 internal constant DOMAIN = keccak256("ccow-domain");
    uint256 internal constant VALIDITY = 30 minutes;
    uint256 internal constant ARRIVED = 1234.5e18;

    bytes32 internal constant HOOK_FREE_APP_DATA = keccak256("hook-free");

    SellBalanceHandler internal handler;
    SameTransaction internal sameTx;
    /// @dev Which kind of recipe the suite builds. A strict one marks every run and takes no order
    ///      without its hook.
    bool internal strict;

    function setUp() public virtual override {
        super.setUp();
        handler = new SellBalanceHandler(executor);
        sameTx = new SameTransaction();
    }

    // --- helpers ---------------------------------------------------------------------------

    function _suffix() internal view returns (string memory) {
        return string.concat(SUFFIX_HEAD, vm.toString(address(executor)), SUFFIX_TAIL);
    }

    function _data(bool template) internal view returns (SellBalanceHandler.Data memory) {
        return SellBalanceHandler.Data({
            sellToken: address(sellToken),
            buyToken: address(buyToken),
            receiver: recipient,
            limitNumerator: 95,
            limitDenominator: 100,
            validitySeconds: VALIDITY,
            strict: strict,
            appData: template ? HOOK_FREE_APP_DATA : keccak256("fixed"),
            appDataPrefix: template ? bytes(PREFIX) : bytes(""),
            appDataSuffix: template ? bytes(_suffix()) : bytes("")
        });
    }

    function _params(SellBalanceHandler.Data memory data)
        internal
        view
        returns (IConditionalOrder.ConditionalOrderParams memory)
    {
        return IConditionalOrder.ConditionalOrderParams({
            handler: IConditionalOrder(address(handler)), salt: bytes32(0), staticInput: abi.encode(data)
        });
    }

    /// @dev The whole recipe: approve the relayer as the drop and register with ComposableCoW. A
    ///      strict one also tells the handler it ran, last.
    function _recipeFor(SellBalanceHandler.Data memory data) internal view returns (bytes memory) {
        Call[] memory calls = new Call[](strict ? 3 : 2);
        calls[0] = _step(address(tokenOps), abi.encodeCall(TokenSteps.approveMax, (address(sellToken), VAULT_RELAYER)));
        calls[1] = Call({
            target: address(composableCow),
            value: 0,
            callData: abi.encodeCall(IComposableCowLike.create, (_params(data), true)),
            allowFailure: false,
            isDelegateCall: false
        });
        if (strict) calls[2] = _mark();
        return _recipeOf("hook", false, calls);
    }

    function _mark() internal view returns (Call memory) {
        return Call({
            target: address(handler),
            value: 0,
            callData: abi.encodeCall(HookOrderBase.markRan, (address(sellToken))),
            allowFailure: false,
            isDelegateCall: false
        });
    }

    /// @dev The document built the way an off-chain poster builds it, not the way the handler does.
    function _appData(address shedOwner, bytes memory recipe) internal view returns (bytes32) {
        string memory hook = vm.toString(abi.encodeCall(DropExecutor.activate, (shedOwner, recipe)));
        return keccak256(
            bytes(
                string.concat(
                    '{"appCode":"cow-drop","metadata":{"hooks":{"pre":[{"callData":"',
                    hook,
                    '","gasLimit":"900000","target":"',
                    vm.toString(address(executor)),
                    '"}]}},"version":"1.1.0"}'
                )
            )
        );
    }

    function _order(bytes32 appData) internal view returns (LibCowOrder.Data memory) {
        return LibCowOrder.Data({
            sellToken: IERC20(address(sellToken)),
            buyToken: IERC20(address(buyToken)),
            receiver: recipient,
            sellAmount: ARRIVED,
            buyAmount: (ARRIVED * 95) / 100,
            validTo: uint32(block.timestamp + VALIDITY),
            appData: appData,
            feeAmount: 0,
            kind: Orders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: Orders.BALANCE_ERC20,
            buyTokenBalance: Orders.BALANCE_ERC20
        });
    }

    /// @dev A funded drop for the template recipe, and the order that should pass.
    function _funded() internal returns (address drop, bytes memory recipe, LibCowOrder.Data memory order) {
        recipe = _recipeFor(_data(true));
        drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, ARRIVED);
        order = _order(_appData(owner, recipe));
    }

    /// @dev Activates and verifies in one transaction, as a settlement does with the hook and the
    ///      signature check. The activation's own revert is swallowed, as the trampoline swallows it.
    function _verify(address drop, bytes memory recipe, LibCowOrder.Data memory order) internal {
        _verifyWith(drop, recipe, _data(true), abi.encode(owner, recipe), order);
    }

    function _verifyWith(
        address drop,
        bytes memory recipe,
        SellBalanceHandler.Data memory data,
        bytes memory offchainInput,
        LibCowOrder.Data memory order
    ) internal {
        sameTx.run(
            address(executor),
            abi.encodeCall(DropExecutor.activate, (owner, recipe)),
            true,
            address(handler),
            _verifyCall(drop, LibCowOrder.hash(order, DOMAIN), data, offchainInput, order)
        );
    }

    function _verifyCall(
        address drop,
        bytes32 hash,
        SellBalanceHandler.Data memory data,
        bytes memory offchainInput,
        LibCowOrder.Data memory order
    ) internal pure returns (bytes memory) {
        return abi.encodeCall(
            SellBalanceHandler.verify,
            (drop, address(0), hash, DOMAIN, bytes32(0), abi.encode(data), offchainInput, order)
        );
    }

    function _expectNotValid(string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IConditionalOrderHandler.OrderNotValid.selector, reason));
    }
}

contract SellBalanceHandlerTest is SellBalanceHandlerFixture {
    // --- the recipe ------------------------------------------------------------------------

    function test_recipe_registersTheHandlerAndApprovesTheRelayer() external {
        (address drop, bytes memory recipe,) = _funded();

        vm.prank(keeper);
        executor.activate(owner, recipe);

        bytes32 paramsHash = keccak256(
            abi.encode(
                ConditionalOrderParamsMirror({
                    handler: address(handler), salt: bytes32(0), staticInput: abi.encode(_data(true))
                })
            )
        );
        assertTrue(composableCow.singleOrders(drop, paramsHash), "handler not registered for the drop");
        assertEq(sellToken.allowance(drop, VAULT_RELAYER), type(uint256).max, "relayer not approved");
    }

    /// @dev The hook re-runs the recipe when somebody activated first. It must not revert.
    function test_recipe_canRunTwice() external {
        (, bytes memory recipe,) = _funded();

        executor.activate(owner, recipe);
        executor.activate(owner, recipe);

        assertEq(composableCow.createCount(), 2);
    }

    // --- the recipe has to run, every time ---------------------------------------------------

    function test_markRan_vouchesOnlyForItsCallerAndItsToken() external {
        bytes memory mark = abi.encodeCall(HookOrderBase.markRan, (address(sellToken)));

        // `sameTx` marks itself for `sellToken`, and each question is asked in that same transaction.
        bytes memory answer = sameTx.run(
            address(handler),
            mark,
            false,
            address(handler),
            abi.encodeCall(HookOrderBase.ranThisTransaction, (address(sameTx), address(sellToken)))
        );
        assertTrue(abi.decode(answer, (bool)));

        answer = sameTx.run(
            address(handler),
            mark,
            false,
            address(handler),
            abi.encodeCall(HookOrderBase.ranThisTransaction, (address(this), address(sellToken)))
        );
        assertFalse(abi.decode(answer, (bool)), "one caller's mark vouched for another");

        answer = sameTx.run(
            address(handler),
            mark,
            false,
            address(handler),
            abi.encodeCall(HookOrderBase.ranThisTransaction, (address(sameTx), address(buyToken)))
        );
        assertFalse(abi.decode(answer, (bool)), "a mark for one token vouched for another");
    }

    // --- verify ----------------------------------------------------------------------------

    /// @dev Nothing is deployed or registered here: beyond the mark, the handler only reads the
    ///      balance and the recipe, which is what lets the order be posted before the drop exists.
    function test_verify_acceptsTheWholeBalanceUnderTheTemplateAppData() external {
        (address drop, bytes memory recipe, LibCowOrder.Data memory order) = _funded();
        _verify(drop, recipe, order);
    }

    function test_verify_acceptsABetterPriceAndAShorterDeadline() external {
        (address drop, bytes memory recipe, LibCowOrder.Data memory order) = _funded();
        order.buyAmount += 1;
        order.validTo -= 60;
        _verify(drop, recipe, order);
    }

    function test_verify_rejectsAnAppDataTheTemplateDoesNotProduce() external {
        (address drop, bytes memory recipe, LibCowOrder.Data memory order) = _funded();
        order.appData = keccak256("someone else's fee");

        _expectNotValid("appData");
        _verify(drop, recipe, order);
    }

    function test_verify_rejectsARecipeThatIsNotThisDrops() external {
        (address drop, bytes memory recipe,) = _funded();
        address stranger = makeAddr("stranger");
        // A consistent document for another owner's activation of the same recipe.
        LibCowOrder.Data memory order = _order(_appData(stranger, recipe));

        _expectNotValid("not this drop's recipe");
        _verifyWith(drop, recipe, _data(true), abi.encode(stranger, recipe), order);
    }

    /// @dev With no recipe there is no hook to rebuild, so the order is held to the hook-free appData.
    function test_verify_holdsAnOrderWithoutTheRecipeToTheHookFreeAppData() external {
        (address drop, bytes memory recipe, LibCowOrder.Data memory order) = _funded();

        _expectNotValid("appData");
        _verifyWith(drop, recipe, _data(true), "", order);
    }

    /// @dev The follow-up order: once the drop exists and the relayer is approved, nothing the hook
    ///      does is needed, so the order may come without one. Checked with no activation at all,
    ///      because the handler asks for none; an undeployed drop simply cannot sign.
    function test_verify_acceptsAnOrderWithNoHookUnderTheCommittedAppData() external {
        (address drop,,) = _funded();
        LibCowOrder.Data memory order = _order(HOOK_FREE_APP_DATA);

        handler.verify(
            drop, address(0), LibCowOrder.hash(order, DOMAIN), DOMAIN, bytes32(0), abi.encode(_data(true)), "", order
        );
    }

    function test_verify_rejectsAHookWhereTheRecipeCommitsNoTemplate() external {
        bytes memory recipe = _recipeFor(_data(false));
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, ARRIVED);

        _expectNotValid("no appData template for a hook");
        _verifyWith(drop, recipe, _data(false), abi.encode(owner, recipe), _order(keccak256("fixed")));
    }

    function test_verify_rejectsLessThanTheWholeBalance() external {
        (address drop, bytes memory recipe, LibCowOrder.Data memory order) = _funded();
        order.sellAmount -= 1;

        _expectNotValid("not the whole balance");
        _verify(drop, recipe, order);
    }

    function test_verify_rejectsAnEmptyDrop() external {
        bytes memory recipe = _recipeFor(_data(true));
        address drop = executor.dropOf(owner, recipe);
        LibCowOrder.Data memory order = _order(_appData(owner, recipe));
        order.sellAmount = 0;

        _expectNotValid("not the whole balance");
        _verify(drop, recipe, order);
    }

    function test_verify_rejectsAPriceBelowTheLimit() external {
        (address drop, bytes memory recipe, LibCowOrder.Data memory order) = _funded();
        order.buyAmount -= 1;

        _expectNotValid("below the minimum");
        _verify(drop, recipe, order);
    }

    function test_verify_rejectsADeadlinePastTheValidity() external {
        (address drop, bytes memory recipe, LibCowOrder.Data memory order) = _funded();
        order.validTo += 1;

        _expectNotValid("valid for too long");
        _verify(drop, recipe, order);
    }

    function test_verify_rejectsEveryOtherFieldTheRecipeFixes() external {
        (address drop, bytes memory recipe, LibCowOrder.Data memory good) = _funded();

        LibCowOrder.Data memory order = _copy(good);
        order.sellToken = IERC20(address(buyToken));
        _expectNotValid("sell token");
        _verify(drop, recipe, order);

        order = _copy(good);
        order.buyToken = IERC20(address(sellToken));
        _expectNotValid("buy token");
        _verify(drop, recipe, order);

        order = _copy(good);
        order.receiver = keeper;
        _expectNotValid("receiver");
        _verify(drop, recipe, order);

        order = _copy(good);
        order.kind = Orders.KIND_BUY;
        _expectNotValid("not a sell order");
        _verify(drop, recipe, order);

        order = _copy(good);
        order.partiallyFillable = true;
        _expectNotValid("partially fillable");
        _verify(drop, recipe, order);

        order = _copy(good);
        order.feeAmount = 1;
        _expectNotValid("fee");
        _verify(drop, recipe, order);

        order = _copy(good);
        order.sellTokenBalance = keccak256("external");
        _expectNotValid("sell token balance");
        _verify(drop, recipe, order);

        order = _copy(good);
        order.buyTokenBalance = keccak256("internal");
        _expectNotValid("buy token balance");
        _verify(drop, recipe, order);
    }

    function test_verify_rejectsAHashThatIsNotTheOrders() external {
        (address drop, bytes memory recipe, LibCowOrder.Data memory order) = _funded();

        _expectNotValid("invalid hash");
        sameTx.run(
            address(executor),
            abi.encodeCall(DropExecutor.activate, (owner, recipe)),
            true,
            address(handler),
            _verifyCall(drop, keccak256("other"), _data(true), abi.encode(owner, recipe), order)
        );
    }

    function test_verify_fixedAppDataNeedsNoRecipe() external {
        bytes memory recipe = _recipeFor(_data(false));
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, ARRIVED);

        _verifyWith(drop, recipe, _data(false), "", _order(keccak256("fixed")));

        _expectNotValid("appData");
        _verifyWith(drop, recipe, _data(false), "", _order(keccak256("other")));
    }

    // --- getTradeableOrder -----------------------------------------------------------------

    function test_getTradeableOrder_passesVerifyAndHoldsStillWithinABucket() external {
        (address drop, bytes memory recipe,) = _funded();
        bytes memory staticInput = abi.encode(_data(true));
        bytes memory offchainInput = abi.encode(owner, recipe);

        LibCowOrder.Data memory order =
            handler.getTradeableOrder(drop, address(0), bytes32(0), staticInput, offchainInput);
        _verify(drop, recipe, order);
        assertEq(order.sellAmount, ARRIVED);
        assertEq(order.appData, _appData(owner, recipe));

        // 1_800_000_000 is a bucket boundary, so a minute later is still the same bucket.
        vm.warp(block.timestamp + 60);
        LibCowOrder.Data memory later =
            handler.getTradeableOrder(drop, address(0), bytes32(0), staticInput, offchainInput);
        assertEq(later.validTo, order.validTo, "validTo moved inside a bucket");
        _verify(drop, recipe, later);
    }

    /// @dev What a watch tower polling with no offchain input gets: the hook-free order.
    function test_getTradeableOrder_answersWithTheHookFreeOrderWhenGivenNoRecipe() external {
        (address drop,,) = _funded();

        LibCowOrder.Data memory order =
            handler.getTradeableOrder(drop, address(0), bytes32(0), abi.encode(_data(true)), "");

        assertEq(order.appData, HOOK_FREE_APP_DATA);
        assertEq(order.sellAmount, ARRIVED);
    }

    function test_getTradeableOrder_tellsAWatchTowerToStopWhenAStrictRecipeNeedsItsHook() external {
        strict = true;
        (address drop,,) = _funded();

        vm.expectRevert(
            abi.encodeWithSelector(
                IConditionalOrderHandler.PollNever.selector, "this recipe needs its hook on every order"
            )
        );
        handler.getTradeableOrder(drop, address(0), bytes32(0), abi.encode(_data(true)), "");
    }

    function test_getTradeableOrder_waitsWhileTheDropIsEmpty() external {
        vm.expectRevert(abi.encodeWithSelector(IConditionalOrderHandler.PollTryNextBlock.selector, "nothing to sell"));
        handler.getTradeableOrder(makeAddr("drop"), address(0), bytes32(0), abi.encode(_data(false)), "");
    }

    /// @dev The id ComposableCoW asks for before it calls `getTradeableOrder`.
    function test_supportsInterface_answersForTheUpstreamGenerator() external view {
        bytes4 generator = bytes4(keccak256("getTradeableOrder(address,address,bytes32,bytes,bytes)"));
        assertTrue(handler.supportsInterface(generator));
        assertTrue(handler.supportsInterface(0x01ffc9a7));
        assertFalse(handler.supportsInterface(0xffffffff));
    }

    function _copy(LibCowOrder.Data memory order) internal pure returns (LibCowOrder.Data memory) {
        return abi.decode(abi.encode(order), (LibCowOrder.Data));
    }
}

/// @notice A drop that was already activated, in an earlier transaction.
///
/// @dev A strict recipe, one with a guard. This is when a guard would otherwise stop binding: the
///      registration and the approval outlive the activation, and the trampoline swallows a hook
///      that reverts. `setUp` is its own transaction, so the mark it leaves is gone by the time a
///      test runs, whatever `--isolate` says.
contract SellBalanceHandlerActivatedEarlierTest is SellBalanceHandlerFixture {
    bytes internal recipe;
    address internal drop;

    function setUp() public override {
        super.setUp();
        strict = true;

        Call[] memory calls = new Call[](4);
        calls[0] = _step(address(guards), abi.encodeCall(GuardSteps.requireMinBalance, (address(sellToken), ARRIVED)));
        calls[1] = _step(address(tokenOps), abi.encodeCall(TokenSteps.approveMax, (address(sellToken), VAULT_RELAYER)));
        calls[2] = Call({
            target: address(composableCow),
            value: 0,
            callData: abi.encodeCall(IComposableCowLike.create, (_params(_data(true)), true)),
            allowFailure: false,
            isDelegateCall: false
        });
        calls[3] = _mark();
        recipe = _recipeOf("guarded", false, calls);
        drop = executor.dropOf(owner, recipe);

        sellToken.mint(drop, ARRIVED);
        executor.activate(owner, recipe);
    }

    function test_theRegistrationAndApprovalOutliveTheActivation() external view {
        assertGt(drop.code.length, 0);
        assertEq(sellToken.allowance(drop, VAULT_RELAYER), type(uint256).max);
        assertFalse(handler.ranThisTransaction(drop, address(sellToken)), "the mark outlived its transaction");
    }

    function test_anOrderIsRefusedWithoutItsHook() external {
        LibCowOrder.Data memory order = _order(_appData(owner, recipe));

        _expectNotValid("recipe did not run in this transaction");
        handler.verify(
            drop,
            address(0),
            LibCowOrder.hash(order, DOMAIN),
            DOMAIN,
            bytes32(0),
            abi.encode(_data(true)),
            abi.encode(owner, recipe),
            order
        );
    }

    /// @dev A strict recipe has no hook-free form, even in a transaction where the recipe did run:
    ///      that order would skip the very thing the recipe is strict about.
    function test_anOrderWithNoHookIsRefused() external {
        LibCowOrder.Data memory order = _order(HOOK_FREE_APP_DATA);

        _expectNotValid("this recipe needs its hook on every order");
        _verifyWith(drop, recipe, _data(true), "", order);
    }

    function test_anOrderPassesWhenItsHookRunsTheRecipeAgain() external {
        _verify(drop, recipe, _order(_appData(owner, recipe)));
    }

    /// @dev The case the mark exists for: the balance has fallen under the guard, so the hook
    ///      reverts, and nothing else stands in the order's way.
    function test_aGuardThatRevertsLeavesTheOrderInvalid() external {
        vm.prank(drop);
        sellToken.transfer(owner, 1);
        LibCowOrder.Data memory small = _order(_appData(owner, recipe));
        small.sellAmount = ARRIVED - 1;
        small.buyAmount = ((ARRIVED - 1) * 95) / 100;

        _expectNotValid("recipe did not run in this transaction");
        _verify(drop, recipe, small);
    }
}
