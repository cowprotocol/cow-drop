// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {ICoWSwapOnchainOrders} from "src/interfaces/ICoWSwapOnchainOrders.sol";
import {CowOrder} from "src/lib/CowOrder.sol";

/// @dev `ICoWSwapOnchainOrders` is a redeclaration of a live CoW interface, and a redeclaration is
///      only worth anything if it is byte-compatible. These are the checks that say so.
///
///      Nothing else in the suite would catch a divergence: every other test emits the event and
///      decodes it with the same declaration, so a drifted signature stays self-consistent and the
///      logs simply become invisible to everything outside this repository.
contract OnchainOrdersTest is Test {
    /// @dev `keccak256("OrderPlacement(address,(address,address,address,uint256,uint256,uint32,bytes32,uint256,bytes32,bool,bytes32,bytes32),(uint8,bytes),bytes)")`,
    ///      the topic0 EthFlow has emitted on every supported chain since it shipped. Hard-coded on
    ///      purpose: computing it from this repository's own declaration is what the test is trying to
    ///      avoid.
    bytes32 internal constant ETHFLOW_ORDER_PLACEMENT_TOPIC =
        0xcf5f9de2984132265203b5c335b25727702ca77262ff622e136baa7362bf1da9;

    /// @dev `keccak256("OrderInvalidation(bytes)")`.
    bytes32 internal constant ETHFLOW_ORDER_INVALIDATION_TOPIC =
        0xb8bad102ac8bbacfef31ff1c906ec6d951c230b4dce750bb0376b812ad35852a;

    /// @dev The whole reason this repository can redeclare the event instead of depending on
    ///      ethflowcontract: the canonical signature expands a struct to its tuple, so
    ///      `LibCowOrder.Data` and `GPv2Order.Data` — same twelve fields, same order — are the same
    ///      event. Reorder a field or add one and this fails, which is the point.
    function test_orderPlacement_hasTheSameTopicAsEthFlows() external pure {
        assertEq(
            ICoWSwapOnchainOrders.OrderPlacement.selector,
            ETHFLOW_ORDER_PLACEMENT_TOPIC,
            "OrderPlacement is no longer CoW's OrderPlacement"
        );
    }

    function test_orderInvalidation_hasTheSameTopicAsEthFlows() external pure {
        assertEq(
            ICoWSwapOnchainOrders.OrderInvalidation.selector,
            ETHFLOW_ORDER_INVALIDATION_TOPIC,
            "OrderInvalidation is no longer CoW's OrderInvalidation"
        );
    }

    /// @dev The scheme numbers are wire format. `GPv2Signing.Scheme` numbers `PreSign` 3; the on-chain
    ///      order enum numbers it 1, because the two ECDSA schemes a contract cannot reach are not in
    ///      it. Emitting a 3 here produces logs the parser upstream rejects as an unreachable state —
    ///      silently, since it only debug-logs and moves on.
    function test_signingSchemes_areNumberedAsTheParserExpects() external pure {
        assertEq(uint8(ICoWSwapOnchainOrders.OnchainSigningScheme.Eip1271), 0, "Eip1271 must be 0");
        assertEq(uint8(ICoWSwapOnchainOrders.OnchainSigningScheme.PreSign), 1, "PreSign must be 1");
    }

    /// @dev `convert_to_quote_id_and_user_valid_to` rejects anything that is not exactly twelve bytes,
    ///      and reads them big-endian as `int64 ++ uint32`.
    function test_extraData_isTheTwelveBytesTheParserReads() external pure {
        bytes memory data = CowOrder.extraData(0x0000030200000102, 0x00000102);

        assertEq(data.length, 12, "extra data must be exactly twelve bytes");
        assertEq(data, hex"000003020000010200000102", "wrong layout");
    }

    /// @dev A negative quote id is representable — `int64`, not `uint64` — and must survive the
    ///      round trip as two's complement rather than being clamped or widened.
    function test_extraData_carriesANegativeQuoteId() external pure {
        bytes memory data = CowOrder.extraData(-1, 1);

        assertEq(data.length, 12, "extra data must be exactly twelve bytes");
        assertEq(data, hex"ffffffffffffffff00000001", "a negative quote id did not round-trip");
    }
}
