// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {IComposableCowLike} from "../interfaces/IDropExternal.sol";
import {ComposableBase} from "../lib/ComposableBase.sol";
import {Orders} from "../lib/Orders.sol";

/// @title StopLossSteps
/// @notice Path C, stop-loss: sell whatever arrives, but only once an oracle pair crosses a strike.
///
/// @dev ## Every function here is meant to be DELEGATECALLED by the shed
///
/// Steps that target this contract must set `Call.isDelegateCall = true`, which makes `address(this)`
/// the drop — so `balanceOf(address(this))` is the amount that actually arrived, and `msg.sender` at
/// ComposableCoW is the drop, which is the owner it keys authorisations by.
///
/// ## Why this one suits a drop
///
/// The condition is evaluated by the watch tower on every poll, not once at activation. That is the
/// difference between a *trigger* and a *refusal*: a guard in a recipe can only refuse to run at the
/// wrong moment and needs somebody watching to retry, whereas a registered stop-loss sits there and
/// fires itself. Fund the address, activate once, and the sale happens if and when the price crosses.
///
/// ## Two things the step resolves that a recipe cannot commit to
///
/// - **The amount.** `sellAmount` is a literal in the handler's `staticInput`, and the recipe is
///   committed into the drop address before anything is funded. `_amountFromBalance` reads what
///   arrived.
/// - **The deadline.** `validTo` is an absolute `uint32` in `staticInput`. Committing one would start
///   the clock when the *address was computed*, so a drop funded a week later could already be expired.
///   Taking `validitySeconds` and resolving it here starts it at activation instead — the same trick
///   `PresignSteps` uses, and the counterpart of TWAP's `t0 = 0` cabinet read.
///
/// `receiver = address(0)` is GPv2's pay-the-owner sentinel, which keeps `staticInput`
/// owner-independent and the address derivation non-circular.
contract StopLossSteps is ComposableBase {
    /// @notice A stop-loss with no deadline would be a standing order nobody can retire.
    error NoValidity();

    /// @dev `StopLoss.Data` from composable-cow, field-for-field. Not imported because pulling
    ///      composable-cow in as a second submodule is not worth it; the layout is asserted in
    ///      `test/steps/StopLossSteps.t.sol`.
    struct StopLossData {
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 buyAmount;
        bytes32 appData;
        address receiver;
        bool isSellOrder;
        bool isPartiallyFillable;
        uint32 validTo;
        address sellTokenPriceOracle;
        address buyTokenPriceOracle;
        int256 strike;
        uint256 maxTimeSinceLastOracleUpdate;
    }

    /// @notice The oracle-pair and threshold half of the order, grouped so the argument list stays
    ///         readable and the SDK has one obvious thing to build.
    /// @param sellTokenPriceOracle Chainlink-style feed for the sell token.
    /// @param buyTokenPriceOracle  Feed for the buy token. **Must quote the same currency** as the
    ///                             sell-token feed, or the comparison below is meaningless.
    /// @param strike               The handler fires when `sellPrice * 1e18 / buyPrice <= strike`,
    ///                             both prices scaled to 18 decimals. So this is a floor on how much
    ///                             buy token one sell token is worth: a *stop* loss, not a take
    ///                             profit.
    /// @param maxTimeSinceLastOracleUpdate How stale a feed may be before the handler refuses.
    struct Trigger {
        address sellTokenPriceOracle;
        address buyTokenPriceOracle;
        int256 strike;
        uint256 maxTimeSinceLastOracleUpdate;
    }

    address public immutable STOP_LOSS_HANDLER;

    constructor(address vaultRelayer, IComposableCowLike composableCow, address stopLossHandler)
        ComposableBase(vaultRelayer, composableCow)
    {
        STOP_LOSS_HANDLER = stopLossHandler;
    }

    /// @notice Register a stop-loss over the drop's entire balance of `sellToken`.
    ///
    /// @param receiver         Where the bought tokens go. `address(0)` keeps them in the drop.
    /// @param limitNumerator   Buy units per sell unit, numerator — the minimum output, applied to
    ///                         whatever arrived. Independent of `strike`: the strike says *when* to
    ///                         sell, this says *how badly* you refuse to be filled.
    /// @param limitDenominator Buy units per sell unit, denominator.
    /// @param validitySeconds  Order lifetime measured from activation, not an absolute deadline.
    /// @param orderSalt        Discriminator for the conditional order itself. Unrelated to the drop's
    ///                         own factory salt, which lives in the recipe.
    function stopLossFromBalance(
        address sellToken,
        address buyToken,
        address receiver,
        uint256 limitNumerator,
        uint256 limitDenominator,
        uint256 validitySeconds,
        Trigger calldata trigger,
        bool partiallyFillable,
        bytes32 appData,
        bytes32 orderSalt
    ) external returns (bytes32 paramsHash) {
        if (validitySeconds == 0) revert NoValidity();

        // divisor 1: a stop-loss sells the lot in one order, unlike a TWAP's n parts.
        uint256 sellAmount = _amountFromBalance(sellToken, 1);

        StopLossData memory stopLoss = StopLossData({
            sellToken: sellToken,
            buyToken: buyToken,
            sellAmount: sellAmount,
            buyAmount: Orders.applyLimitPrice(sellAmount, limitNumerator, limitDenominator),
            appData: appData,
            receiver: receiver,
            isSellOrder: true,
            isPartiallyFillable: partiallyFillable,
            validTo: Orders.deadline(validitySeconds),
            sellTokenPriceOracle: trigger.sellTokenPriceOracle,
            buyTokenPriceOracle: trigger.buyTokenPriceOracle,
            strike: trigger.strike,
            maxTimeSinceLastOracleUpdate: trigger.maxTimeSinceLastOracleUpdate
        });

        // No value factory: StopLoss reads no cabinet, so a plain `create` is right — seeding one would
        // leave an entry nothing consults.
        paramsHash = _register(STOP_LOSS_HANDLER, orderSalt, abi.encode(stopLoss), address(0));
    }
}
