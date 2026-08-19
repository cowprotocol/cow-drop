// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";

/// @title ICoWSwapOnchainOrders
/// @notice CoW Protocol's canonical announcement for an order placed on-chain.
///
/// @dev **This is not cow-drop's interface.** It is
///      [ethflowcontract/src/interfaces/ICoWSwapOnchainOrders.sol](https://github.com/cowprotocol/ethflowcontract/blob/main/src/interfaces/ICoWSwapOnchainOrders.sol),
///      redeclared here because that repository is not a dependency of this one. `OrderPlacement` has
///      been in production since EthFlow shipped and is what `autopilot`'s onchain-order parser
///      already decodes, for both signing schemes it admits.
///
///      Redeclaring an event is how Solidity shares one: a log is identified by its topic0, which is
///      the keccak of the canonical signature, and the canonical signature expands a struct to its
///      tuple. So the `order` parameter is typed `LibCowOrder.Data` here where ethflow types it
///      `GPv2Order.Data`, and the two produce the identical topic0 — the field list is the same
///      twelve, in the same order. `test/OnchainOrders.t.sol` asserts exactly that against the
///      hard-coded hash, because a silent divergence would mean logs nothing upstream can read.
///
///      ## Why cow-drop emits this rather than something of its own
///
///      A contract that pre-signs a CoW order has a problem: the signature is on-chain but nothing
///      told the order book the order exists, so no solver sees it. `setPreSignature` takes a UID and
///      says nothing about what was signed. `OrderPlacement` carries the whole order struct, and its
///      `PreSign` scheme is exactly the case a pre-signing contract needs — so the gap was never a
///      missing event, only a missing indexer that does not filter by address.
///
///      That indexer is [`packages/watch-tower`](../../../packages/watch-tower/README.md). It filters
///      on this topic0 with no address filter — the only thing that works when the emitters are
///      counterfactual drop addresses — and verifies the order really is signed before posting it,
///      which is what makes the event safe to leave open to anyone.
interface ICoWSwapOnchainOrders {
    /// @notice The signing schemes an order placed on-chain can use.
    /// @dev Two, not `GPv2Signing.Scheme`'s four: a contract cannot produce an ECDSA signature, so
    ///      `Eip712` and `EthSign` are unreachable from on-chain order placement and are not in the
    ///      numbering. Emitting a `3` here — `GPv2Signing.Scheme.PreSign`'s number — is how an
    ///      integration silently produces logs the upstream parser rejects as an unreachable state.
    enum OnchainSigningScheme {
        Eip1271,
        PreSign
    }

    /// @notice The signing scheme used, and the signature under it.
    struct OnchainSignature {
        OnchainSigningScheme scheme;
        /// @dev Forwarded to the order book as-is. For both reachable schemes this is the owner's
        ///      address: `Eip1271` names the contract to call, `PreSign` names the contract that
        ///      signed.
        bytes data;
    }

    /// @notice An order was placed on-chain, with everything a poster needs to submit it.
    ///
    /// @param sender The account that triggered the placement. **Not necessarily the owner** — a
    ///               contract placing an order for somebody else sets this to whoever asked. Under
    ///               `PreSign` the owner is read from here; under `Eip1271` it is read from
    ///               `signature.data`. Indexed, so orders can be found by it.
    /// @param order The order, with every amount already resolved.
    /// @param signature How the order book should check the order.
    /// @param data Extra information the order struct has no field for. No encoding is enforced by
    ///             the event, but the parser upstream reads exactly twelve bytes of
    ///             `int64 quoteId ++ uint32 validTo` — see `CowOrder.extraData`.
    event OrderPlacement(address indexed sender, LibCowOrder.Data order, OnchainSignature signature, bytes data);

    /// @notice An order placed by an earlier `OrderPlacement` will not be filled.
    /// @param orderUid `orderDigest ++ owner ++ validTo`, the 56 bytes the settlement contract keys
    ///                 the order by.
    event OrderInvalidation(bytes orderUid);
}
