// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Test, Vm} from "forge-std/Test.sol";

import {CowOrderPoster} from "src/CowOrderPoster.sol";
import {ICoWSwapOnchainOrders} from "src/interfaces/ICoWSwapOnchainOrders.sol";
import {ISettlementLike} from "src/interfaces/IDropExternal.sol";
import {CowOrder} from "src/lib/CowOrder.sol";
import {Orders} from "src/lib/Orders.sol";

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {MockSettlement} from "./mocks/Mocks.sol";

/// @dev An ordinary contract integrating CoW: it can only make plain calls, so it pre-signs itself
///      and then asks the poster to announce. The case `announce` exists for.
contract PlainIntegrator {
    ISettlementLike internal immutable SETTLEMENT;
    CowOrderPoster internal immutable POSTER;

    constructor(ISettlementLike settlement, CowOrderPoster poster) {
        SETTLEMENT = settlement;
        POSTER = poster;
    }

    function place(LibCowOrder.Data calldata order) external returns (bytes memory orderUid) {
        orderUid = POSTER.orderUidFor(order, address(this));
        SETTLEMENT.setPreSignature(orderUid, true);
        POSTER.announce(order, CowOrder.NO_QUOTE);
    }

    /// @dev Announce without signing first, to prove the poster refuses.
    function announceOnly(LibCowOrder.Data calldata order) external {
        POSTER.announce(order, CowOrder.NO_QUOTE);
    }
}

/// @dev A contract that can delegatecall — a shed, a Safe, a cow-drop step. The case
///      `presignAndAnnounce` exists for.
contract DelegatingIntegrator {
    function place(CowOrderPoster poster, LibCowOrder.Data calldata order) external {
        placeWithQuote(poster, order, CowOrder.NO_QUOTE);
    }

    function placeWithQuote(CowOrderPoster poster, LibCowOrder.Data calldata order, int64 quoteId) public {
        _delegate(poster, abi.encodeCall(CowOrderPoster.presignAndAnnounce, (order, quoteId)));
    }

    /// @dev The mistake `announce` guards against: delegatecalling it would emit from *this* address
    ///      an order owned by whoever called this contract.
    function announceByDelegateCall(CowOrderPoster poster, LibCowOrder.Data calldata order) external {
        _delegate(poster, abi.encodeCall(CowOrderPoster.announce, (order, CowOrder.NO_QUOTE)));
    }

    function _delegate(CowOrderPoster poster, bytes memory callData) private {
        (bool ok, bytes memory reason) = address(poster).delegatecall(callData);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(reason, 32), mload(reason))
            }
        }
    }
}

