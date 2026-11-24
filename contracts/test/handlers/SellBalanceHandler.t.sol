// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {DropExecutor} from "src/DropExecutor.sol";
import {SellBalanceHandler} from "src/handlers/SellBalanceHandler.sol";
import {IConditionalOrderHandler} from "src/interfaces/IConditionalOrderHandler.sol";
import {IComposableCowLike} from "src/interfaces/IDropExternal.sol";
import {Orders} from "src/lib/Orders.sol";
import {TokenSteps} from "src/steps/TokenSteps.sol";

import {Call} from "cow-shed/ICOWAuthHook.sol";
import {IConditionalOrder} from "cow-shed/IConditionalOrder.sol";
import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {ConditionalOrderParamsMirror, StepsBase} from "../steps/StepsBase.sol";

contract SellBalanceHandlerTest is StepsBase {
    /// @dev Ends in `0x`: the handler appends the calldata as bare hex.
    string internal constant PREFIX = '{"appCode":"cow-drop","metadata":{"hooks":{"pre":[{"callData":"0x';
    string internal constant SUFFIX_HEAD = '","gasLimit":"900000","target":"';
    string internal constant SUFFIX_TAIL = '"}]}},"version":"1.1.0"}';

    bytes32 internal constant DOMAIN = keccak256("ccow-domain");
    uint256 internal constant VALIDITY = 30 minutes;
    uint256 internal constant ARRIVED = 1234.5e18;

    SellBalanceHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new SellBalanceHandler(executor);
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
            appData: template ? bytes32(0) : keccak256("fixed"),
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

    /// @dev The whole recipe: approve the relayer as the drop, then register with ComposableCoW.
    function _recipeFor(SellBalanceHandler.Data memory data) internal view returns (bytes memory) {
        Call[] memory calls = new Call[](2);
        calls[0] = _step(address(tokenOps), abi.encodeCall(TokenSteps.approveMax, (address(sellToken), VAULT_RELAYER)));
        calls[1] = Call({
            target: address(composableCow),
            value: 0,
            callData: abi.encodeCall(IComposableCowLike.create, (_params(data), true)),
            allowFailure: false,
            isDelegateCall: false
        });
        return _recipeOf("hook", false, calls);
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

    function _verify(address drop, bytes memory recipe, LibCowOrder.Data memory order) internal view {
        _verifyWith(drop, _data(true), abi.encode(owner, recipe), order);
    }

    function _verifyWith(
        address drop,
        SellBalanceHandler.Data memory data,
        bytes memory offchainInput,
        LibCowOrder.Data memory order
    ) internal view {
        handler.verify(
            drop,
            address(0),
            LibCowOrder.hash(order, DOMAIN),
            DOMAIN,
            bytes32(0),
            abi.encode(data),
            offchainInput,
            order
        );
    }

    function _expectNotValid(string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IConditionalOrderHandler.OrderNotValid.selector, reason));
    }

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

    // --- verify ----------------------------------------------------------------------------

    /// @dev Nothing is deployed or registered here: the handler only reads the balance and the
    ///      recipe, which is what lets the order be posted before the drop exists.
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
        _verifyWith(drop, _data(true), abi.encode(stranger, recipe), order);
    }

    function test_verify_rejectsATemplateOrderWithoutTheRecipe() external {
        (address drop,, LibCowOrder.Data memory order) = _funded();

        _expectNotValid("appData needs the recipe as offchain input");
        _verifyWith(drop, _data(true), "", order);
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
        handler.verify(
            drop,
            address(0),
            keccak256("other"),
            DOMAIN,
            bytes32(0),
            abi.encode(_data(true)),
            abi.encode(owner, recipe),
            order
        );
    }

    function test_verify_fixedAppDataNeedsNoRecipe() external {
        address drop = makeAddr("drop");
        sellToken.mint(drop, ARRIVED);

        _verifyWith(drop, _data(false), "", _order(keccak256("fixed")));

        _expectNotValid("appData");
        _verifyWith(drop, _data(false), "", _order(keccak256("other")));
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

    function test_getTradeableOrder_tellsAWatchTowerToStopWhenItCannotSupplyTheRecipe() external {
        (address drop,,) = _funded();

        vm.expectRevert(
            abi.encodeWithSelector(
                IConditionalOrderHandler.PollNever.selector, "appData needs the recipe as offchain input"
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
