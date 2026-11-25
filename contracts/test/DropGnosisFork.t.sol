// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {DropExecutor} from "src/DropExecutor.sol";
import {PaymentHandler} from "src/handlers/PaymentHandler.sol";
import {SellBalanceHandler} from "src/handlers/SellBalanceHandler.sol";
import {IComposableCowLike, IERC20Like, ISettlementLike} from "src/interfaces/IDropExternal.sol";
import {HookOrderBase} from "src/lib/HookOrderBase.sol";
import {Orders} from "src/lib/Orders.sol";
import {HookPaymentSteps} from "src/steps/HookPaymentSteps.sol";
import {PaymentSteps} from "src/steps/PaymentSteps.sol";
import {PresignSteps} from "src/steps/PresignSteps.sol";
import {StopLossSteps} from "src/steps/StopLossSteps.sol";
import {TokenSteps} from "src/steps/TokenSteps.sol";
import {TwapSteps} from "src/steps/TwapSteps.sol";

import {COWShedExecutorFactory} from "cow-shed/COWShedExecutorFactory.sol";
import {Call} from "cow-shed/ICOWAuthHook.sol";
import {IComposableCow} from "cow-shed/IComposableCow.sol";
import {IConditionalOrder} from "cow-shed/IConditionalOrder.sol";
import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {SameTransaction} from "./mocks/Mocks.sol";

/// @dev The watch tower's entry point. `GPv2Order.Data` and `LibCowOrder.Data` have identical
///      layouts, so decoding the return value as the latter is exact.
interface IComposableCowFork {
    function getTradeableOrderWithSignature(
        address owner,
        IConditionalOrder.ConditionalOrderParams calldata params,
        bytes calldata offchainInput,
        bytes32[] calldata proof
    ) external view returns (LibCowOrder.Data memory order, bytes memory signature);

    function domainSeparator() external view returns (bytes32);
    function singleOrders(address owner, bytes32 singleOrderHash) external view returns (bool);
    function cabinet(address owner, bytes32 ctx) external view returns (bytes32);
}

/// @dev CoW's hooks trampoline: how a solver runs an order's pre-hooks.
interface IHooksTrampoline {
    struct Hook {
        address target;
        bytes callData;
        uint256 gasLimit;
    }

