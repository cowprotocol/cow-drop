// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

import {IERC20Like} from "../interfaces/IDropExternal.sol";
import {Allowance} from "../lib/Allowance.sol";
import {NothingToSell} from "../lib/Errors.sol";
import {HookOrderBase} from "../lib/HookOrderBase.sol";
import {PaymentSteps} from "./PaymentSteps.sol";

/// @title HookPaymentSteps
/// @notice The activation half of a payment whose order is posted before the drop exists.
///
/// @dev `PaymentSteps.presignPayment` signs an order at activation. Here the order is already in the
///      book, checked by `PaymentHandler` when it settles, so all activation has left to do is let the
///      relayer pull the token that order sells. Which token is the activator's choice, and it arrives
///      the way it does for `presignPayment`: through `PaymentSteps.activatePayment`, which is
///      therefore the hook such an order carries.
///
///      Delegatecalled by the drop, like every step.
contract HookPaymentSteps {
    using SafeERC20 for IERC20;

    /// @notice The step ran without a sell token, i.e. not through `PaymentSteps.activatePayment`.
    error NoPaymentToken();

    /// @notice `address(0)` as receiver would mean "the drop", which is not a payment to anyone.
    error InvalidRecipient();

    address public immutable VAULT_RELAYER;
    PaymentSteps public immutable PAYMENT_STEPS;

    constructor(address vaultRelayer, PaymentSteps paymentSteps) {
        VAULT_RELAYER = vaultRelayer;
        PAYMENT_STEPS = paymentSteps;
    }

    /// @notice Approve the relayer for the activator-chosen token, or forward it if it is already
    ///         `buyToken`: there is no order to place for a payment made in the token asked for.
    /// @param strictHandler The recipe's handler when it is strict, so that this run is recorded for
    ///        the token it approved; zero otherwise. The mark is made here rather than by a call of
    ///        its own because only this step knows which token the activator named.
    function approvePayment(address buyToken, address receiver, address strictHandler) external {
        if (receiver == address(0)) revert InvalidRecipient();

        address sellToken = PAYMENT_STEPS.paymentToken(address(this));
        if (sellToken == address(0)) revert NoPaymentToken();

        uint256 balance = IERC20Like(sellToken).balanceOf(address(this));
        if (balance == 0) revert NothingToSell();

        if (sellToken == buyToken) {
            IERC20(sellToken).safeTransfer(receiver, balance);
            return;
        }

        Allowance.ensureMax(sellToken, VAULT_RELAYER, balance);
        if (strictHandler != address(0)) HookOrderBase(strictHandler).markRan(sellToken);
    }
}
