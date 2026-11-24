// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {PaymentHandler} from "src/handlers/PaymentHandler.sol";
import {IConditionalOrderHandler} from "src/interfaces/IConditionalOrderHandler.sol";
import {IComposableCowLike} from "src/interfaces/IDropExternal.sol";
import {NothingToSell} from "src/lib/Errors.sol";
import {HookOrderBase} from "src/lib/HookOrderBase.sol";
import {Orders} from "src/lib/Orders.sol";
import {HookPaymentSteps} from "src/steps/HookPaymentSteps.sol";
import {PaymentSteps} from "src/steps/PaymentSteps.sol";

import {Call} from "cow-shed/ICOWAuthHook.sol";
import {IConditionalOrder} from "cow-shed/IConditionalOrder.sol";
import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {MockERC20, SameTransaction} from "../mocks/Mocks.sol";
import {ConditionalOrderParamsMirror, StepsBase} from "../steps/StepsBase.sol";

contract PaymentHandlerTest is StepsBase {
    /// @dev Ends in `0x`: the handler appends the calldata as bare hex.
    string internal constant PREFIX = '{"appCode":"cow-drop","metadata":{"hooks":{"pre":[{"callData":"0x';

    bytes32 internal constant DOMAIN = keccak256("ccow-domain");
    uint256 internal constant VALIDITY = 30 minutes;
    uint256 internal constant PRICE = 100e18;
    uint256 internal constant PAID = 1234.5e18;

    PaymentHandler internal handler;
    HookPaymentSteps internal hookPayments;
    MockERC20 internal otherToken;
    SameTransaction internal sameTx;

    function setUp() public override {
        super.setUp();
        handler = new PaymentHandler(executor);
        hookPayments = new HookPaymentSteps(VAULT_RELAYER, payments);
        otherToken = new MockERC20();
        sameTx = new SameTransaction();
    }

    // --- helpers ---------------------------------------------------------------------------

    function _suffix() internal view returns (string memory) {
        return
            string.concat(
                '","gasLimit":"900000","target":"', vm.toString(address(payments)), '"}]}},"version":"1.1.0"}'
            );
    }

    function _data() internal view returns (PaymentHandler.Data memory) {
        return PaymentHandler.Data({
            buyToken: address(buyToken),
            buyAmount: PRICE,
            receiver: recipient,
            validitySeconds: VALIDITY,
            appData: bytes32(0),
            appDataPrefix: bytes(PREFIX),
            appDataSuffix: bytes(_suffix())
        });
    }

    /// @dev The whole recipe: let the relayer pull the chosen token, then register with ComposableCoW.
    function _recipe() internal view returns (bytes memory) {
        IConditionalOrder.ConditionalOrderParams memory params = IConditionalOrder.ConditionalOrderParams({
            handler: IConditionalOrder(address(handler)), salt: bytes32(0), staticInput: abi.encode(_data())
        });

        Call[] memory calls = new Call[](3);
        calls[0] = _step(
            address(hookPayments), abi.encodeCall(HookPaymentSteps.approvePayment, (address(buyToken), recipient))
        );
        calls[1] = Call({
            target: address(composableCow),
            value: 0,
            callData: abi.encodeCall(IComposableCowLike.create, (params, true)),
            allowFailure: false,
            isDelegateCall: false
        });
        calls[2] = Call({
            target: address(handler),
            value: 0,
            callData: abi.encodeCall(HookOrderBase.markRan, ()),
            allowFailure: false,
            isDelegateCall: false
        });
        return _recipeOf("pay", false, calls);
    }

    /// @dev The document built the way an off-chain poster builds it, not the way the handler does.
    function _appData(address shedOwner, bytes memory recipe, address token) internal view returns (bytes32) {
        string memory hook = vm.toString(abi.encodeCall(PaymentSteps.activatePayment, (shedOwner, recipe, token)));
        return keccak256(
            bytes(
                string.concat(
                    '{"appCode":"cow-drop","metadata":{"hooks":{"pre":[{"callData":"',
                    hook,
                    '","gasLimit":"900000","target":"',
                    vm.toString(address(payments)),
                    '"}]}},"version":"1.1.0"}'
                )
            )
        );
    }

    function _order(address token, bytes32 appData) internal view returns (LibCowOrder.Data memory) {
        return LibCowOrder.Data({
            sellToken: IERC20(token),
            buyToken: IERC20(address(buyToken)),
            receiver: recipient,
            sellAmount: PAID,
            buyAmount: PRICE,
            validTo: uint32(block.timestamp + VALIDITY),
            appData: appData,
            feeAmount: 0,
            kind: Orders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: Orders.BALANCE_ERC20,
            buyTokenBalance: Orders.BALANCE_ERC20 // gitleaks:allow (balance-kind constant, not a secret)
        });
    }

    /// @dev A drop paid in `token`, and the order that should pass.
    function _paidIn(MockERC20 token)
        internal
        returns (address drop, bytes memory recipe, LibCowOrder.Data memory order)
    {
        recipe = _recipe();
        drop = executor.dropOf(owner, recipe);
        token.mint(drop, PAID);
        order = _order(address(token), _appData(owner, recipe, address(token)));
    }

    /// @dev Activates with the order's own sell token and verifies, in one transaction, as a
    ///      settlement does with the hook and the signature check. The activation's revert is
    ///      swallowed, as the trampoline swallows it.
    function _verify(address drop, bytes memory recipe, LibCowOrder.Data memory order) internal {
        _verifyAs(owner, drop, recipe, order);
    }

    /// @param claimed Whose recipe the offchain input says it is.
    function _verifyAs(address claimed, address drop, bytes memory recipe, LibCowOrder.Data memory order) internal {
        sameTx.run(
            address(payments),
            abi.encodeCall(PaymentSteps.activatePayment, (owner, recipe, address(order.sellToken))),
            true,
            address(handler),
            abi.encodeCall(
                PaymentHandler.verify,
                (
                    drop,
                    address(0),
                    LibCowOrder.hash(order, DOMAIN),
                    DOMAIN,
                    bytes32(0),
                    abi.encode(_data()),
                    abi.encode(claimed, recipe),
                    order
                )
            )
        );
    }

    function _expectNotValid(string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IConditionalOrderHandler.OrderNotValid.selector, reason));
    }

    // --- the recipe ------------------------------------------------------------------------

    function test_recipe_approvesTheTokenTheActivatorNamesAndRegisters() external {
        (address drop, bytes memory recipe,) = _paidIn(otherToken);

        vm.prank(keeper);
        payments.activatePayment(owner, recipe, address(otherToken));

        bytes32 paramsHash = keccak256(
            abi.encode(
                ConditionalOrderParamsMirror({
                    handler: address(handler), salt: bytes32(0), staticInput: abi.encode(_data())
                })
            )
        );
        assertTrue(composableCow.singleOrders(drop, paramsHash), "handler not registered for the drop");
        assertEq(otherToken.allowance(drop, VAULT_RELAYER), type(uint256).max, "relayer not approved");
        assertEq(sellToken.allowance(drop, VAULT_RELAYER), 0, "approved a token nobody named");
    }

    /// @dev A second token arriving later gets its own approval from its own order's hook.
    function test_recipe_runsAgainForASecondToken() external {
        (address drop, bytes memory recipe,) = _paidIn(otherToken);
        payments.activatePayment(owner, recipe, address(otherToken));

        sellToken.mint(drop, PAID);
        payments.activatePayment(owner, recipe, address(sellToken));

        assertEq(sellToken.allowance(drop, VAULT_RELAYER), type(uint256).max);
    }

    function test_recipe_forwardsAPaymentMadeInTheBuyToken() external {
        (address drop, bytes memory recipe,) = _paidIn(buyToken);

        payments.activatePayment(owner, recipe, address(buyToken));

        assertEq(buyToken.balanceOf(recipient), PAID);
        assertEq(buyToken.balanceOf(drop), 0);
    }

    function test_recipe_refusesPlainActivationAndAnEmptyToken() external {
        (, bytes memory recipe,) = _paidIn(otherToken);

        vm.expectRevert(HookPaymentSteps.NoPaymentToken.selector);
        executor.activate(owner, recipe);

        vm.expectRevert(NothingToSell.selector);
        payments.activatePayment(owner, recipe, address(sellToken));
    }

    function test_verify_rejectsAnOrderWhoseRecipeDidNotRunInThisTransaction() external {
        bytes memory recipe = _recipe();
        address drop = executor.dropOf(owner, recipe);
        otherToken.mint(drop, PAID);

        LibCowOrder.Data memory order = _order(address(otherToken), _appData(owner, recipe, address(otherToken)));

        _expectNotValid("recipe did not run in this transaction");
        handler.verify(
            drop,
            address(0),
            LibCowOrder.hash(order, DOMAIN),
            DOMAIN,
            bytes32(0),
            abi.encode(_data()),
            abi.encode(owner, recipe),
            order
        );
    }

    // --- verify ----------------------------------------------------------------------------

    /// @dev Nothing is deployed or registered here, and the recipe never named either token.
    function test_verify_acceptsTheWholeBalanceOfWhicheverTokenPays() external {
        (address drop, bytes memory recipe, LibCowOrder.Data memory order) = _paidIn(otherToken);
        _verify(drop, recipe, order);

        sellToken.mint(drop, PAID);
        _verify(drop, recipe, _order(address(sellToken), _appData(owner, recipe, address(sellToken))));
    }

    function test_verify_acceptsMoreThanThePrice() external {
        (address drop, bytes memory recipe, LibCowOrder.Data memory order) = _paidIn(otherToken);
        order.buyAmount += 1;
        _verify(drop, recipe, order);
    }

    /// @dev The hook must approve the token being sold; one naming another token is another document.
    function test_verify_rejectsAHookThatNamesADifferentToken() external {
        (address drop, bytes memory recipe, LibCowOrder.Data memory order) = _paidIn(otherToken);
        order.appData = _appData(owner, recipe, address(sellToken));

        _expectNotValid("appData");
        _verify(drop, recipe, order);
    }

    function test_verify_rejectsARecipeThatIsNotThisDrops() external {
        (address drop, bytes memory recipe,) = _paidIn(otherToken);
        address stranger = makeAddr("stranger");
        LibCowOrder.Data memory order = _order(address(otherToken), _appData(stranger, recipe, address(otherToken)));

        _expectNotValid("not this drop's recipe");
        _verifyAs(stranger, drop, recipe, order);
    }

    function test_verify_rejectsLessThanThePrice() external {
        (address drop, bytes memory recipe, LibCowOrder.Data memory order) = _paidIn(otherToken);
        order.buyAmount -= 1;

        _expectNotValid("below the minimum");
        _verify(drop, recipe, order);
    }

    function test_verify_rejectsLessThanTheWholeBalance() external {
        (address drop, bytes memory recipe, LibCowOrder.Data memory order) = _paidIn(otherToken);
        order.sellAmount -= 1;

        _expectNotValid("not the whole balance");
        _verify(drop, recipe, order);
    }

    function test_verify_rejectsSellingTheBuyToken() external {
        (address drop, bytes memory recipe,) = _paidIn(buyToken);
        LibCowOrder.Data memory order = _order(address(buyToken), _appData(owner, recipe, address(buyToken)));

        _expectNotValid("already the buy token");
        _verify(drop, recipe, order);
    }

    function test_verify_rejectsEveryOtherFieldTheRecipeFixes() external {
        (address drop, bytes memory recipe, LibCowOrder.Data memory good) = _paidIn(otherToken);

        LibCowOrder.Data memory order = _copy(good);
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
        order.validTo += 1;
        _expectNotValid("valid for too long");
        _verify(drop, recipe, order);
    }

    function test_getTradeableOrder_tellsAWatchTowerToStop() external {
        vm.expectRevert(
            abi.encodeWithSelector(IConditionalOrderHandler.PollNever.selector, "the poster chooses the sell token")
        );
        handler.getTradeableOrder(address(0), address(0), bytes32(0), "", "");
    }

    function _copy(LibCowOrder.Data memory order) internal pure returns (LibCowOrder.Data memory) {
        return abi.decode(abi.encode(order), (LibCowOrder.Data));
    }
}