    function execute(Hook[] calldata hooks) external;
}

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/// @notice End-to-end against the real Gnosis deployments.
///
/// @dev Run with:  GNOSIS_RPC_URL=https://rpc.gnosischain.com forge test --match-path 'test/DropGnosisFork.t.sol'
///      Skipped when `GNOSIS_RPC_URL` is unset, so the default suite stays hermetic.
contract DropGnosisForkTest is Test {
    address internal constant COMPOSABLE_COW = 0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74;
    address internal constant TWAP_HANDLER = 0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5;
    address internal constant TIMESTAMP_FACTORY = 0x52eD56Da04309Aca4c3FECC595298d80C2f16BAc;
    address internal constant STOP_LOSS_HANDLER = 0x412c36e5011CD2517016D243a2dfB37f73A242E7;
    address internal constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    address internal constant VAULT_RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;

    /// @dev cow-shed#79: the live executor factory on Gnosis, over `COWShedWithExecutorSigner`.
    address internal constant EXECUTOR_FACTORY = 0xD4B9497f258bf63A7f21d1DEAF26dA2F23e4DC99;

    /// @dev The trampoline CoW's services use on Gnosis.
    address internal constant HOOKS_TRAMPOLINE = 0x01DcB88678aedD0C4cC9552B20F4718550250574;

    address internal constant WXDAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;

    /// @dev Price feeds are mocked, so any address will do — these just need to be distinct.
    address internal constant SELL_ORACLE = address(0x0FEE01);
    address internal constant BUY_ORACLE = address(0x0FEE02);
    address internal constant COW = 0x177127622c4A00F3d409B75571e12cB3c8973d3c;

    bytes4 internal constant MAGIC_VALUE_1271 = 0x1626ba7e;

    COWShedExecutorFactory internal factory;
    DropExecutor internal executor;
    PresignSteps internal presign;
    TwapSteps internal twapSteps;
    StopLossSteps internal stopLossSteps;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal recipient = makeAddr("recipient");

    function setUp() public {
        string memory rpc = vm.envOr("GNOSIS_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);

        // The canonical contracts recorded live on Gnosis by cow-shed#79. Addressed rather than
        // deployed, so this test exercises the same bytecode production drops will use.
        factory = COWShedExecutorFactory(EXECUTOR_FACTORY);
        executor = new DropExecutor(factory, IComposableCow(COMPOSABLE_COW));
        presign = new PresignSteps(ISettlementLike(SETTLEMENT), VAULT_RELAYER);
        stopLossSteps = new StopLossSteps(VAULT_RELAYER, IComposableCowLike(COMPOSABLE_COW), STOP_LOSS_HANDLER);
        twapSteps = new TwapSteps(VAULT_RELAYER, IComposableCowLike(COMPOSABLE_COW), TWAP_HANDLER, TIMESTAMP_FACTORY);
    }

    function _recipe(bytes32 label, address target, bytes memory callData) internal pure returns (bytes memory) {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({target: target, value: 0, callData: callData, allowFailure: false, isDelegateCall: true});
        return abi.encode(DropExecutor.Recipe({label: label, salt: bytes32(0), once: false, calls: calls}));
    }

    // --- path P against the real settlement contract -----------------------------------------

    function test_fork_presignedOrderIsAcceptedByTheRealSettlement() external {
        bytes memory recipe = _recipe(
            "presign",
            address(presign),
            abi.encodeCall(PresignSteps.presignSellAll, (WXDAI, COW, recipient, 1, 1000, 30 minutes, bytes32(0)))
        );

        address drop = executor.dropOf(owner, recipe);
        deal(WXDAI, drop, 10e18);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        LibCowOrder.Data memory order = LibCowOrder.Data({
            sellToken: IERC20(WXDAI),
            buyToken: IERC20(COW),
            receiver: recipient,
            sellAmount: 10e18,
            buyAmount: (10e18 * 1) / 1000,
            validTo: uint32(block.timestamp + 30 minutes),
            appData: bytes32(0),
            feeAmount: 0,
            kind: Orders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: Orders.BALANCE_ERC20,
            buyTokenBalance: Orders.BALANCE_ERC20
        });
        bytes memory uid =
            Orders.packUid(LibCowOrder.hash(order, ISettlementLike(SETTLEMENT).domainSeparator()), drop, order.validTo);

        // The real GPv2Settlement only records a pre-signature if the caller is the order's owner,
        // so this passing proves the drop signed as itself.
        assertGt(ISettlementLike(SETTLEMENT).preSignature(uid), 0, "settlement did not record the pre-signature");
        assertEq(IERC20Like(WXDAI).allowance(drop, VAULT_RELAYER), type(uint256).max, "vault relayer allowance not set");
    }

    // --- path C against the real ComposableCoW + TWAP handler --------------------------------

    /// @dev The load-bearing test for path C. It reproduces exactly what the watch tower does —
    ///      `getTradeableOrderWithSignature`, then hand the signature to the owner's
    ///      `isValidSignature` — for a non-Safe owner. If a cow-shed drop could not be a
    ///      conditional-order owner, this is where it would show up.
    function test_fork_twapIsTradeableAndTheDropValidatesTheSignature() external {
        uint256 n = 12;
        bytes memory recipe = _recipe(
            "twap",
            address(twapSteps),
            abi.encodeCall(
                TwapSteps.twapFromBalance, (WXDAI, COW, recipient, n, 1 hours, 0, 1, 1000, bytes32(0), bytes32(0))
            )
        );

        address drop = executor.dropOf(owner, recipe);
        deal(WXDAI, drop, 120e18);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        TwapSteps.TwapData memory twap = TwapSteps.TwapData({
            sellToken: WXDAI,
            buyToken: COW,
            receiver: recipient,
            partSellAmount: 10e18,
            minPartLimit: (10e18 * 1) / 1000,
            t0: 0,
            n: n,
            t: 1 hours,
            span: 0,
            appData: bytes32(0)
        });
        IConditionalOrder.ConditionalOrderParams memory params = IConditionalOrder.ConditionalOrderParams({
            handler: IConditionalOrder(TWAP_HANDLER), salt: bytes32(0), staticInput: abi.encode(twap)
        });
        bytes32 paramsHash = keccak256(abi.encode(params));

        assertTrue(
            IComposableCowFork(COMPOSABLE_COW).singleOrders(drop, paramsHash), "conditional order not registered"
        );
        assertEq(
            uint256(IComposableCowFork(COMPOSABLE_COW).cabinet(drop, paramsHash)),
            block.timestamp,
            "start time not seeded from the value factory"
        );

        // What the watch tower calls. Reverting here means no order would ever be posted.
        (LibCowOrder.Data memory order, bytes memory signature) =
            IComposableCowFork(COMPOSABLE_COW).getTradeableOrderWithSignature(drop, params, "", new bytes32[](0));

        assertEq(address(order.sellToken), WXDAI, "wrong sell token");
        assertEq(address(order.buyToken), COW, "wrong buy token");
        assertEq(order.sellAmount, 10e18, "part size is not the arrived balance split n ways");
        assertEq(order.receiver, recipient, "wrong receiver");

        // And what the CoW API / settlement then does with that signature.
        bytes32 digest = LibCowOrder.hash(order, IComposableCowFork(COMPOSABLE_COW).domainSeparator());
        assertEq(
            IERC1271(drop).isValidSignature(digest, signature),
            MAGIC_VALUE_1271,
            "the drop did not validate its own conditional order"
        );
    }

    /// @notice The same end-to-end proof for the stop-loss step, against the real deployed handler.
    ///
    /// @dev The oracles are mocked, everything else is real: the live `ComposableCoW`, the live
    ///      `StopLoss` handler at its canonical address, and a drop that has to answer ERC-1271 for it.
    ///      Mocking only the price feeds is what makes the *trigger* controllable while still proving
    ///      the thing that actually matters — that the deployed handler decodes our hand-copied
    ///      `StopLossData` field-for-field. A layout error would surface here as a nonsense order or a
    ///      revert, not as a passing test.
    function test_fork_stopLossIsTradeableOnceTheStrikeIsCrossed() external {
        uint256 validity = 7 days;
        StopLossSteps.Trigger memory trigger = StopLossSteps.Trigger({
            sellTokenPriceOracle: SELL_ORACLE,
            buyTokenPriceOracle: BUY_ORACLE,
            // Fires when sellPrice/buyPrice <= strike. The feeds below sit under this.
            strike: 2e18,
            maxTimeSinceLastOracleUpdate: 1 hours
        });

        bytes memory recipe = _recipe(
            "stoploss",
            address(stopLossSteps),
            abi.encodeCall(
                StopLossSteps.stopLossFromBalance,
                (WXDAI, COW, recipient, 1, 1000, validity, trigger, false, bytes32(0), bytes32(0))
            )
        );

        address drop = executor.dropOf(owner, recipe);
        deal(WXDAI, drop, 100e18);

        // Both feeds 8-decimal, same quote currency, fresh. Rate = 1e8/1e8 * 1e18 = 1e18 <= 2e18.
        _mockFeed(SELL_ORACLE, 1e8);
        _mockFeed(BUY_ORACLE, 1e8);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        StopLossSteps.StopLossData memory data = StopLossSteps.StopLossData({
            sellToken: WXDAI,
            buyToken: COW,
            sellAmount: 100e18,
            buyAmount: (100e18 * 1) / 1000,
            appData: bytes32(0),
            receiver: recipient,
            isSellOrder: true,
            isPartiallyFillable: false,
            // casting to 'uint32' is safe because the fork's timestamp plus a test validity is far
            // below 2^32
            // forge-lint: disable-next-line(unsafe-typecast)
            validTo: uint32(block.timestamp + validity),
            sellTokenPriceOracle: SELL_ORACLE,
            buyTokenPriceOracle: BUY_ORACLE,
            strike: 2e18,
            maxTimeSinceLastOracleUpdate: 1 hours
        });
        IConditionalOrder.ConditionalOrderParams memory params = IConditionalOrder.ConditionalOrderParams({
            handler: IConditionalOrder(STOP_LOSS_HANDLER), salt: bytes32(0), staticInput: abi.encode(data)
        });

        assertTrue(
            IComposableCowFork(COMPOSABLE_COW).singleOrders(drop, keccak256(abi.encode(params))),
            "stop-loss not registered for the drop"
        );

        // What the watch tower calls. If the handler decoded our struct differently, this is where it
        // would revert or hand back an order with the wrong fields.
        (LibCowOrder.Data memory order, bytes memory signature) =
            IComposableCowFork(COMPOSABLE_COW).getTradeableOrderWithSignature(drop, params, "", new bytes32[](0));

        assertEq(address(order.sellToken), WXDAI, "sellToken decoded wrongly");
        assertEq(address(order.buyToken), COW, "buyToken decoded wrongly");
        assertEq(order.sellAmount, 100e18, "sellAmount is not the balance that arrived");
        assertEq(order.receiver, recipient, "receiver decoded wrongly");

        // And the drop vouches for it, which is what makes a cow-shed drop able to own the order.
        bytes32 digest = LibCowOrder.hash(order, IComposableCowFork(COMPOSABLE_COW).domainSeparator());
        assertEq(IERC1271(drop).isValidSignature(digest, signature), bytes4(0x1626ba7e), "drop rejected its own order");

        // The other side of the trigger, which is what pins the direction documented on `Trigger.strike`:
        // move the sell token *up* against the buy token and the order must stop being tradeable. If
        // base and quote were the other way round, this would still return an order.
        _mockFeed(SELL_ORACLE, 3e8);
        vm.expectRevert();
        IComposableCowFork(COMPOSABLE_COW).getTradeableOrderWithSignature(drop, params, "", new bytes32[](0));
    }

    /// @dev Chainlink's `latestRoundData` and `decimals`, enough for `StopLoss` to price the pair.
    function _mockFeed(address feed, int256 answer) internal {
        vm.mockCall(feed, abi.encodeWithSignature("decimals()"), abi.encode(uint8(8)));
        vm.mockCall(
            feed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), answer, block.timestamp, block.timestamp, uint80(1))
        );
    }

    // --- activation as the order's pre-hook --------------------------------------------------

    /// @dev What the order book and the solver both do with an order posted for a drop that does
    ///      not exist yet: run the pre-hook through the trampoline as the settlement contract, then
    ///      ask the owner whether it signed. Before the hook the owner has no code; after it the
    ///      drop is deployed, registered with the real ComposableCoW and has approved the relayer.
    function test_fork_orderPostedBeforeActivationValidatesOnceItsPreHookRuns() external {
        SellBalanceHandler handler = new SellBalanceHandler(executor);
        TokenSteps tokenSteps = new TokenSteps();

        bytes memory prefix = '{"appCode":"cow-drop","metadata":{"hooks":{"pre":[{"callData":"0x';
        bytes memory suffix = bytes(
            string.concat(
                '","gasLimit":"900000","target":"', vm.toString(address(executor)), '"}]}},"version":"1.1.0"}'
            )
        );

        IConditionalOrder.ConditionalOrderParams memory params = IConditionalOrder.ConditionalOrderParams({
            handler: IConditionalOrder(address(handler)),
            salt: bytes32(0),
            staticInput: abi.encode(
                SellBalanceHandler.Data({
                    sellToken: WXDAI,
                    buyToken: COW,
                    receiver: recipient,
                    limitNumerator: 1,
                    limitDenominator: 1000,
                    validitySeconds: 30 minutes,
                    strict: true,
                    appData: bytes32(0),
                    appDataPrefix: prefix,
                    appDataSuffix: suffix
                })
            )
        });

        Call[] memory calls = new Call[](3);
        calls[0] = Call({
            target: address(tokenSteps),
            value: 0,
            callData: abi.encodeCall(TokenSteps.approveMax, (WXDAI, VAULT_RELAYER)),
            allowFailure: false,
            isDelegateCall: true
        });
        calls[1] = Call({
            target: COMPOSABLE_COW,
            value: 0,
            callData: abi.encodeCall(IComposableCowLike.create, (params, true)),
            allowFailure: false,
            isDelegateCall: false
        });
        // Last: tells the handler the whole recipe ran in this transaction.
        calls[2] = Call({
            target: address(handler),
            value: 0,
            callData: abi.encodeCall(HookOrderBase.markRan, (WXDAI)),
            allowFailure: false,
            isDelegateCall: false
        });
        bytes memory recipe =
            abi.encode(DropExecutor.Recipe({label: "hook", salt: bytes32(0), once: false, calls: calls}));

        address drop = executor.dropOf(owner, recipe);
        deal(WXDAI, drop, 10e18);

        // Everything below is built off-chain, from the recipe and the balance alone.
        bytes memory hook = abi.encodeCall(DropExecutor.activate, (owner, recipe));
        LibCowOrder.Data memory order = LibCowOrder.Data({
            sellToken: IERC20(WXDAI),
            buyToken: IERC20(COW),
            receiver: recipient,
            sellAmount: 10e18,
            buyAmount: 10e18 / 1000,
            validTo: uint32(block.timestamp + 30 minutes),
            appData: keccak256(abi.encodePacked(prefix, _hex(hook), suffix)),
            feeAmount: 0,
            kind: Orders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: Orders.BALANCE_ERC20,
            buyTokenBalance: Orders.BALANCE_ERC20
        });
        bytes memory signature = abi.encode(
            order,
            IComposableCow.PayloadStruct({
                proof: new bytes32[](0), params: params, offchainInput: abi.encode(owner, recipe)
            })
        );
        bytes32 digest = LibCowOrder.hash(order, IComposableCowFork(COMPOSABLE_COW).domainSeparator());

        assertEq(drop.code.length, 0, "the drop must not exist before the hook");

        IHooksTrampoline.Hook[] memory hooks = new IHooksTrampoline.Hook[](1);
        hooks[0] = IHooksTrampoline.Hook({target: address(executor), callData: hook, gasLimit: 900_000});
        assertEq(_hookThenValidate(hooks, drop, digest, signature), MAGIC_VALUE_1271, "order not valid after the hook");
        assertGt(drop.code.length, 0, "the hook did not deploy the drop");
        assertEq(IERC20Like(WXDAI).allowance(drop, VAULT_RELAYER), type(uint256).max, "relayer not approved");

        // The same signature cannot carry a different appData past the drop.
        order.appData = keccak256("someone else's fee");
        signature = abi.encode(
            order,
            IComposableCow.PayloadStruct({
                proof: new bytes32[](0), params: params, offchainInput: abi.encode(owner, recipe)
            })
        );
        digest = LibCowOrder.hash(order, IComposableCowFork(COMPOSABLE_COW).domainSeparator());
        vm.expectRevert();
        SameTransaction(SETTLEMENT)
            .run(
                HOOKS_TRAMPOLINE,
                abi.encodeCall(IHooksTrampoline.execute, (hooks)),
                false,
                drop,
                abi.encodeCall(IERC1271.isValidSignature, (digest, signature))
            );
    }

    /// @dev The any-token counterpart: the recipe names no sell token, the order does, and the hook
    ///      that carries it is what makes the drop approve exactly that token.
    function test_fork_paymentOrderInAnUnnamedTokenValidatesOnceItsPreHookRuns() external {
        PaymentSteps payments = new PaymentSteps(ISettlementLike(SETTLEMENT), VAULT_RELAYER, executor);
        HookPaymentSteps hookPayments = new HookPaymentSteps(VAULT_RELAYER, payments);
        PaymentHandler handler = new PaymentHandler(executor);

        bytes memory prefix = '{"appCode":"cow-drop","metadata":{"hooks":{"pre":[{"callData":"0x';
        bytes memory suffix = bytes(
            string.concat(
                '","gasLimit":"900000","target":"', vm.toString(address(payments)), '"}]}},"version":"1.1.0"}'
            )
        );

        IConditionalOrder.ConditionalOrderParams memory params = IConditionalOrder.ConditionalOrderParams({
            handler: IConditionalOrder(address(handler)),
            salt: bytes32(0),
            staticInput: abi.encode(
                PaymentHandler.Data({
                    buyToken: COW,
                    buyAmount: 1e16,
                    receiver: recipient,
                    validitySeconds: 30 minutes,
                    strict: true,
                    appData: bytes32(0),
                    appDataPrefix: prefix,
                    appDataSuffix: suffix
                })
            )
        });

        Call[] memory calls = new Call[](2);
        calls[0] = Call({
            target: address(hookPayments),
            value: 0,
            callData: abi.encodeCall(HookPaymentSteps.approvePayment, (COW, recipient, address(handler))),
            allowFailure: false,
            isDelegateCall: true
        });
        calls[1] = Call({
            target: COMPOSABLE_COW,
            value: 0,
            callData: abi.encodeCall(IComposableCowLike.create, (params, true)),
            allowFailure: false,
            isDelegateCall: false
        });
        bytes memory recipe =
            abi.encode(DropExecutor.Recipe({label: "pay", salt: bytes32(0), once: false, calls: calls}));

        address drop = executor.dropOf(owner, recipe);
        deal(WXDAI, drop, 10e18);

        bytes memory hook = abi.encodeCall(PaymentSteps.activatePayment, (owner, recipe, WXDAI));
        LibCowOrder.Data memory order = LibCowOrder.Data({
            sellToken: IERC20(WXDAI),
            buyToken: IERC20(COW),
            receiver: recipient,
            sellAmount: 10e18,
            buyAmount: 1e16,
            validTo: uint32(block.timestamp + 30 minutes),
            appData: keccak256(abi.encodePacked(prefix, _hex(hook), suffix)),
            feeAmount: 0,
            kind: Orders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: Orders.BALANCE_ERC20,
            buyTokenBalance: Orders.BALANCE_ERC20 // gitleaks:allow (balance-kind constant, not a secret)
        });
        bytes memory signature = abi.encode(
            order,
            IComposableCow.PayloadStruct({
                proof: new bytes32[](0), params: params, offchainInput: abi.encode(owner, recipe)
            })
        );
        bytes32 digest = LibCowOrder.hash(order, IComposableCowFork(COMPOSABLE_COW).domainSeparator());

        assertEq(drop.code.length, 0, "the drop must not exist before the hook");

        IHooksTrampoline.Hook[] memory hooks = new IHooksTrampoline.Hook[](1);
        hooks[0] = IHooksTrampoline.Hook({target: address(payments), callData: hook, gasLimit: 900_000});
        assertEq(_hookThenValidate(hooks, drop, digest, signature), MAGIC_VALUE_1271, "order not valid after the hook");
        assertGt(drop.code.length, 0, "the hook did not deploy the drop");
        assertEq(IERC20Like(WXDAI).allowance(drop, VAULT_RELAYER), type(uint256).max, "relayer not approved");
    }

    /// @dev A recipe with nothing to re-check: the hook matters once, to deploy the drop. After that
    ///      the same drop signs an order that carries no hook at all, in a transaction of its own.
    function test_fork_followUpOrderNeedsNoHookOnceTheDropExists() external {
        SellBalanceHandler handler = new SellBalanceHandler(executor);
        TokenSteps tokenSteps = new TokenSteps();
        bytes32 hookFree = keccak256("hook-free");

        bytes memory prefix = '{"appCode":"cow-drop","metadata":{"hooks":{"pre":[{"callData":"0x';
        bytes memory suffix = bytes(
            string.concat(
                '","gasLimit":"900000","target":"', vm.toString(address(executor)), '"}]}},"version":"1.1.0"}'
            )
        );
        IConditionalOrder.ConditionalOrderParams memory params = IConditionalOrder.ConditionalOrderParams({
            handler: IConditionalOrder(address(handler)),
            salt: bytes32(0),
            staticInput: abi.encode(
                SellBalanceHandler.Data({
                    sellToken: WXDAI,
                    buyToken: COW,
                    receiver: recipient,
                    limitNumerator: 1,
                    limitDenominator: 1000,
                    validitySeconds: 30 minutes,
                    strict: false,
                    appData: hookFree,
                    appDataPrefix: prefix,
                    appDataSuffix: suffix
                })
            )
        });

        Call[] memory calls = new Call[](2);
        calls[0] = Call({
            target: address(tokenSteps),
            value: 0,
            callData: abi.encodeCall(TokenSteps.approveMax, (WXDAI, VAULT_RELAYER)),
            allowFailure: false,
            isDelegateCall: true
        });
        calls[1] = Call({
            target: COMPOSABLE_COW,
            value: 0,
            callData: abi.encodeCall(IComposableCowLike.create, (params, true)),
            allowFailure: false,
            isDelegateCall: false
        });
        bytes memory recipe =
            abi.encode(DropExecutor.Recipe({label: "basic", salt: bytes32(0), once: false, calls: calls}));
        address drop = executor.dropOf(owner, recipe);
        deal(WXDAI, drop, 10e18);

        LibCowOrder.Data memory order = LibCowOrder.Data({
            sellToken: IERC20(WXDAI),
            buyToken: IERC20(COW),
            receiver: recipient,
            sellAmount: 10e18,
            buyAmount: 10e18 / 1000,
            validTo: uint32(block.timestamp + 30 minutes),
            appData: hookFree,
            feeAmount: 0,
            kind: Orders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: Orders.BALANCE_ERC20,
            buyTokenBalance: Orders.BALANCE_ERC20 // gitleaks:allow (balance-kind constant, not a secret)
        });
        // No recipe in the signature: this order has no hook to rebuild.
        bytes memory signature = abi.encode(
            order, IComposableCow.PayloadStruct({proof: new bytes32[](0), params: params, offchainInput: ""})
        );
        bytes32 digest = LibCowOrder.hash(order, IComposableCowFork(COMPOSABLE_COW).domainSeparator());

        // Before the drop exists nothing can sign for it, hook-free order or not.
        assertEq(drop.code.length, 0);
        (, bytes memory answer) = drop.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
        assertEq(answer.length, 0, "an address with no code vouched for an order");

        // The first order's hook, in some earlier settlement.
        IHooksTrampoline.Hook[] memory hooks = new IHooksTrampoline.Hook[](1);
        hooks[0] = IHooksTrampoline.Hook({
            target: address(executor),
            callData: abi.encodeCall(DropExecutor.activate, (owner, recipe)),
            gasLimit: 900_000
        });
        vm.prank(SETTLEMENT);
        IHooksTrampoline(HOOKS_TRAMPOLINE).execute(hooks);

        assertEq(IERC1271(drop).isValidSignature(digest, signature), MAGIC_VALUE_1271, "follow-up order not valid");
    }

    /// @dev The pre-hook and the signature check in one transaction, with the settlement contract as
    ///      the caller of both, which is how a settlement runs them. The handler only accepts an order
    ///      in the transaction its recipe ran in, so checking in a later call would prove nothing.
    ///
    ///      The settlement's code is swapped for a relay to get there; it is only the caller here.
    function _hookThenValidate(
        IHooksTrampoline.Hook[] memory hooks,
        address drop,
        bytes32 digest,
        bytes memory signature
    ) internal returns (bytes4) {
        vm.etch(SETTLEMENT, address(new SameTransaction()).code);
        bytes memory answer = SameTransaction(SETTLEMENT)
            .run(
                HOOKS_TRAMPOLINE,
                abi.encodeCall(IHooksTrampoline.execute, (hooks)),
                false,
                drop,
                abi.encodeCall(IERC1271.isValidSignature, (digest, signature))
            );
        return abi.decode(answer, (bytes4));
    }

    /// @dev `vm.toString(bytes)` without its `0x`.
    function _hex(bytes memory data) internal pure returns (bytes memory out) {
        bytes memory prefixed = bytes(vm.toString(data));
        out = new bytes(prefixed.length - 2);
        for (uint256 i; i < out.length; ++i) {
            out[i] = prefixed[i + 2];
        }
    }
}
