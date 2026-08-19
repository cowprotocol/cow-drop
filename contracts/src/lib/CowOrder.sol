// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";

import {ISettlementLike} from "../interfaces/IDropExternal.sol";
import {Orders} from "./Orders.sol";

/// @title CowOrder
/// @notice One event announcing a discrete CoW order, and the helper that signs one.
///
/// @dev A *discrete* order has every field resolved, unlike a *conditional* one, which is a rule
///      ComposableCoW turns into orders later. Conditional orders are announced by
///      `ConditionalOrderCreated` and indexed for you. Discrete ones had nothing: `setPreSignature`
///      takes a UID and says nothing about what was signed, so the order struct only ever existed in
///      the calldata of whoever signed it, and no solver could see the order.
///
///      `CowOrderPlaced` closes that, and is deliberately not cow-drop's own. Any contract that
///      pre-signs an order can emit it and `packages/watch-tower` will post the order — one event
///      means an indexer filters on one topic0 and needs no list of addresses, which is the only
///      thing that works when the emitters are counterfactual drop addresses nobody knows yet.
///
///      Every function is `internal`, so this is inlined and never deployed: it costs no address and
///      `address(this)` stays whoever called it. `CowOrderPoster` is the deployed equivalent, for
///      contracts that would rather call than copy.
///
///      There is no `announce` wrapper: a contract that signed some other way — through
///      `DropExecutor.isValidSignature`, say — emits `CowOrder.CowOrderPlaced(...)` directly, which
///      Solidity has allowed across contract boundaries since 0.8.21.
library CowOrder {
    /// @notice `GPv2Signing.Scheme`, field for field. A contract can only reach the last two.
    enum SigningScheme {
        Eip712,
        EthSign,
        Eip1271,
        PreSign
    }

    /// @notice A discrete CoW order was placed, with everything a poster needs to submit it.
    /// @param orderUid      `orderDigest ++ owner ++ validTo`. The owner is in there, so the emitter
    ///                      does not have to be it — see `CowOrderPoster.announce`.
    /// @param signingScheme How the order book should check the order.
    /// @param signature     Forwarded to the order book as-is. For `PreSign`, the owner.
    /// @param order         The order, with every amount already resolved.
    event CowOrderPlaced(bytes orderUid, SigningScheme signingScheme, bytes signature, LibCowOrder.Data order);

    /// @notice Sign `order` on-chain as `address(this)`, and announce it.
    /// @dev `setPreSignature` keys off `msg.sender`, so this signs for whoever it is inlined into: a
    ///      delegatecalled step signs as the drop, which is also the log's emitter.
    function presign(ISettlementLike settlement, LibCowOrder.Data memory order)
        internal
        returns (bytes memory orderUid)
    {
        orderUid = uidOf(settlement, order, address(this));
        settlement.setPreSignature(orderUid, true);
        emit CowOrderPlaced(orderUid, SigningScheme.PreSign, abi.encodePacked(address(this)), order);
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
}
