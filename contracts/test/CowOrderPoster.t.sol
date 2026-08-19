// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Test, Vm} from "forge-std/Test.sol";

import {CowOrderPoster} from "src/CowOrderPoster.sol";
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
        POSTER.announce(order);
    }

    /// @dev Announce without signing first, to prove the poster refuses.
    function announceOnly(LibCowOrder.Data calldata order) external {
        POSTER.announce(order);
    }
}

/// @dev A contract that can delegatecall — a shed, a Safe, a cow-drop step. The case
///      `presignAndAnnounce` exists for.
contract DelegatingIntegrator {
    function place(CowOrderPoster poster, LibCowOrder.Data calldata order) external {
        _delegate(poster, abi.encodeCall(CowOrderPoster.presignAndAnnounce, (order)));
    }

    /// @dev The mistake `announce` guards against: delegatecalling it would emit from *this* address
    ///      an order owned by whoever called this contract.
    function announceByDelegateCall(CowOrderPoster poster, LibCowOrder.Data calldata order) external {
        _delegate(poster, abi.encodeCall(CowOrderPoster.announce, (order)));
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

    /// @dev The event, as the watch tower reads it: uid, scheme, signature, order.
    function _placed() internal returns (bytes memory uid, CowOrder.SigningScheme scheme, bytes memory signature) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes memory payload;
        address emitter;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == CowOrder.CowOrderPlaced.selector) {
                payload = logs[i].data;
                emitter = logs[i].emitter;
            }
        }
        assertGt(payload.length, 0, "CowOrderPlaced not emitted");
        (uid, scheme, signature,) = abi.decode(payload, (bytes, CowOrder.SigningScheme, bytes, LibCowOrder.Data));
    }

    function test_delegateCall_signsAsTheCallerAndEmitsFromIt() external {
        DelegatingIntegrator integrator = new DelegatingIntegrator();

        vm.recordLogs();
        integrator.place(poster, _order());

        (bytes memory uid, CowOrder.SigningScheme scheme, bytes memory signature) = _placed();

        // The point of delegatecalling: the *integrator* is the owner, not the poster.
        assertEq(settlement.signerOf(keccak256(uid)), address(integrator), "poster signed instead of the caller");
        assertEq(address(bytes20(_slice(uid, 32, 20))), address(integrator), "uid owner is not the caller");
        assertEq(uint8(scheme), uint8(CowOrder.SigningScheme.PreSign), "wrong scheme");
        assertEq(signature, abi.encodePacked(address(integrator)), "signature is not the owner");
    }

    function test_plainCall_announcesAnOrderTheCallerSignedItself() external {
        PlainIntegrator integrator = new PlainIntegrator(ISettlementLike(address(settlement)), poster);

        vm.recordLogs();
        integrator.place(_order());

        (bytes memory uid,, bytes memory signature) = _placed();

        // The emitter here is the poster, which is why the owner has to travel inside the uid.
        assertEq(address(bytes20(_slice(uid, 32, 20))), address(integrator), "uid owner is not the caller");
        assertEq(signature, abi.encodePacked(address(integrator)), "signature is not the owner");
        assertGt(settlement.preSignature(uid), 0, "the announced uid is not the signed one");
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
        poster.presignAndAnnounce(_order());
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

    function _slice(bytes memory data, uint256 offset, uint256 length) private pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i; i < length; i++) {
            out[i] = data[offset + i];
        }
    }
}
