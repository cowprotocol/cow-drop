// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {IConditionalOrder} from "cow-shed/IConditionalOrder.sol";
import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {DropOrders} from "./DropOrders.sol";
import {IComposableCowLike, IERC20Like, ISettlementLike, IWrappedNative} from "./interfaces/IDropExternal.sol";

/// @title DropRecipes
/// @notice The recipe primitives: the steps a drop's baked-in logic is built from.
///
/// @dev ## Every function here is meant to be DELEGATECALLED by the shed
///
/// Recipe steps that target this contract must set `Call.isDelegateCall = true`. That makes
/// `address(this)` the drop itself, so `balanceOf(address(this))` is *the amount that actually
/// arrived* — which is the point. A drop address cannot commit to an amount, because the amount
/// is not known when the address is computed: a bridge takes fees, a payroll run varies, a CEX
/// withdrawal rounds. So the address commits to "split whatever lands here into n parts", and the
/// concrete numbers are resolved at activation time.
///
/// Immutables are readable under delegatecall (they live in this contract's code, not its
/// storage), which is why the deployment addresses below work. Storage variables would not, and
/// this contract deliberately has none.
///
/// Events emitted from here are emitted *by the drop*, since that is `address(this)` — so
/// `DropOrderPlaced` logs are indexed by drop address, which is what an off-chain poster wants.
contract DropRecipes {
    /// @notice The drop holds none of the token the recipe wants to sell.
    error NothingToSell();

    /// @notice TWAP requires at least two parts; one part is a plain swap.
    error TooFewParts();

    /// @notice The drop holds less than the recipe requires to proceed.
    error BalanceTooLow(uint256 available, uint256 required);

    /// @notice Activated before the recipe's window opened.
    error TooEarly(uint256 notBefore);

    /// @notice Activated after the recipe's window closed.
    error TooLate(uint256 notAfter);

    /// @notice Emitted when a pre-signed order is placed, carrying everything an off-chain poster
    ///         needs to submit it to the order book. The emitter is the drop.
    event DropOrderPlaced(bytes orderUid, LibCowOrder.Data order);

    /// @dev `TWAPOrder.Data` from composable-cow, field-for-field. Not imported because pulling
    ///      composable-cow in as a second submodule for one struct is not worth it; the layout is
    ///      asserted against the deployed handler in the fork tests.
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

    ISettlementLike public immutable SETTLEMENT;
    address public immutable VAULT_RELAYER;
    IComposableCowLike public immutable COMPOSABLE_COW;
    address public immutable TWAP_HANDLER;
    address public immutable CURRENT_BLOCK_TIMESTAMP_FACTORY;

    constructor(
        ISettlementLike settlement,
        address vaultRelayer,
        IComposableCowLike composableCow,
        address twapHandler,
        address currentBlockTimestampFactory
    ) {
        SETTLEMENT = settlement;
        VAULT_RELAYER = vaultRelayer;
        COMPOSABLE_COW = composableCow;
        TWAP_HANDLER = twapHandler;
        CURRENT_BLOCK_TIMESTAMP_FACTORY = currentBlockTimestampFactory;
    }

    // --- path P: pre-signed orders ----------------------------------------------------------

    /// @notice Sell the drop's entire balance of `sellToken` as a single pre-signed CoW order.
    /// @dev Needs no ERC-1271 and no conditional-order handler: the drop pre-signs on-chain and
    ///      an off-chain poster forwards the order (see the `DropOrderPlaced` event) with
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

        _ensureRelayerAllowance(sellToken, sellAmount);

        LibCowOrder.Data memory order = LibCowOrder.Data({
            sellToken: IERC20(sellToken),
            buyToken: IERC20(buyToken),
            receiver: receiver,
            sellAmount: sellAmount,
            buyAmount: DropOrders.applyLimitPrice(sellAmount, limitNumerator, limitDenominator),
            validTo: DropOrders.deadline(validitySeconds),
            appData: appData,
            feeAmount: 0,
            kind: DropOrders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: DropOrders.BALANCE_ERC20,
            buyTokenBalance: DropOrders.BALANCE_ERC20
        });

        bytes32 digest = LibCowOrder.hash(order, SETTLEMENT.domainSeparator());
        orderUid = DropOrders.packUid(digest, address(this), order.validTo);

        // msg.sender at the settlement contract is the drop, which is the order's owner — so this
        // is the drop signing its own order.
        SETTLEMENT.setPreSignature(orderUid, true);

        emit DropOrderPlaced(orderUid, order);
    }

    // --- path C: composable (conditional) orders ---------------------------------------------

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

        uint256 balance = IERC20Like(sellToken).balanceOf(address(this));
        if (balance == 0) revert NothingToSell();

        uint256 partSellAmount = balance / n;
        if (partSellAmount == 0) revert NothingToSell();

        // Approve the whole balance, not n * partSellAmount: the integer division leaves a dust
        // remainder in the drop, and a later top-up should not need a fresh approval.
        _ensureRelayerAllowance(sellToken, balance);

        TwapData memory twap = TwapData({
            sellToken: sellToken,
            buyToken: buyToken,
            receiver: receiver,
            partSellAmount: partSellAmount,
            minPartLimit: DropOrders.applyLimitPrice(partSellAmount, limitNumerator, limitDenominator),
            t0: 0,
            n: n,
            t: t,
            span: span,
            appData: appData
        });

        IConditionalOrder.ConditionalOrderParams memory params = IConditionalOrder.ConditionalOrderParams({
            handler: IConditionalOrder(TWAP_HANDLER),
            salt: orderSalt,
            staticInput: abi.encode(twap)
        });

        // dispatch = true so the watch tower sees it.
        COMPOSABLE_COW.createWithContext(params, CURRENT_BLOCK_TIMESTAMP_FACTORY, "", true);

        paramsHash = keccak256(abi.encode(params));
    }

    // --- guards -------------------------------------------------------------------------------
    //
    // Activation is permissionless, so "nobody triggers this early" cannot be a promise made by
    // whoever activates — it has to be a property of the recipe. These guards are ordinary steps:
    // they are committed into the drop address like everything else, so no activator can skip them,
    // and because they revert rather than return false, a premature activation rolls back whole.
    // That matters most for a `once` recipe, where the alternative is spending the single run on a
    // half-delivered balance.

    /// @notice Revert unless the drop holds at least `minAmount`. Pass `token == address(0)` for the
    ///         native balance.
    /// @dev Must be delegatecalled, like every primitive here — reading the drop's balance is only
    ///      possible when `address(this)` *is* the drop. The drop address cannot be passed in as an
    ///      argument, because arguments are committed into that very address.
    function requireMinBalance(address token, uint256 minAmount) external view {
        uint256 available = token == address(0) ? address(this).balance : IERC20Like(token).balanceOf(address(this));
        if (available < minAmount) revert BalanceTooLow(available, minAmount);
    }

    /// @notice Revert outside the window `[notBefore, notAfter]`. Either bound may be 0 for
    ///         "unbounded".
    /// @dev Absolute timestamps, so they are fixed when the address is computed. A relative delay
    ///      would need a reference point, and the only honest one — activation time — is what this
    ///      is trying to constrain.
    function requireTimeWindow(uint256 notBefore, uint256 notAfter) external view {
        if (notBefore != 0 && block.timestamp < notBefore) revert TooEarly(notBefore);
        if (notAfter != 0 && block.timestamp > notAfter) revert TooLate(notAfter);
    }

    // --- generic steps ------------------------------------------------------------------------

    /// @notice Wrap the drop's entire native balance, so natively-funded drops can trade.
    /// @dev `COWShed` has a `receive()`, so a drop can be funded with plain ETH/xDAI.
    function wrapNative(address wrappedNative) external {
        uint256 balance = address(this).balance;
        if (balance == 0) revert NothingToSell();
        IWrappedNative(wrappedNative).deposit{value: balance}();
    }

    /// @notice Set an unlimited allowance for `spender`, if it is not already effectively so.
    /// @dev Exposed for the generic step builder. The order primitives above manage their own
    ///      allowances, so a well-formed recipe never needs this before them.
    function approveMax(address token, address spender) external {
        _approveMax(token, spender);
    }

    function _ensureRelayerAllowance(address token, uint256 required) internal {
        if (IERC20Like(token).allowance(address(this), VAULT_RELAYER) < required) {
            _approveMax(token, VAULT_RELAYER);
        }
    }

    function _approveMax(address token, address spender) internal {
        IERC20Like(token).approve(spender, type(uint256).max);
    }
}
