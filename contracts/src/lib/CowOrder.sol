// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";

import {ICoWSwapOnchainOrders} from "../interfaces/ICoWSwapOnchainOrders.sol";
import {ISettlementLike} from "../interfaces/IDropExternal.sol";
import {Orders} from "./Orders.sol";

/// @title CowOrder
/// @notice Sign a discrete CoW order on-chain and announce it the way CoW already announces one.
///
/// @dev A *discrete* order has every field resolved, unlike a *conditional* one, which is a rule
///      ComposableCoW turns into orders later. Conditional orders are announced by
///      `ConditionalOrderCreated` and indexed for you. Discrete ones are announced by
///      `ICoWSwapOnchainOrders.OrderPlacement` — the event EthFlow has emitted in production since it
///      shipped, and which `autopilot` already decodes under both of its signing schemes.
///
///      cow-drop emits that event rather than one of its own. The alternative was tried: an earlier
///      version of this library declared a `CowOrderPlaced` carrying a pre-packed `orderUid`, on the
///      reasoning that `setPreSignature` says nothing about what was signed. That reasoning was right
///      about the gap and wrong about the fix — `OrderPlacement` already carries the whole order
///      struct and already has a `PreSign` scheme, so what was missing was never the event. What was
///      missing is an indexer that does not filter by address, because a drop address is derived from
///      a recipe only its author holds and does not exist on-chain until somebody activates it. That
///      is [`packages/watch-tower`](../../../packages/watch-tower/README.md), and it works on the
///      canonical topic0 exactly as well as it worked on a bespoke one — while a second event for one
///      job would have split the standard and cost every other integration a decision.
///
///      What moved off-chain in the swap is the UID. `OrderPlacement` does not carry one: the owner
///      travels in `sender` (for `PreSign`) or in `signature.data` (for `Eip1271`), and the digest is
///      recomputed by the consumer from the order struct and the domain separator. `uidOf` is still
///      here because *this* side needs a UID to call `setPreSignature` with — it just no longer pays
///      to put one in the log.
///
///      Every function is `internal`, so this is inlined and never deployed: it costs no address and
///      `address(this)` stays whoever called it. `CowOrderPoster` is the deployed equivalent, for
///      contracts that would rather call than copy.
library CowOrder {
    /// @notice `data` when there is no quote to point at. See `extraData`.
    int64 internal constant NO_QUOTE = 0;

    /// @notice Sign `order` on-chain as `address(this)`, and announce it.
    /// @dev `setPreSignature` keys off `msg.sender`, so this signs for whoever it is inlined into: a
    ///      delegatecalled step signs as the drop, which is also the log's emitter and — since the
    ///      scheme is `PreSign` — the `sender` an indexer reads the owner from.
    function presign(ISettlementLike settlement, LibCowOrder.Data memory order)
        internal
        returns (bytes memory orderUid)
    {
        return presign(settlement, order, NO_QUOTE);
    }

    /// @notice `presign`, pointing the order book at the quote the order was priced from.
    /// @param quoteId A quote id from the CoW API, or `NO_QUOTE`. A drop authored months before it is
    ///                funded has no quote to name — see `extraData` — but a caller that placed the
    ///                order against a live quote does, and naming it is what lets the order book match
    ///                the two.
    function presign(ISettlementLike settlement, LibCowOrder.Data memory order, int64 quoteId)
        internal
        returns (bytes memory orderUid)
    {
        orderUid = uidOf(settlement, order, address(this));
        settlement.setPreSignature(orderUid, true);
        emit ICoWSwapOnchainOrders.OrderPlacement(
            address(this),
            order,
            ICoWSwapOnchainOrders.OnchainSignature(
                ICoWSwapOnchainOrders.OnchainSigningScheme.PreSign, abi.encodePacked(address(this))
            ),
            extraData(quoteId, order.validTo)
        );
    }

    /// @notice The 56-byte UID the settlement contract keys `order`'s signature by, for `owner`.
    /// @dev Cannot be precomputed into a recipe: it covers the owner, which for a drop is the very
    ///      address being derived from that recipe.
    function uidOf(ISettlementLike settlement, LibCowOrder.Data memory order, address owner)
        internal
        view
        returns (bytes memory)
    {
        return Orders.packUid(LibCowOrder.hash(order, settlement.domainSeparator()), owner, order.validTo);
    }

    /// @notice `OrderPlacement`'s `data` field: twelve bytes of `int64 quoteId ++ uint32 validTo`.
    ///
    /// @dev The event enforces no encoding, but the parser upstream requires exactly this length and
    ///      layout, so an announcement that wants to be read has no other choice.
    ///
    ///      EthFlow uses the two halves to carry what its order struct cannot: it commits
    ///      `validTo = type(uint32).max` on-chain and puts the user's real deadline here, because its
    ///      orders are gated by ERC-1271 and the contract enforces expiry itself. **A pre-signed order
    ///      must not do that** — nothing gates it but the settlement contract's own `validTo` check, so
    ///      committing `uint32.max` would produce an order that never expires. So a drop passes its
    ///      real deadline in both places, and the two halves agree.
    ///
    ///      `quoteId` is `NO_QUOTE` for a drop, and honestly so: the recipe is compiled into an address
    ///      long before anything is funded, the sell amount is whatever later arrives, and a quote that
    ///      old would have expired. An order book that requires a quote will reject it on those grounds
    ///      and not on this field.
    function extraData(int64 quoteId, uint32 validTo) internal pure returns (bytes memory) {
        return abi.encodePacked(quoteId, validTo);
    }
}
