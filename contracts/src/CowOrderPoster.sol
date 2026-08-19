// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";

import {ICoWSwapOnchainOrders} from "./interfaces/ICoWSwapOnchainOrders.sol";
import {ISettlementLike} from "./interfaces/IDropExternal.sol";
import {CowOrder} from "./lib/CowOrder.sol";

/// @title CowOrderPoster
/// @notice Place a discrete CoW order from a contract and have it posted for you.
///
/// @dev The deployed half of `CowOrder`. A contract can always redeclare
///      `ICoWSwapOnchainOrders.OrderPlacement` and emit it — that is cheaper and this changes nothing
///      about what is possible. This exists so an integration does not have to reproduce the EIP-712
///      hashing, the UID packing or the `data` layout to be picked up by
///      [`packages/watch-tower`](../packages/watch-tower/README.md).
///
///      Two entry points, because `setPreSignature` keys off `msg.sender` and that splits the job:
///
///      | you can | use | who signs | who emits |
///      |---|---|---|---|
///      | delegatecall (shed, Safe, cow-drop step) | `presignAndAnnounce` | you | you |
///      | only make ordinary calls | `setPreSignature` yourself, then `announce` | you | this contract |
///
///      `announce` refuses to emit an order the settlement contract has no signature for, so an
///      `OrderPlacement` from this address is signed by construction.
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
    /// @param quoteId The CoW API quote the order was priced from, or `CowOrder.NO_QUOTE`. Required
    ///                rather than defaulted, and not overloaded away: it is the one field of the
    ///                announcement a caller can get wrong silently, and a caller that *does* hold a
    ///                quote is the reason the field exists.
    /// @return orderUid The 56 bytes the settlement contract keys the signature by.
    function presignAndAnnounce(LibCowOrder.Data calldata order, int64 quoteId)
        external
        returns (bytes memory orderUid)
    {
        if (address(this) == SELF) revert MustBeDelegateCalled();
        return CowOrder.presign(SETTLEMENT, order, quoteId);
    }

    /// @notice Announce an order you have already pre-signed. An ordinary call.
    /// @dev The owner is `msg.sender`, and `OrderPlacement`'s `sender` is where an indexer reads the
    ///      owner of a `PreSign` order from — so this contract emits a log naming its caller, which is
    ///      precisely what that field is for. The signature is checked against the settlement contract
    ///      first, which is the only check that ever mattered.
    function announce(LibCowOrder.Data calldata order, int64 quoteId) external returns (bytes memory orderUid) {
        if (address(this) != SELF) revert MustNotBeDelegateCalled();

        orderUid = CowOrder.uidOf(SETTLEMENT, order, msg.sender);
        if (SETTLEMENT.preSignature(orderUid) == 0) revert NotSigned(orderUid);

        emit ICoWSwapOnchainOrders.OrderPlacement(
            msg.sender,
            order,
            ICoWSwapOnchainOrders.OnchainSignature(
                ICoWSwapOnchainOrders.OnchainSigningScheme.PreSign, abi.encodePacked(msg.sender)
            ),
            CowOrder.extraData(quoteId, order.validTo)
        );
    }

    /// @notice The UID `order` would have if `owner` signed it. A convenience for callers building
    ///         the `setPreSignature` call themselves.
    function orderUidFor(LibCowOrder.Data calldata order, address owner) external view returns (bytes memory) {
        return CowOrder.uidOf(SETTLEMENT, order, owner);
    }
}
