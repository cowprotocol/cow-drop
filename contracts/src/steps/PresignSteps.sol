// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {IERC20Like, ISettlementLike} from "../interfaces/IDropExternal.sol";
import {Allowance} from "../lib/Allowance.sol";
import {CowOrder} from "../lib/CowOrder.sol";
import {NothingToSell} from "../lib/Errors.sol";
import {Oracle} from "../lib/Oracle.sol";
import {Orders} from "../lib/Orders.sol";

/// @title PresignSteps
/// @notice Path P: the drop signs its own CoW order on-chain, and an off-chain poster submits it.
///
/// @dev ## Every function here is meant to be DELEGATECALLED by the shed
///
/// Steps that target this contract must set `Call.isDelegateCall = true`. That makes `address(this)`
/// the drop, so `balanceOf(address(this))` is *the amount that actually arrived* — which is the point.
/// A drop address cannot commit to an amount, because the amount is not known when the address is
/// computed: a bridge takes fees, a payroll run varies, a CEX withdrawal rounds. So the address commits
/// to "sell whatever lands here", and the concrete numbers are resolved at activation time.
///
/// It is also what makes the drop the *signer*: `msg.sender` at the settlement contract is the drop,
/// which is the order's owner, so `setPreSignature` is the drop signing its own order. And it is why
/// the order UID cannot be precomputed into the recipe — the UID embeds the owner, which is the very
/// address being derived from the recipe.
///
/// Immutables are readable under delegatecall (they live in this contract's code, not its storage),
/// which is why the deployment addresses below work. Storage variables would not, and this contract
/// deliberately has none.
///
/// Events emitted from here are emitted *by the drop*, since that is `address(this)` — so
/// `OrderPlacement` logs carry the drop as both emitter and `sender`, which is what an off-chain
/// poster wants. The event itself is not declared here: it is CoW's own
/// `ICoWSwapOnchainOrders.OrderPlacement`, emitted through `CowOrder`, so a poster needs one topic0
/// rather than one per step contract — and the same one EthFlow has used since it shipped.
contract PresignSteps {
    /// @notice A haircut above 100% would make the limit negative.
    error HaircutTooLarge(uint256 haircutBps);

    ISettlementLike public immutable SETTLEMENT;
    address public immutable VAULT_RELAYER;

    constructor(ISettlementLike settlement, address vaultRelayer) {
        SETTLEMENT = settlement;
        VAULT_RELAYER = vaultRelayer;
    }

    /// @notice Sell the drop's entire balance of `sellToken` as a single pre-signed CoW order.
    /// @dev Needs no ERC-1271 and no conditional-order handler: the drop pre-signs on-chain and an
    ///      off-chain poster forwards the order (see the `OrderPlacement` event) with
    ///      `signingScheme: "presign"`.
    /// @param limitNumerator   Buy units per sell unit, numerator.
    /// @param limitDenominator Buy units per sell unit, denominator.
    /// @param validitySeconds  Order lifetime measured from activation, not an absolute deadline —
    ///                         an absolute one would have to be committed into the address and
    ///                         would make the drop expire before it is ever funded.
    function presignSellAll(
        address sellToken,
        address buyToken,
        address receiver,
        uint256 limitNumerator,
        uint256 limitDenominator,
        uint256 validitySeconds,
        bytes32 appData
    ) external returns (bytes memory orderUid) {
        uint256 sellAmount = IERC20Like(sellToken).balanceOf(address(this));
        if (sellAmount == 0) revert NothingToSell();

        return _presign(
            sellToken,
            buyToken,
            receiver,
            sellAmount,
            Orders.applyLimitPrice(sellAmount, limitNumerator, limitDenominator),
            validitySeconds,
            appData
        );
    }

    /// @notice The oracle half of an oracle-priced order.
    /// @param sellTokenPriceOracle Chainlink-style feed for the sell token.
    /// @param buyTokenPriceOracle  Feed for the buy token. **Must quote the same currency.**
    /// @param maxAge               How stale either feed may be before this reverts.
    /// @param haircutBps           How far below the oracle's own number the limit is set, in basis
    ///                             points. An oracle gives a mid price and an order needs room to fill.
    struct OraclePrice {
        address sellTokenPriceOracle;
        address buyTokenPriceOracle;
        uint256 maxAge;
        uint256 haircutBps;
    }

    /// @notice Sell the whole balance at whichever is stricter: an oracle-derived limit, or a floor
    ///         committed into the drop address.
    ///
    /// @dev ## Why the floor is not optional
    ///
    /// A limit committed months before funding goes stale, which is the problem this solves. But the
    /// obvious fix — read the oracle and use it — hands the price away, because **activation is
    /// permissionless**: whoever activates picks the moment, and therefore picks the number. Somebody
    /// could wait for a bad tick, activate, and lock a loose limit into a signed order that anyone may
    /// then fill.
    ///
    /// So the oracle may only ever *improve* on a limit the author committed. `buyAmount` is the
    /// minimum output, so stricter means larger, and this takes the maximum of the two. A stale or
    /// depressed feed falls back to the floor; a favourable one tightens the order. The worst an
    /// activator can do is hand you the price you already agreed to.
    ///
    /// The haircut applies to the oracle side only — the floor is used exactly as committed, because it
    /// is already the author's own number.
    ///
    /// @param floorNumerator   Buy units per sell unit, numerator — the limit if the oracle cannot beat
    ///                         it. Set it as though the oracle did not exist.
    /// @param floorDenominator Buy units per sell unit, denominator.
    function presignSellAllAtOracle(
        address sellToken,
        address buyToken,
        address receiver,
        uint256 floorNumerator,
        uint256 floorDenominator,
        OraclePrice calldata oracle,
        uint256 validitySeconds,
        bytes32 appData
    ) external returns (bytes memory orderUid) {
        if (oracle.haircutBps > 10_000) revert HaircutTooLarge(oracle.haircutBps);

        uint256 sellAmount = IERC20Like(sellToken).balanceOf(address(this));
        if (sellAmount == 0) revert NothingToSell();

        uint256 floor = Orders.applyLimitPrice(sellAmount, floorNumerator, floorDenominator);
        uint256 fromOracle = Oracle.valueOf(
            sellToken, buyToken, sellAmount, oracle.sellTokenPriceOracle, oracle.buyTokenPriceOracle, oracle.maxAge
        );
        fromOracle = (fromOracle * (10_000 - oracle.haircutBps)) / 10_000;

        return _presign(
            sellToken, buyToken, receiver, sellAmount, fromOracle > floor ? fromOracle : floor, validitySeconds, appData
        );
    }

    /// @dev Build an order whose amounts are already resolved, then hand it to `CowOrder` to be signed
    ///      and announced. Shared by both entry points, which differ only in where `buyAmount` comes from.
    function _presign(
        address sellToken,
        address buyToken,
        address receiver,
        uint256 sellAmount,
        uint256 buyAmount,
        uint256 validitySeconds,
        bytes32 appData
    ) internal returns (bytes memory orderUid) {
        Allowance.ensureMax(sellToken, VAULT_RELAYER, sellAmount);

        LibCowOrder.Data memory order = LibCowOrder.Data({
            sellToken: IERC20(sellToken),
            buyToken: IERC20(buyToken),
            receiver: receiver,
            sellAmount: sellAmount,
            buyAmount: buyAmount,
            validTo: Orders.deadline(validitySeconds),
            appData: appData,
            feeAmount: 0,
            kind: Orders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: Orders.BALANCE_ERC20,
            buyTokenBalance: Orders.BALANCE_ERC20
        });

        // msg.sender at the settlement contract is the drop, which is the order's owner — so this
        // is the drop signing its own order. `CowOrder` also emits `OrderPlacement`, from the drop.
        orderUid = CowOrder.presign(SETTLEMENT, order);
    }
}
