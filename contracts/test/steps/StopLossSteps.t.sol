// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {NothingToSell} from "src/lib/Errors.sol";
import {Orders} from "src/lib/Orders.sol";
import {StopLossSteps} from "src/steps/StopLossSteps.sol";

import {ConditionalOrderParamsMirror, StepsBase} from "./StepsBase.sol";

contract StopLossStepsTest is StepsBase {
    address internal constant SELL_ORACLE = address(0x0A01);
    address internal constant BUY_ORACLE = address(0x0A02);
    int256 internal constant STRIKE = 1.8e18;
    uint256 internal constant MAX_STALENESS = 1 hours;

    function _trigger() internal pure returns (StopLossSteps.Trigger memory) {
        return StopLossSteps.Trigger({
            sellTokenPriceOracle: SELL_ORACLE,
            buyTokenPriceOracle: BUY_ORACLE,
            strike: STRIKE,
            maxTimeSinceLastOracleUpdate: MAX_STALENESS
        });
    }

    function _stopLossRecipe(uint256 validitySeconds) internal view returns (bytes memory) {
        return _recipe(
            "stoploss",
            address(stopLossSteps),
            abi.encodeCall(
                StopLossSteps.stopLossFromBalance,
                (
                    address(sellToken),
                    address(buyToken),
                    address(0),
                    95,
                    100,
                    validitySeconds,
                    _trigger(),
                    false,
                    bytes32(0),
                    bytes32(0)
                )
            )
        );
    }

    function _expected(uint256 arrived, uint32 validTo) internal view returns (StopLossSteps.StopLossData memory) {
        return StopLossSteps.StopLossData({
            sellToken: address(sellToken),
            buyToken: address(buyToken),
            sellAmount: arrived,
            buyAmount: (arrived * 95) / 100,
            appData: bytes32(0),
            receiver: address(0),
            isSellOrder: true,
            isPartiallyFillable: false,
            validTo: validTo,
            sellTokenPriceOracle: SELL_ORACLE,
            buyTokenPriceOracle: BUY_ORACLE,
            strike: STRIKE,
            maxTimeSinceLastOracleUpdate: MAX_STALENESS
        });
    }

    function test_stopLossFromBalance_sellsWhateverArrivedInOneOrder() external {
        bytes memory recipe = _stopLossRecipe(7 days);
        address drop = executor.dropOf(owner, recipe);

        uint256 arrived = 1234.5e18;
        sellToken.mint(drop, arrived);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        bytes32 paramsHash = keccak256(
            abi.encode(
                ConditionalOrderParamsMirror({
                    handler: STOP_LOSS_HANDLER,
                    salt: bytes32(0),
                    staticInput: abi.encode(_expected(arrived, uint32(block.timestamp + 7 days)))
                })
            )
        );

        assertTrue(composableCow.singleOrders(drop, paramsHash), "stop-loss not registered for the drop");
        assertTrue(composableCow.lastDispatch(), "dispatch must be true so the watch tower sees it");
        assertEq(sellToken.allowance(drop, VAULT_RELAYER), type(uint256).max, "relayer not approved");
    }

    /// @dev The reason the deadline is a duration rather than an absolute timestamp: a recipe is
    ///      committed into an address long before it is funded, so an absolute `validTo` would start
    ///      running when the address was *computed*. Resolving it here starts it at activation.
    function test_stopLossFromBalance_deadlineRunsFromActivationNotFromAuthoring() external {
        bytes memory recipe = _stopLossRecipe(7 days);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 100e18);

        // A long wait between writing the recipe and anyone funding it.
        vm.warp(block.timestamp + 365 days);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        bytes32 paramsHash = keccak256(
            abi.encode(
                ConditionalOrderParamsMirror({
                    handler: STOP_LOSS_HANDLER,
                    salt: bytes32(0),
                    staticInput: abi.encode(_expected(100e18, uint32(block.timestamp + 7 days)))
                })
            )
        );
        assertTrue(composableCow.singleOrders(drop, paramsHash), "validTo did not start at activation");
    }

    function test_stopLossFromBalance_keepsParamsOwnerIndependent() external {
        bytes memory recipe = _stopLossRecipe(7 days);

        address dropA = executor.dropOf(owner, recipe);
        address dropB = executor.dropOf(keeper, recipe);
        sellToken.mint(dropA, 100e18);
        sellToken.mint(dropB, 100e18);

        executor.activate(owner, recipe);
        executor.activate(keeper, recipe);

        bytes32 paramsHash = keccak256(
            abi.encode(
                ConditionalOrderParamsMirror({
                    handler: STOP_LOSS_HANDLER,
                    salt: bytes32(0),
                    staticInput: abi.encode(_expected(100e18, uint32(block.timestamp + 7 days)))
                })
            )
        );
        assertTrue(composableCow.singleOrders(dropA, paramsHash), "owner A");
        assertTrue(composableCow.singleOrders(dropB, paramsHash), "owner B");
    }

    function test_stopLossFromBalance_revertsWhenNothingArrived() external {
        vm.prank(keeper);
        vm.expectRevert(NothingToSell.selector);
        executor.activate(owner, _stopLossRecipe(7 days));
    }

    function test_stopLossFromBalance_rejectsAZeroValidity() external {
        bytes memory recipe = _stopLossRecipe(0);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 100e18);

        vm.prank(keeper);
        vm.expectRevert(StopLossSteps.NoValidity.selector);
        executor.activate(owner, recipe);
    }

    function test_stopLossFromBalance_revertsOnAPriceThatRoundsToZero() external {
        bytes memory recipe = _recipe(
            "dust",
            address(stopLossSteps),
            abi.encodeCall(
                StopLossSteps.stopLossFromBalance,
                (
                    address(sellToken),
                    address(buyToken),
                    address(0),
                    1,
                    1e30,
                    7 days,
                    _trigger(),
                    false,
                    bytes32(0),
                    bytes32(0)
                )
            )
        );
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 1e6);

        vm.prank(keeper);
        vm.expectRevert(Orders.LimitPriceTooLow.selector);
        executor.activate(owner, recipe);
    }

    /// @dev `StopLossData` is a hand-copy of composable-cow's `StopLoss.Data`, and the deployed handler
    ///      `abi.decode`s our bytes into its own struct — so a field reorder would silently produce a
    ///      valid-looking order with, say, the strike read as the sell amount. Every field gets a
    ///      distinct sentinel so a swapped pair cannot look the same.
    function test_stopLossData_layoutMatchesTheHandlersStruct() external pure {
        StopLossSteps.StopLossData memory d = StopLossSteps.StopLossData({
            sellToken: address(0x1111111111111111111111111111111111111111),
            buyToken: address(0x2222222222222222222222222222222222222222),
            sellAmount: 3,
            buyAmount: 4,
            appData: bytes32(uint256(5)),
            receiver: address(0x6666666666666666666666666666666666666666),
            isSellOrder: true,
            isPartiallyFillable: false,
            validTo: 9,
            sellTokenPriceOracle: address(0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa),
            buyTokenPriceOracle: address(0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB),
            strike: -12,
            maxTimeSinceLastOracleUpdate: 13
        });

        bytes memory expected = abi.encodePacked(
            uint256(uint160(d.sellToken)),
            uint256(uint160(d.buyToken)),
            d.sellAmount,
            d.buyAmount,
            d.appData,
            uint256(uint160(d.receiver)),
            uint256(d.isSellOrder ? 1 : 0),
            uint256(d.isPartiallyFillable ? 1 : 0),
            uint256(d.validTo),
            uint256(uint160(d.sellTokenPriceOracle)),
            uint256(uint160(d.buyTokenPriceOracle)),
            d.strike,
            d.maxTimeSinceLastOracleUpdate
        );

        assertEq(abi.encode(d), expected, "StopLossData no longer encodes as thirteen words in this order");
        assertEq(abi.encode(d).length, 416, "StopLossData is no longer a head-only struct");
    }
}