contract CowOrderPosterTest is Test {
    MockSettlement internal settlement;
    CowOrderPoster internal poster;

    address internal constant SELL_TOKEN = address(0x5E11);
    address internal constant BUY_TOKEN = address(0xB111);

    function setUp() public {
        settlement = new MockSettlement(keccak256("domain"));
        poster = new CowOrderPoster(ISettlementLike(address(settlement)));
        vm.warp(1_800_000_000);
    }

    function _order() internal view returns (LibCowOrder.Data memory) {
        return LibCowOrder.Data({
            sellToken: IERC20(SELL_TOKEN),
            buyToken: IERC20(BUY_TOKEN),
            receiver: address(0),
            sellAmount: 100e18,
            buyAmount: 95e18,
            validTo: uint32(block.timestamp + 1 hours),
            appData: bytes32(0),
            feeAmount: 0,
            kind: Orders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: Orders.BALANCE_ERC20,
            buyTokenBalance: Orders.BALANCE_ERC20
        });
    }

    /// @dev An `OrderPlacement` as the watch tower reads it, with the uid it would recompute.
    struct Placed {
        /// @dev The contract the log came from.
        address emitter;
        /// @dev `topics[1]`, and for a `PreSign` order the owner.
        address sender;
        LibCowOrder.Data order;
        ICoWSwapOnchainOrders.OnchainSignature signature;
        bytes extraData;
        /// @dev Not in the log — recomputed from the order and `sender`, which is the whole point.
        bytes uid;
    }

    function _placed() internal returns (Placed memory placed) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] != ICoWSwapOnchainOrders.OrderPlacement.selector) continue;
            placed.emitter = logs[i].emitter;
            placed.sender = address(uint160(uint256(logs[i].topics[1])));
            (placed.order, placed.signature, placed.extraData) =
                abi.decode(logs[i].data, (LibCowOrder.Data, ICoWSwapOnchainOrders.OnchainSignature, bytes));
            found = true;
        }
        assertTrue(found, "OrderPlacement not emitted");

        placed.uid = Orders.packUid(
            LibCowOrder.hash(placed.order, settlement.domainSeparator()), placed.sender, placed.order.validTo
        );
    }

    function test_delegateCall_signsAsTheCallerAndEmitsFromIt() external {
        DelegatingIntegrator integrator = new DelegatingIntegrator();

        vm.recordLogs();
        integrator.place(poster, _order());

        Placed memory placed = _placed();

        // The point of delegatecalling: the *integrator* is the owner, not the poster — and it is the
        // emitter too, so an indexer needs nothing but the log to know whose order this is.
        assertEq(placed.emitter, address(integrator), "poster emitted instead of the caller");
        assertEq(placed.sender, address(integrator), "sender is not the caller");
        assertEq(settlement.signerOf(keccak256(placed.uid)), address(integrator), "poster signed instead of the caller");
        assertEq(
            uint8(placed.signature.scheme), uint8(ICoWSwapOnchainOrders.OnchainSigningScheme.PreSign), "wrong scheme"
        );
        assertEq(placed.signature.data, abi.encodePacked(address(integrator)), "signature is not the owner");
        assertEq(placed.extraData, abi.encodePacked(CowOrder.NO_QUOTE, _order().validTo), "wrong extra data");
    }

    function test_delegateCall_carriesAQuoteIdWhenGivenOne() external {
        DelegatingIntegrator integrator = new DelegatingIntegrator();

        vm.recordLogs();
        integrator.placeWithQuote(poster, _order(), 4242);

        Placed memory placed = _placed();

        // The reason to name a quote at all: the order book matches the two, and a caller that priced
        // against a live quote has one to name where a drop does not.
        assertEq(placed.extraData, abi.encodePacked(int64(4242), _order().validTo), "quote id was not carried");
        assertEq(placed.extraData.length, 12, "extra data is not the twelve bytes the parser reads");
    }

    function test_plainCall_announcesAnOrderTheCallerSignedItself() external {
        PlainIntegrator integrator = new PlainIntegrator(ISettlementLike(address(settlement)), poster);

        vm.recordLogs();
        integrator.place(_order());

        Placed memory placed = _placed();

        // The emitter here is the poster, not the owner — which is exactly what `sender` is for, and
        // why an indexer must read the owner from there rather than from the log's address.
        assertEq(placed.emitter, address(poster), "the poster did not emit");
        assertEq(placed.sender, address(integrator), "sender is not the caller");
        assertEq(placed.signature.data, abi.encodePacked(address(integrator)), "signature is not the owner");
        assertGt(settlement.preSignature(placed.uid), 0, "the announced uid is not the signed one");
    }

    function test_announce_refusesAnOrderThatWasNeverSigned() external {
        // What makes a CowOrderPlaced from this address trustworthy: it cannot announce a fiction.
        PlainIntegrator integrator = new PlainIntegrator(ISettlementLike(address(settlement)), poster);

        vm.expectRevert(
            abi.encodeWithSelector(CowOrderPoster.NotSigned.selector, poster.orderUidFor(_order(), address(integrator)))
        );
        integrator.announceOnly(_order());
    }

    function test_presignAndAnnounce_refusesAnOrdinaryCall() external {
        // It would sign an order owned by the poster: unfundable, and never what the caller meant.
        vm.expectRevert(CowOrderPoster.MustBeDelegateCalled.selector);
        poster.presignAndAnnounce(_order(), CowOrder.NO_QUOTE);
    }

    function test_announce_refusesADelegateCall() external {
        DelegatingIntegrator integrator = new DelegatingIntegrator();

        vm.expectRevert(CowOrderPoster.MustNotBeDelegateCalled.selector);
        integrator.announceByDelegateCall(poster, _order());
    }

    function test_orderUidFor_matchesWhatTheSignatureIsKeyedBy() external {
        PlainIntegrator integrator = new PlainIntegrator(ISettlementLike(address(settlement)), poster);

        bytes memory uid = integrator.place(_order());

        assertEq(uid, poster.orderUidFor(_order(), address(integrator)), "uid disagrees with the helper");
        assertEq(uid.length, 56, "uid is not 56 bytes");
    }
}
