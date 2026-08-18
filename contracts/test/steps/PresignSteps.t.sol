// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Vm} from "forge-std/Test.sol";

import {NothingToSell} from "src/lib/Errors.sol";
import {Orders} from "src/lib/Orders.sol";
import {PresignSteps} from "src/steps/PresignSteps.sol";

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {StepsBase} from "./StepsBase.sol";

contract DropPresignTest is StepsBase {
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
            kind: Orders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: Orders.BALANCE_ERC20,
            buyTokenBalance: Orders.BALANCE_ERC20
        });
        bytes32 digest = LibCowOrder.hash(expected, settlement.domainSeparator());
        bytes memory uid = Orders.packUid(digest, drop, expected.validTo);

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
            if (logs[i].topics[0] == PresignSteps.DropOrderPlaced.selector) {
                // The poster keys off this: the log's emitter must be the drop, not the step contract.
                assertEq(logs[i].emitter, drop, "DropOrderPlaced not emitted by the drop");
                found = true;
            }
        }
        assertTrue(found, "DropOrderPlaced not emitted");
    }

    function test_presignSellAll_revertsWhenNothingArrived() external {
        bytes memory recipe = _presignRecipe(95, 100);

        vm.prank(keeper);
        vm.expectRevert(NothingToSell.selector);
        executor.activate(owner, recipe);
    }

    function test_presignSellAll_revertsOnAPriceThatRoundsToZero() external {
        bytes memory recipe = _presignRecipe(1, 1e30);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 1e6);

        vm.prank(keeper);
        vm.expectRevert(Orders.LimitPriceTooLow.selector);
        executor.activate(owner, recipe);
    }
}
