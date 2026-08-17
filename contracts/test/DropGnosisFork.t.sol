// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {DropExecutor} from "src/DropExecutor.sol";
import {DropOrders} from "src/DropOrders.sol";
import {DropRecipes} from "src/DropRecipes.sol";
import {IComposableCowLike, IERC20Like, ISettlementLike} from "src/interfaces/IDropExternal.sol";

import {COWShedExecutorFactory} from "cow-shed/COWShedExecutorFactory.sol";
import {IComposableCow} from "cow-shed/IComposableCow.sol";
import {IConditionalOrder} from "cow-shed/IConditionalOrder.sol";
import {Call} from "cow-shed/ICOWAuthHook.sol";
import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

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
    address internal constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    address internal constant VAULT_RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;

    /// @dev cow-shed#79: the live executor factory on Gnosis, over `COWShedWithExecutorSigner`.
    address internal constant EXECUTOR_FACTORY = 0xD4B9497f258bf63A7f21d1DEAF26dA2F23e4DC99;

    address internal constant WXDAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;
    address internal constant COW = 0x177127622c4A00F3d409B75571e12cB3c8973d3c;

    bytes4 internal constant MAGIC_VALUE_1271 = 0x1626ba7e;

    COWShedExecutorFactory internal factory;
    DropExecutor internal executor;
    DropRecipes internal recipes;

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
        recipes = new DropRecipes(
            ISettlementLike(SETTLEMENT),
            VAULT_RELAYER,
            IComposableCowLike(COMPOSABLE_COW),
            TWAP_HANDLER,
            TIMESTAMP_FACTORY
        );
    }

    function _recipe(bytes32 label, bytes memory callData) internal view returns (bytes memory) {
        Call[] memory calls = new Call[](1);
        calls[0] =
            Call({target: address(recipes), value: 0, callData: callData, allowFailure: false, isDelegateCall: true});
        return abi.encode(DropExecutor.Recipe({label: label, salt: bytes32(0), once: false, calls: calls}));
    }

    // --- path P against the real settlement contract -----------------------------------------

    function test_fork_presignedOrderIsAcceptedByTheRealSettlement() external {
        bytes memory recipe = _recipe(
            "presign",
            abi.encodeCall(DropRecipes.presignSellAll, (WXDAI, COW, recipient, 1, 1000, 30 minutes, bytes32(0)))
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
            kind: DropOrders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: DropOrders.BALANCE_ERC20,
            buyTokenBalance: DropOrders.BALANCE_ERC20
        });
        bytes memory uid =
            DropOrders.packUid(LibCowOrder.hash(order, ISettlementLike(SETTLEMENT).domainSeparator()), drop, order.validTo);

        // The real GPv2Settlement only records a pre-signature if the caller is the order's owner,
        // so this passing proves the drop signed as itself.
        assertGt(ISettlementLike(SETTLEMENT).preSignature(uid), 0, "settlement did not record the pre-signature");
        assertEq(
            IERC20Like(WXDAI).allowance(drop, VAULT_RELAYER), type(uint256).max, "vault relayer allowance not set"
        );
    }

    // --- path C against the real ComposableCoW + TWAP handler --------------------------------

    /// @dev The load-bearing test for path C. It reproduces exactly what the watch tower does —
    ///      `getTradeableOrderWithSignature`, then hand the signature to the owner's
    ///      `isValidSignature` — for a non-Safe owner. If a cow-shed drop could not be a
    ///      conditional-order owner, this is where it would show up.
    function test_fork_twapIsTradeableAndTheDropValidatesTheSignature() external {
        uint256 n = 12;
        bytes memory recipe = _recipe(
            "twap", abi.encodeCall(DropRecipes.twapFromBalance, (WXDAI, COW, recipient, n, 1 hours, 0, 1, 1000, bytes32(0), bytes32(0)))
        );

        address drop = executor.dropOf(owner, recipe);
        deal(WXDAI, drop, 120e18);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        DropRecipes.TwapData memory twap = DropRecipes.TwapData({
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
            handler: IConditionalOrder(TWAP_HANDLER),
            salt: bytes32(0),
            staticInput: abi.encode(twap)
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
}
