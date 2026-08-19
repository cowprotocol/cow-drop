// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";

import {ISettlementLike} from "./interfaces/IDropExternal.sol";
import {CowOrder} from "./lib/CowOrder.sol";

/// @title CowOrderPoster
/// @notice Place a discrete CoW order from a contract and have it posted for you.
///
/// @dev The deployed half of `CowOrder`. A contract can always copy the event declaration and emit
///      it — that is cheaper and this changes nothing about what is possible. This exists so an
///      integration does not have to reproduce the EIP-712 hashing, the UID packing or the exact
///      event ABI to be picked up by `packages/watch-tower`.
///
///      Two entry points, because `setPreSignature` keys off `msg.sender` and that splits the job:
///
///      | you can | use | who signs | who emits |
///      |---|---|---|---|
///      | delegatecall (shed, Safe, cow-drop step) | `presignAndAnnounce` | you | you |
///      | only make ordinary calls | `setPreSignature` yourself, then `announce` | you | this contract |
///
///      `announce` refuses to emit an order the settlement contract has no signature for, so a
///      `CowOrderPlaced` from this address is signed by construction.
///
///      Holds no funds and no storage, and grants nobody anything: pre-signing is something only an
///      order's own owner can do, and announcing an order that is already signed does not make it any
///      more fillable than it already was.
contract CowOrderPoster {
    /// @notice `announce` was given an order the settlement contract holds no pre-signature for.
    error NotSigned(bytes orderUid);

    /// @notice `presignAndAnnounce` was called normally, which would sign an order owned by this
    ///         contract — one nobody can fund and no `announce` caller could have meant.
    error MustBeDelegateCalled();

    /// @notice `announce` was delegatecalled, which would emit from your address an order owned by
    ///         whoever called *you*.
    error MustNotBeDelegateCalled();

    ISettlementLike public immutable SETTLEMENT;

    /// @dev This contract's own address, captured at construction so the two entry points can tell a
    ///      delegatecall from an ordinary call: under delegatecall `address(this)` is the caller.
    address private immutable SELF;

    constructor(ISettlementLike settlement) {
        SETTLEMENT = settlement;
        SELF = address(this);
    }

    /// @notice **Delegatecall this.** Pre-sign `order` as your own contract, and announce it.
    /// @dev Immutables are readable under delegatecall — they live in this contract's code, not its
    ///      storage — which is what makes `SETTLEMENT` work here.
    /// @return orderUid The 56 bytes the settlement contract keys the signature by.
    function presignAndAnnounce(LibCowOrder.Data calldata order) external returns (bytes memory orderUid) {
        if (address(this) == SELF) revert MustBeDelegateCalled();
        return CowOrder.presign(SETTLEMENT, order);
    }

    /// @notice Announce an order you have already pre-signed. An ordinary call.
    /// @dev The owner is `msg.sender`, so the emitter is this contract rather than the owner. That is
    ///      fine and is why the owner travels inside `orderUid`: an indexer reads it from there and
    ///      confirms it against the settlement contract, which is the only check that ever mattered.
    function announce(LibCowOrder.Data calldata order) external returns (bytes memory orderUid) {
        if (address(this) != SELF) revert MustNotBeDelegateCalled();

        orderUid = CowOrder.uidOf(SETTLEMENT, order, msg.sender);
        if (SETTLEMENT.preSignature(orderUid) == 0) revert NotSigned(orderUid);

        emit CowOrder.CowOrderPlaced(orderUid, CowOrder.SigningScheme.PreSign, abi.encodePacked(msg.sender), order);
    }

    /// @notice The UID `order` would have if `owner` signed it. A convenience for callers building
    ///         the `setPreSignature` call themselves.
    function orderUidFor(LibCowOrder.Data calldata order, address owner) external view returns (bytes memory) {
        return CowOrder.uidOf(SETTLEMENT, order, owner);
    }
}
