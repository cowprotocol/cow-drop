// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {NothingToSell} from "src/lib/Errors.sol";
import {StaleOraclePrice} from "src/lib/Oracle.sol";
import {Orders} from "src/lib/Orders.sol";
import {PresignSteps} from "src/steps/PresignSteps.sol";

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {MockPriceFeed} from "../mocks/Mocks.sol";
import {StepsBase} from "./StepsBase.sol";

contract OraclePresignTest is StepsBase {
    MockPriceFeed internal sellFeed;
    MockPriceFeed internal buyFeed;

    function setUp() public override {
        super.setUp();
        // Both 8-decimal, same quote currency. 2.00 vs 1.00 => one sellToken is worth two buyTokens.
        sellFeed = new MockPriceFeed(8, 2e8);
        buyFeed = new MockPriceFeed(8, 1e8);
    }

    function _oracle(uint256 haircutBps) internal view returns (PresignSteps.OraclePrice memory) {
        return PresignSteps.OraclePrice({
            sellTokenPriceOracle: address(sellFeed),
            buyTokenPriceOracle: address(buyFeed),
            maxAge: 1 hours,
            haircutBps: haircutBps
        });
    }

    function _recipeAt(uint256 floorNum, uint256 floorDen, uint256 haircutBps) internal view returns (bytes memory) {
        return _recipe(
            "oracle-presign",
            address(presign),
            abi.encodeCall(
                PresignSteps.presignSellAllAtOracle,
                (
                    address(sellToken),
                    address(buyToken),
                    recipient,
                    floorNum,
                    floorDen,
                    _oracle(haircutBps),
                    1 hours,
                    bytes32(0)
                )
            )
        );
    }

    /// @dev Reads back the buyAmount the drop actually signed, by rebuilding the order and checking the
    ///      settlement recorded that exact UID.
    function _signedBuyAmount(address drop, uint256 sellAmount, uint256 expectedBuy) internal view returns (bool) {
        LibCowOrder.Data memory order = LibCowOrder.Data({
            sellToken: IERC20(address(sellToken)),
            buyToken: IERC20(address(buyToken)),
            receiver: recipient,
            sellAmount: sellAmount,
            buyAmount: expectedBuy,
            validTo: uint32(block.timestamp + 1 hours),
            appData: bytes32(0),
            feeAmount: 0,
            kind: Orders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: Orders.BALANCE_ERC20,
            buyTokenBalance: Orders.BALANCE_ERC20
        });
        bytes32 digest = LibCowOrder.hash(order, settlement.domainSeparator());
        return settlement.preSignature(Orders.packUid(digest, drop, order.validTo)) > 0;
    }

    function test_oraclePresign_usesTheOracleWhenItBeatsTheFloor() external {
        // Floor of 1.0 buy per sell; the oracle says 2.0, so the oracle wins.
        bytes memory recipe = _recipeAt(1, 1, 0);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 100e18);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertTrue(_signedBuyAmount(drop, 100e18, 200e18), "oracle price was not used");
    }

    /// @dev The whole reason the floor exists. Activation is permissionless, so an activator picks the
    ///      moment and therefore the oracle reading. Here they pick a terrible one — and the committed
    ///      floor is what they run into.
    function test_oraclePresign_aBadOracleTickCannotPushTheLimitBelowTheFloor() external {
        bytes memory recipe = _recipeAt(1, 1, 0);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 100e18);

        // The sell token "crashes" to a hundredth of the buy token.
        sellFeed.set(1e6, block.timestamp);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        // Not 1e18 (the oracle's number) — the floor of 1.0 buy per sell.
        assertTrue(_signedBuyAmount(drop, 100e18, 100e18), "a bad oracle tick got through the floor");
    }

    function test_oraclePresign_appliesTheHaircutToTheOracleSideOnly() external {
        // Oracle says 200e18; a 100 bps haircut makes it 198e18, still above the 1.0 floor.
        bytes memory recipe = _recipeAt(1, 1, 100);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 100e18);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertTrue(_signedBuyAmount(drop, 100e18, 198e18), "haircut not applied as expected");
    }

    function test_oraclePresign_rejectsAStaleFeed() external {
        bytes memory recipe = _recipeAt(1, 1, 0);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 100e18);

        vm.warp(block.timestamp + 2 hours); // older than maxAge
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(StaleOraclePrice.selector, address(sellFeed), block.timestamp - 2 hours, 1 hours)
        );
        executor.activate(owner, recipe);
    }

    function test_oraclePresign_rejectsAHaircutOverOneHundredPercent() external {
        bytes memory recipe = _recipeAt(1, 1, 10_001);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 100e18);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PresignSteps.HaircutTooLarge.selector, uint256(10_001)));
        executor.activate(owner, recipe);
    }

    function test_oraclePresign_revertsWhenNothingArrived() external {
        vm.prank(keeper);
        vm.expectRevert(NothingToSell.selector);
        executor.activate(owner, _recipeAt(1, 1, 0));
    }
}
