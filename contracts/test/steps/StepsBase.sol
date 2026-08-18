// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {DropExecutor} from "src/DropExecutor.sol";
import {IComposableCowLike, ISettlementLike} from "src/interfaces/IDropExternal.sol";
import {GuardSteps} from "src/steps/GuardSteps.sol";
import {PresignSteps} from "src/steps/PresignSteps.sol";
import {StopLossSteps} from "src/steps/StopLossSteps.sol";
import {TokenSteps} from "src/steps/TokenSteps.sol";
import {TwapSteps} from "src/steps/TwapSteps.sol";

import {COWShed} from "cow-shed/COWShed.sol";
import {COWShedExecutorFactory} from "cow-shed/COWShedExecutorFactory.sol";
import {Call} from "cow-shed/ICOWAuthHook.sol";
import {IComposableCow} from "cow-shed/IComposableCow.sol";

import {
    MockComposableCow,
    MockERC20,
    MockPriceFeed,
    MockReadable,
    MockSettlement,
    MockWrappedNative
} from "../mocks/Mocks.sol";

/// @dev Local mirror of `IConditionalOrder.ConditionalOrderParams` with `handler` as a plain address,
///      so tests can build the struct without importing the interface type.
struct ConditionalOrderParamsMirror {
    address handler;
    bytes32 salt;
    bytes staticInput;
}

/// @notice The shared harness for the step-contract suites.
///
/// @dev Every step test runs its step the way it actually runs: delegatecalled from inside a drop by an
///      activation nobody signed. Calling a step contract directly would read *its* balance, which is
///      always zero, so a test that did that would pass while proving nothing.
abstract contract StepsBase is Test {
    COWShedExecutorFactory internal factory;
    DropExecutor internal executor;

    GuardSteps internal guards;
    TokenSteps internal tokenOps;
    PresignSteps internal presign;
    TwapSteps internal twapSteps;
    StopLossSteps internal stopLossSteps;

    MockSettlement internal settlement;
    MockComposableCow internal composableCow;
    MockERC20 internal sellToken;
    MockERC20 internal buyToken;
    MockWrappedNative internal wrappedNative;

    address internal constant VAULT_RELAYER = address(0xC92E);
    address internal constant TWAP_HANDLER = address(0x7A9F);
    address internal constant STOP_LOSS_HANDLER = address(0x570F);
    address internal constant TIMESTAMP_FACTORY = address(0x715);

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal recipient = makeAddr("recipient");

    function setUp() public virtual {
        factory = new COWShedExecutorFactory(address(new COWShed()));

        settlement = new MockSettlement(keccak256("domain"));
        composableCow = new MockComposableCow(keccak256("ccow-domain"));
        executor = new DropExecutor(factory, IComposableCow(address(composableCow)));
        sellToken = new MockERC20();
        buyToken = new MockERC20();
        wrappedNative = new MockWrappedNative();

        guards = new GuardSteps();
        tokenOps = new TokenSteps();
        presign = new PresignSteps(ISettlementLike(address(settlement)), VAULT_RELAYER);
        twapSteps =
            new TwapSteps(VAULT_RELAYER, IComposableCowLike(address(composableCow)), TWAP_HANDLER, TIMESTAMP_FACTORY);

        stopLossSteps = new StopLossSteps(VAULT_RELAYER, IComposableCowLike(address(composableCow)), STOP_LOSS_HANDLER);

        // Timestamps below uint32 max, so `validTo` arithmetic is meaningful.
        vm.warp(1_800_000_000);
    }

    // --- helpers ---------------------------------------------------------------------------

    /// @dev One delegatecall into a step contract, wrapped as a complete recipe.
    function _recipe(bytes32 label, address target, bytes memory callData) internal pure returns (bytes memory) {
        Call[] memory calls = new Call[](1);
        calls[0] = _step(target, callData);
        return _recipeOf(label, false, calls);
    }

    /// @dev A step: always a delegatecall, since that is the only way `address(this)` is the drop.
    function _step(address target, bytes memory callData) internal pure returns (Call memory) {
        return Call({target: target, value: 0, callData: callData, allowFailure: false, isDelegateCall: true});
    }

    function _recipeOf(bytes32 label, bool once, Call[] memory calls) internal pure returns (bytes memory) {
        return abi.encode(DropExecutor.Recipe({label: label, salt: bytes32(0), once: once, calls: calls}));
    }

    function _presignRecipe(uint256 limitNum, uint256 limitDen) internal view returns (bytes memory) {
        return _recipe(
            "presign",
            address(presign),
            abi.encodeCall(
                PresignSteps.presignSellAll,
                (address(sellToken), address(buyToken), recipient, limitNum, limitDen, 1 hours, bytes32(0))
            )
        );
    }

    function _twapRecipe(uint256 n, uint256 t) internal view returns (bytes memory) {
        return _recipe(
            "twap",
            address(twapSteps),
            abi.encodeCall(
                TwapSteps.twapFromBalance,
                (address(sellToken), address(buyToken), address(0), n, t, 0, 95, 100, bytes32(0), bytes32(0))
            )
        );
    }

    /// @dev The params hash ComposableCoW keys a registration by, for the TWAP handler.
    function _twapParamsHash(TwapSteps.TwapData memory twap) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ConditionalOrderParamsMirror({handler: TWAP_HANDLER, salt: bytes32(0), staticInput: abi.encode(twap)})
            )
        );
    }
}
