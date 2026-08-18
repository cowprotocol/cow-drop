// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {IComposableCowLike} from "../interfaces/IDropExternal.sol";
import {ComposableBase} from "../lib/ComposableBase.sol";
import {Orders} from "../lib/Orders.sol";

/// @title TwapSteps
/// @notice Path C, TWAP: split whatever arrives into `n` parts, after which the drop is self-driving.
///
/// @dev ## Every function here is meant to be DELEGATECALLED by the shed
///
/// Steps that target this contract must set `Call.isDelegateCall = true`. That makes `address(this)`
/// the drop, so `balanceOf(address(this))` is *the amount that actually arrived* — which is the point.
/// A drop address cannot commit to an amount, because the amount is not known when the address is
/// computed: a bridge takes fees, a payroll run varies, a CEX withdrawal rounds. So the address commits
/// to "split whatever lands here into n parts", and the concrete numbers are resolved at activation.
///
/// It is also what makes the drop the order's *owner*: `msg.sender` at ComposableCoW is the drop, and
/// ComposableCoW keys its authorisations by owner.
///
/// ## One contract per handler
///
/// This holds the TWAP handler's address and nothing else's. The shared work — reading the arrived
/// balance, approving the relayer, registering with ComposableCoW — is in `ComposableBase`, which is
/// abstract and therefore has no address. See its notes for what a second handler has to satisfy.
///
/// Immutables are readable under delegatecall (they live in this contract's code, not its storage),
/// which is why the deployment addresses work. Storage variables would not, and this contract
/// deliberately has none.
contract TwapSteps is ComposableBase {
    /// @notice TWAP requires at least two parts; one part is a plain swap.
    error TooFewParts();

    /// @dev `TWAPOrder.Data` from composable-cow, field-for-field. Not imported because pulling
    ///      composable-cow in as a second submodule for one struct is not worth it; the layout is
    ///      asserted in `test/steps/TwapSteps.t.sol` and again against the deployed handler in the
    ///      fork tests.
    struct TwapData {
        address sellToken;
        address buyToken;
        address receiver;
        uint256 partSellAmount;
        uint256 minPartLimit;
        uint256 t0;
        uint256 n;
        uint256 t;
        uint256 span;
        bytes32 appData;
    }

    address public immutable TWAP_HANDLER;
    address public immutable CURRENT_BLOCK_TIMESTAMP_FACTORY;

    constructor(
        address vaultRelayer,
        IComposableCowLike composableCow,
        address twapHandler,
        address currentBlockTimestampFactory
    ) ComposableBase(vaultRelayer, composableCow) {
        TWAP_HANDLER = twapHandler;
        CURRENT_BLOCK_TIMESTAMP_FACTORY = currentBlockTimestampFactory;
    }

    /// @notice Split the drop's entire balance of `sellToken` into `n` parts and register a TWAP.
    /// @dev After this runs the drop is self-driving: the watch tower indexes
    ///      `ConditionalOrderCreated` and posts each part as it becomes tradeable.
    ///
    ///      Two details keep the params owner-independent, which is what lets them be committed
    ///      into the drop address with no circular dependency:
    ///      - `receiver = address(0)` is composable-cow's "pay the owner" sentinel, so the drop
    ///        address never appears in `staticInput`;
    ///      - `t0 = 0` makes the handler read the start time from ComposableCoW's `cabinet`, which
    ///        `createWithContext` seeds with `block.timestamp` at activation.
    /// @param receiver  Where the bought tokens go. Pass `address(0)` to keep them in the drop.
    /// @param orderSalt Discriminator for the conditional order itself. Unrelated to the drop's
    ///                  own factory salt, which lives in the recipe.
    function twapFromBalance(
        address sellToken,
        address buyToken,
        address receiver,
        uint256 n,
        uint256 t,
        uint256 span,
        uint256 limitNumerator,
        uint256 limitDenominator,
        bytes32 appData,
        bytes32 orderSalt
    ) external returns (bytes32 paramsHash) {
        if (n < 2) revert TooFewParts();

        uint256 partSellAmount = _amountFromBalance(sellToken, n);

        TwapData memory twap = TwapData({
            sellToken: sellToken,
            buyToken: buyToken,
            receiver: receiver,
            partSellAmount: partSellAmount,
            minPartLimit: Orders.applyLimitPrice(partSellAmount, limitNumerator, limitDenominator),
            t0: 0,
            n: n,
            t: t,
            span: span,
            appData: appData
        });

        paramsHash = _register(TWAP_HANDLER, orderSalt, abi.encode(twap), CURRENT_BLOCK_TIMESTAMP_FACTORY);
    }
}
