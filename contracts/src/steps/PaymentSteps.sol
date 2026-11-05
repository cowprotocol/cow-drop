// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

import {DropExecutor} from "../DropExecutor.sol";
import {IERC20Like, ISettlementLike} from "../interfaces/IDropExternal.sol";
import {Allowance} from "../lib/Allowance.sol";
import {CowOrder} from "../lib/CowOrder.sol";
import {NothingToSell} from "../lib/Errors.sol";
import {Orders} from "../lib/Orders.sol";

/// @title PaymentSteps
/// @notice "Pay me `buyAmount` of `buyToken`, in whatever token you hold."
///
/// @dev ## The sell token is not in the recipe
///
/// A payment address commits to what the owner receives — `buyToken`, `buyAmount`, `receiver` — and
/// deliberately not to what the payer sends. That leaves one thing the recipe cannot answer at
/// activation: *which* of the drop's balances to sell. `DropExecutor.activate(owner, setupData)` takes
/// no runtime input, and everything in `setupData` is part of the address, so the answer has to come
/// from the activator.
///
/// It travels through **transient storage on this contract**. `activatePayment` is a plain (not
/// delegatecalled) entry point that records the sell token keyed by the drop, calls `activate`, and
/// clears it. The step itself, `presignPayment`, runs delegatecalled inside the drop and reads the value
/// back with an external call to `PAYMENT_STEPS` — the deployed address of this contract, captured as an
/// immutable because `address(this)` under delegatecall is the drop. `DropExecutor` is unchanged, so no
/// drop address moves.
///
/// ## Why handing the activator this choice is safe
///
/// Activation is permissionless, so anyone may call `activatePayment` with any token. But the order it
/// produces is a **sell** order whose `buyToken`, minimum `buyAmount` and `receiver` all come from the
/// committed recipe. Whatever token an activator names, the receiver gets at least `buyAmount` or the
/// order does not fill. The worst an activator can do is choose *which* held token pays — every choice
/// still pays the owner's price, and any surplus over it is the receiver's, because it is a sell order.
///
/// Calling plain `DropExecutor.activate` on a payment recipe leaves the input empty, and the step
/// reverts with `NoPaymentToken`.
contract PaymentSteps {
    using SafeERC20 for IERC20;

    /// @notice The step ran without a sell token, i.e. not through `activatePayment`.
    error NoPaymentToken();

    /// @notice A zero minimum output is an order anyone may fill for nothing.
    error ZeroBuyAmount();

    /// @notice `address(0)` as receiver would mean "the drop", which is not a payment to anyone.
    error InvalidRecipient();

    /// @dev Base slot of the per-drop transient input. Hashed with the drop, so two drops activated in
    ///      one transaction cannot read each other's token.
    bytes32 private constant INPUT_SLOT = keccak256("cow-drop.PaymentSteps.sellToken");

    ISettlementLike public immutable SETTLEMENT;
    address public immutable VAULT_RELAYER;
    DropExecutor public immutable EXECUTOR;
    /// @notice This contract's own address, readable from inside a drop's delegatecall.
    address public immutable PAYMENT_STEPS;

    constructor(ISettlementLike settlement, address vaultRelayer, DropExecutor executor) {
        SETTLEMENT = settlement;
        VAULT_RELAYER = vaultRelayer;
        EXECUTOR = executor;
        PAYMENT_STEPS = address(this);
    }

    /// @notice Activate a payment drop, paying with its balance of `sellToken`.
    /// @dev Not a step — call it directly. Anyone may: see the contract notes on why that is safe.
    function activatePayment(address owner, bytes calldata setupData, address sellToken)
        external
        returns (address drop)
    {
        if (sellToken == address(0)) revert NoPaymentToken();
        drop = EXECUTOR.dropOf(owner, setupData);

        bytes32 slot = _slotOf(drop);
        assembly ("memory-safe") {
            tstore(slot, sellToken)
        }

        EXECUTOR.activate(owner, setupData);

        // Transient storage clears at the end of the transaction anyway; clearing now also stops a
        // later call in the same transaction from inheriting this one's choice.
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    /// @notice The sell token `activatePayment` is currently activating `drop` with, or zero.
    function paymentToken(address drop) external view returns (address sellToken) {
        bytes32 slot = _slotOf(drop);
        assembly ("memory-safe") {
            sellToken := tload(slot)
        }
    }

    /// @notice Sell the drop's whole balance of the activator-chosen token for at least `buyAmount` of
    ///         `buyToken`, paid to `receiver`, as one pre-signed CoW order.
    /// @dev Delegatecalled by the drop. If the payer sent `buyToken` itself there is nothing to trade,
    ///      and the balance goes straight to the receiver.
    /// @param validitySeconds Order lifetime from activation.
    function presignPayment(
        address buyToken,
        uint256 buyAmount,
        address receiver,
        uint256 validitySeconds,
        bytes32 appData
    ) external returns (bytes memory orderUid) {
        if (buyAmount == 0) revert ZeroBuyAmount();
        if (receiver == address(0)) revert InvalidRecipient();

        address sellToken = PaymentSteps(PAYMENT_STEPS).paymentToken(address(this));
        if (sellToken == address(0)) revert NoPaymentToken();

        uint256 sellAmount = IERC20Like(sellToken).balanceOf(address(this));
        if (sellAmount == 0) revert NothingToSell();

        if (sellToken == buyToken) {
            IERC20(sellToken).safeTransfer(receiver, sellAmount);
            return "";
        }

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
            buyTokenBalance: Orders.BALANCE_ERC20 // gitleaks:allow (balance-kind constant, not a secret)
        });

        orderUid = CowOrder.presign(SETTLEMENT, order);
    }

    function _slotOf(address drop) private pure returns (bytes32) {
        return keccak256(abi.encode(INPUT_SLOT, drop));
    }
}
