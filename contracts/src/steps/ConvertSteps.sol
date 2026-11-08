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

/// @title ConvertSteps
/// @notice "Whatever lands here, sell it for `buyToken`" — the activator sets the price each time.
///
/// @dev No price is committed, so whoever activates picks the minimum. `setupData` is public after
///      the first activation and travels in every share link, so secrecy is not a defence: the recipe
///      commits a `pricer` and only it or the `owner` may activate. A zero `pricer` opts out and lets
///      anyone activate — then nothing on-chain protects the price, only CoW's solver competition.
///
///      The minimum itself cannot travel in `setupData` (that would be part of the address), so it
///      goes through transient storage, as `PaymentSteps` passes its sell token. `DropExecutor` is
///      unchanged, so no drop address moves.
contract ConvertSteps {
    using SafeERC20 for IERC20;

    /// @notice The activator is neither the committed pricer nor the owner. A plain `activate`
    ///         records nothing, so it arrives here as the zero address.
    error NotThePricer(address caller, address pricer);

    /// @notice A zero minimum is an order anyone may fill for nothing. One atom is a price; zero is not.
    error ZeroBuyAmount();

    /// @notice `address(0)` as receiver would mean "the drop", which converts nothing to anywhere.
    error InvalidRecipient();

    /// @notice `activateConvert` was given no sell token.
    error NoSellToken();

    /// @dev Hashed with the drop, so two drops in one transaction cannot read each other's input.
    bytes32 private constant INPUT_SLOT = keccak256("cow-drop.ConvertSteps.input");

    ISettlementLike public immutable SETTLEMENT;
    address public immutable VAULT_RELAYER;
    DropExecutor public immutable EXECUTOR;
    /// @notice This contract's own address, readable from inside a drop's delegatecall.
    address public immutable CONVERT_STEPS;

    constructor(ISettlementLike settlement, address vaultRelayer, DropExecutor executor) {
        SETTLEMENT = settlement;
        VAULT_RELAYER = vaultRelayer;
        EXECUTOR = executor;
        CONVERT_STEPS = address(this);
    }

    /// @notice Sell the drop's balance of `sellToken` for at least `minBuyAmount` of the buy token.
    /// @dev Not a step — call it directly. `presignConvert` decides whether this caller is allowed.
    function activateConvert(address owner, bytes calldata setupData, address sellToken, uint256 minBuyAmount)
        external
        returns (address drop)
    {
        if (sellToken == address(0)) revert NoSellToken();
        if (minBuyAmount == 0) revert ZeroBuyAmount();

        drop = EXECUTOR.dropOf(owner, setupData);

        (bytes32 tokenSlot, bytes32 amountSlot, bytes32 callerSlot) = _slotsOf(drop);
        assembly ("memory-safe") {
            tstore(tokenSlot, sellToken)
            tstore(amountSlot, minBuyAmount)
            tstore(callerSlot, caller())
        }

        EXECUTOR.activate(owner, setupData);

        // Cleared now, so a later call in the same transaction cannot inherit this input.
        assembly ("memory-safe") {
            tstore(tokenSlot, 0)
            tstore(amountSlot, 0)
            tstore(callerSlot, 0)
        }
    }

    /// @notice The input `activateConvert` is currently activating `drop` with, or zeroes.
    function pendingInput(address drop)
        external
        view
        returns (address sellToken, uint256 minBuyAmount, address activator)
    {
        (bytes32 tokenSlot, bytes32 amountSlot, bytes32 callerSlot) = _slotsOf(drop);
        assembly ("memory-safe") {
            sellToken := tload(tokenSlot)
            minBuyAmount := tload(amountSlot)
            activator := tload(callerSlot)
        }
    }

    /// @notice The committed half: sell the balance as one pre-signed CoW order.
    /// @dev Delegatecalled by the drop. An arrival already in `buyToken` is forwarded, not traded.
    /// @param owner  Admitted alongside the pricer, so a dead pricer cannot strand them.
    /// @param pricer The only allowed activator, or zero for anyone.
    function presignConvert(
        address buyToken,
        address receiver,
        address owner,
        address pricer,
        uint256 validitySeconds,
        bytes32 appData
    ) external returns (bytes memory orderUid) {
        if (receiver == address(0)) revert InvalidRecipient();

        (address sellToken, uint256 minBuyAmount, address activator) =
            ConvertSteps(CONVERT_STEPS).pendingInput(address(this));

        // A plain `activate` records nothing: zero here, caught by the gate or by the zero minimum.
        if (pricer != address(0) && activator != pricer && activator != owner) {
            revert NotThePricer(activator, pricer);
        }
        if (minBuyAmount == 0) revert ZeroBuyAmount();

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
            buyAmount: minBuyAmount,
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

    /// @dev Three consecutive slots, derived from the drop so no two drops collide.
    function _slotsOf(address drop) private pure returns (bytes32 tokenSlot, bytes32 amountSlot, bytes32 callerSlot) {
        tokenSlot = keccak256(abi.encode(INPUT_SLOT, drop));
        amountSlot = bytes32(uint256(tokenSlot) + 1);
        callerSlot = bytes32(uint256(tokenSlot) + 2);
    }
}
