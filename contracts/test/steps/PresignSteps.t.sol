// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Vm} from "forge-std/Test.sol";

import {CowOrder} from "src/lib/CowOrder.sol";
import {NothingToSell} from "src/lib/Errors.sol";
import {Orders} from "src/lib/Orders.sol";

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
            if (logs[i].topics[0] == CowOrder.CowOrderPlaced.selector) {
                // The poster keys off this: the log's emitter must be the drop, not the step contract.
                assertEq(logs[i].emitter, drop, "CowOrderPlaced not emitted by the drop");
                found = true;
            }
        }
        assertTrue(found, "CowOrderPlaced not emitted");
    }

    /// @dev The whole point of the event: an indexer that has never heard of `PresignSteps` can post
    ///      the order from the log alone. So decode it the way `packages/watch-tower` does and check
    ///      every field it forwards to the order book.
    function test_presignSellAll_theEventCarriesEverythingAPosterNeeds() external {
        bytes memory recipe = _presignRecipe(95, 100);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 100e18);

        vm.recordLogs();
        vm.prank(keeper);
        executor.activate(owner, recipe);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes memory payload;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == CowOrder.CowOrderPlaced.selector) payload = logs[i].data;
        }
        assertGt(payload.length, 0, "CowOrderPlaced not emitted");

        (bytes memory uid, CowOrder.SigningScheme scheme, bytes memory signature, LibCowOrder.Data memory order) =
            abi.decode(payload, (bytes, CowOrder.SigningScheme, bytes, LibCowOrder.Data));

        assertEq(uint8(scheme), uint8(CowOrder.SigningScheme.PreSign), "wrong signing scheme");
        // What the order book wants in the signature field of a pre-signed order.
        assertEq(signature, abi.encodePacked(drop), "signature is not the owner");
        assertGt(settlement.preSignature(uid), 0, "the announced uid is not the signed one");

        // The uid embeds the owner, so an indexer can check it against the log's emitter.
        assertEq(uid.length, 56, "uid is not 56 bytes");
        assertEq(address(bytes20(_slice(uid, 32, 20))), drop, "uid owner is not the drop");

        assertEq(address(order.sellToken), address(sellToken), "wrong sell token");
        assertEq(address(order.buyToken), address(buyToken), "wrong buy token");
        assertEq(order.receiver, recipient, "wrong receiver");
        assertEq(order.sellAmount, 100e18, "sell amount is not what arrived");
        assertEq(order.buyAmount, 95e18, "wrong limit");
        assertEq(order.validTo, uint32(block.timestamp + 1 hours), "wrong deadline");
        assertEq(order.kind, Orders.KIND_SELL, "not a sell order");
        assertEq(order.feeAmount, 0, "fee must be zero");
        assertFalse(order.partiallyFillable, "must be fill-or-kill");
    }

    function _slice(bytes memory data, uint256 offset, uint256 length) private pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i; i < length; i++) {
            out[i] = data[offset + i];
        }
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
