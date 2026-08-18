// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {NothingToSell} from "src/lib/Errors.sol";
import {TwapSteps} from "src/steps/TwapSteps.sol";

import {StepsBase} from "./StepsBase.sol";

contract DropComposableTest is StepsBase {
    function test_twapFromBalance_splitsWhateverArrivedIntoParts() external {
        bytes memory recipe = _twapRecipe(12, 1 hours);
        address drop = executor.dropOf(owner, recipe);

        // Deliberately not divisible by 12, as a real bridge payout would not be.
        uint256 arrived = 1000e18 + 7;
        sellToken.mint(drop, arrived);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        uint256 part = arrived / 12;
        bytes32 paramsHash = _twapParamsHash(
            TwapSteps.TwapData({
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
            })
        );

        assertTrue(composableCow.singleOrders(drop, paramsHash), "conditional order not registered for the drop");
        assertEq(composableCow.lastValueFactory(), TIMESTAMP_FACTORY, "start time not seeded from the value factory");
        assertTrue(composableCow.lastDispatch(), "dispatch must be true so the watch tower sees it");
        assertEq(
            uint256(composableCow.cabinet(drop, paramsHash)), block.timestamp, "cabinet not seeded with the start time"
        );
        // The whole balance, not `n * partSellAmount`: the integer division leaves dust behind, and a
        // later top-up should not need a fresh approval.
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

        bytes32 paramsHash = _twapParamsHash(
            TwapSteps.TwapData({
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
            })
        );

        assertTrue(composableCow.singleOrders(dropA, paramsHash), "owner A");
        assertTrue(composableCow.singleOrders(dropB, paramsHash), "owner B");
    }

    function test_twapFromBalance_rejectsASinglePart() external {
        bytes memory recipe = _twapRecipe(1, 1 hours);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 100e18);

        vm.expectRevert(TwapSteps.TooFewParts.selector);
        executor.activate(owner, recipe);
    }

    function test_twapFromBalance_revertsWhenPartsWouldBeZero() external {
        bytes memory recipe = _twapRecipe(12, 1 hours);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 5); // fewer wei than parts

        vm.expectRevert(NothingToSell.selector);
        executor.activate(owner, recipe);
    }

    /// @dev `TwapData` is a hand-copy of composable-cow's `TWAPOrder.Data`, and the real handler
    ///      `abi.decode`s our bytes into its own struct — so the two layouts agreeing is a *correctness*
    ///      requirement, not a style one. Reorder two fields here and the handler would read the buy
    ///      token as the receiver and the limit as the part size, registering an order that looks
    ///      perfectly valid.
    ///
    ///      The behavioural proof lives in `DropGnosisFork.t.sol`, which decodes what the deployed
    ///      handler generates — but that test is skipped without `GNOSIS_RPC_URL`, so on its own it
    ///      would let a field reorder through the default suite. Every field here gets a distinct
    ///      sentinel so a swapped pair cannot look the same.
    function test_twapData_layoutMatchesTheHandlersStruct() external pure {
        TwapSteps.TwapData memory twap = TwapSteps.TwapData({
            sellToken: address(0x1111111111111111111111111111111111111111),
            buyToken: address(0x2222222222222222222222222222222222222222),
            receiver: address(0x3333333333333333333333333333333333333333),
            partSellAmount: 4,
            minPartLimit: 5,
            t0: 6,
            n: 7,
            t: 8,
            span: 9,
            appData: bytes32(uint256(10))
        });

        bytes memory expected = abi.encodePacked(
            uint256(uint160(twap.sellToken)),
            uint256(uint160(twap.buyToken)),
            uint256(uint160(twap.receiver)),
            twap.partSellAmount,
            twap.minPartLimit,
            twap.t0,
            twap.n,
            twap.t,
            twap.span,
            twap.appData
        );

        assertEq(abi.encode(twap), expected, "TwapData no longer encodes as ten words in this order");
        // Ten static words and no dynamic tail. A handler that expects a head-only struct would be
        // handed an offset instead if a field ever became dynamic.
        assertEq(abi.encode(twap).length, 320, "TwapData is no longer a head-only struct");
    }
}
