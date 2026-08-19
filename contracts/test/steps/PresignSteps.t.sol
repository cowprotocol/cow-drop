// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Vm} from "forge-std/Test.sol";

import {ICoWSwapOnchainOrders} from "src/interfaces/ICoWSwapOnchainOrders.sol";
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
            if (logs[i].topics[0] == ICoWSwapOnchainOrders.OrderPlacement.selector) {
                // The poster keys off this: the log's emitter must be the drop, not the step contract.
                assertEq(logs[i].emitter, drop, "OrderPlacement not emitted by the drop");
                // And `sender` is where an indexer reads a pre-signed order's owner from, so for a
                // drop signing its own order the two must agree.
                assertEq(address(uint160(uint256(logs[i].topics[1]))), drop, "sender is not the drop");
                found = true;
            }
        }
        assertTrue(found, "OrderPlacement not emitted");
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
        address sender;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == ICoWSwapOnchainOrders.OrderPlacement.selector) {
                payload = logs[i].data;
                sender = address(uint160(uint256(logs[i].topics[1])));
            }
        }
        assertGt(payload.length, 0, "OrderPlacement not emitted");

        (
            LibCowOrder.Data memory order,
            ICoWSwapOnchainOrders.OnchainSignature memory signature,
            bytes memory extraData
        ) = abi.decode(payload, (LibCowOrder.Data, ICoWSwapOnchainOrders.OnchainSignature, bytes));

        assertEq(
            uint8(signature.scheme), uint8(ICoWSwapOnchainOrders.OnchainSigningScheme.PreSign), "wrong signing scheme"
        );
        // What the order book wants in the signature field of a pre-signed order.
        assertEq(signature.data, abi.encodePacked(drop), "signature is not the owner");

        // No uid in the log: an indexer recomputes it from the order struct, the domain separator and
        // the owner it read from `sender`. Do exactly that, and check the result is the signed one.
        assertEq(sender, drop, "sender is not the drop");
        bytes memory uid = Orders.packUid(LibCowOrder.hash(order, settlement.domainSeparator()), sender, order.validTo);
        assertGt(settlement.preSignature(uid), 0, "the recomputed uid is not the signed one");
        assertEq(uid.length, 56, "uid is not 56 bytes");

        // Twelve bytes of `int64 quoteId ++ uint32 validTo`, which is the only layout the parser
        // upstream accepts. A drop names no quote, and its two deadlines agree.
        assertEq(extraData, abi.encodePacked(CowOrder.NO_QUOTE, order.validTo), "wrong extra data");

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
