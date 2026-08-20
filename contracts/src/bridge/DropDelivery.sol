// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

import {DropExecutor} from "../DropExecutor.sol";
import {IERC20Like} from "../interfaces/IDropExternal.sol";

/// @title DropDelivery
/// @notice The shared half of a bridge receiver: take custody of what a bridge just delivered, hand
///         it to the drop the payload names, and activate it — all inside the bridge's own fill.
///
/// @dev ## Why this is not a function on `DropExecutor`
///
/// `DropExecutor`'s address is both the `trustedExecutor` and the `setupTarget` in every drop's
/// CREATE2 preimage. Adding an entry point to it would change its bytecode, which would change its
/// address, which would move **every drop address in existence** and force a new generation. So a
/// bridge entry point has to be a separate contract that *calls* `DropExecutor` rather than a method
/// on it.
///
/// That constraint pays for itself. Nothing in a recipe reaches this contract, so it is outside the
/// commitment entirely: receivers can be added, fixed or redeployed for new bridges without a single
/// drop address moving. It is the same category as `CowOrderPoster` — shipped with a generation,
/// but not an input to one.
///
/// ## What a receiver is for
///
/// Nothing here is *required* to bridge into a drop. A drop address is fundable before it exists, so
/// the plainest integration names `dropOf(owner, setupData)` as the bridge's recipient and lets a
/// keeper activate once the money lands. This contract buys two things over that: the order goes
/// live in the same transaction as the fill, with no keeper latency and nobody's gas budget in the
/// way, and the relayer filling the bridge pays for the activation as part of a job it is already
/// being paid for.
///
/// ## The two-phase shape, and why `deliverAndActivate` is external
///
/// A delivery has to be able to *decline* to activate. The recipe may carry a `requireMinBalance`
/// guard and the bridge may be paying in tranches, in which case refusing the first tranche is the
/// guard working, not failing. But by the time that is known the tokens have already been forwarded,
/// and a refund can no longer reach them.
///
/// So the forwarding and the activation happen together in an external self-call under `try/catch`.
/// A failed activation reverts the forwarding with it, and the catch branch still holds the tokens —
/// which is what makes `OnFailure` a real choice rather than a wish.
///
/// ## What is deliberately not defended against
///
/// This contract is a pass-through that holds nothing between transactions, so **anything left
/// sitting in it is claimable by anyone**: the entry points are permissionless by necessity (a
/// relayer's address is not knowable across every route a bridge might take), and they forward
/// whatever balance they find. That is inherent to a permissionless delivery endpoint and is the
/// reason it forwards everything rather than parking a remainder. Do not send funds here directly.
///
/// It is guarded against reentrancy, though, for one window that is easy to miss. A pass-through
/// holds nothing *between* transactions but does hold funds *during* one: part-way through forwarding
/// a multi-token delivery, the tokens not yet sent are still here. A hostile token delivered
/// alongside a real one could use its transfer hook to re-enter and redirect the remainder into a
/// drop of its own. The guard is transient storage, so it costs ~100 gas rather than an `SSTORE`
/// pair — which matters when the gas budget is prepaid on another chain.
abstract contract DropDelivery {
    using SafeERC20 for IERC20;

    /// @notice What to do with the delivered tokens when the activation will not run.
    ///
    /// @dev Part of the payload rather than the receiver's configuration, because it is a property of
    ///      one delivery: the same receiver serves a tranched bridge that must wait and a one-shot
    ///      transfer that must not.
    enum OnFailure {
        /// @dev Forward to the drop anyway and leave it there. The default, and the right answer for
        ///      any recipe with a guard: the funds sit at a deterministic address whose admin is the
        ///      owner, a keeper retries on its next tick, and later tranches accumulate normally.
        LeaveAtDrop,
        /// @dev Send everything back to the owner. The escape hatch for someone who would rather have
        ///      the tokens in their wallet than at an address whose recipe they have to keep to spend.
        ///      Wrong for a tranched bridge, which is why the SDK refuses to pair it with a
        ///      `requireMinBalance` recipe.
        RefundOwner
    }

    /// @notice A delivery landed at `drop`. `activated` says whether the recipe ran.
    event DropDelivered(address indexed drop, address indexed owner, bool activated);

    /// @notice A delivery could not activate and was returned to the owner instead.
    event DropRefunded(address indexed drop, address indexed owner);

    /// @notice `deliverAndActivate` was called by someone other than this contract.
    error NotSelf();

    /// @notice The payload asks for a refund to the zero address, which would burn the delivery.
    error NoRefundAddress();

    /// @notice A native-token transfer was rejected by its recipient.
    error NativeTransferFailed();

    /// @notice A delivery tried to start while one was already in progress.
    error Reentered();

    /// @notice The executor every delivery activates through.
    DropExecutor public immutable EXECUTOR;

    /// @dev Set for the duration of one delivery. Transient, so it clears itself at the end of the
    ///      transaction and never pays for an `SSTORE`.
    bool private transient delivering;

    /// @dev The pseudo-address bridges use for a chain's native token. Bungee, Across and LiFi all
    ///      spell it this way; `address(0)` is accepted alongside it because some routes do.
    address internal constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    constructor(DropExecutor executor) {
        EXECUTOR = executor;
    }

    /// @notice Forward this contract's balances to the drop and run its recipe, atomically.
    ///
    /// @dev External only so that `_deliver` can call it on itself under `try/catch`. It is not an
    ///      entry point: `msg.sender` must be this contract, and a direct caller gets `NotSelf`.
    ///      Without that check anyone could push the receiver's balance into a drop of their choosing
    ///      — which is only ever a problem for funds that should not be here, but the check costs one
    ///      comparison and removes the question.
    function deliverAndActivate(address owner, bytes calldata setupData, address[] calldata tokens) external {
        if (msg.sender != address(this)) revert NotSelf();

        _forward(tokens, EXECUTOR.dropOf(owner, setupData));
        EXECUTOR.activate(owner, setupData);
    }

    /// @dev The body of every bridge entry point. `payload` is
    ///      `abi.encode(address owner, bytes setupData, uint8 onFailure)`, and `tokens` is what the
    ///      bridge says it delivered.
    ///
    ///      A malformed payload reverts, and that is safe rather than reckless: the bridge's transfer
    ///      and its call are the same transaction, so reverting rolls the transfer back and the funds
    ///      never leave the bridge to be stranded here. A *recipe* that will not run is the opposite
    ///      case — an expected outcome with money already in hand — and gets `OnFailure` instead.
    function _deliver(bytes memory payload, address[] memory tokens) internal {
        // Guards the window in which this contract is genuinely holding something: between the first
        // token forwarded and the last. Deliberately not on `deliverAndActivate`, which is re-entered
        // by design — that self-call is how a failed activation gets rolled back.
        if (delivering) revert Reentered();
        delivering = true;

        (address owner, bytes memory setupData, OnFailure onFailure) = abi.decode(payload, (address, bytes, OnFailure));

        // Checked before anything moves, so an impossible payload fails the same way every time
        // rather than only in the branch that would have burned the tokens.
        if (onFailure == OnFailure.RefundOwner && owner == address(0)) revert NoRefundAddress();

        address drop = EXECUTOR.dropOf(owner, setupData);

        try this.deliverAndActivate(owner, setupData, tokens) {
            emit DropDelivered(drop, owner, true);
        } catch {
            // The self-call rolled its own forwarding back, so everything is still here to place.
            if (onFailure == OnFailure.RefundOwner) {
                _forward(tokens, owner);
                emit DropRefunded(drop, owner);
            } else {
                _forward(tokens, drop);
                emit DropDelivered(drop, owner, false);
            }
        }

        delivering = false;
    }

    /// @dev Move every named token, plus any native balance, to `to`.
    ///
    ///      Sends the balance this contract actually holds rather than the amounts the bridge
    ///      reported. Two reasons, and the second is the one that matters: a fee-on-transfer token or
    ///      a route that over-delivers would otherwise leave a remainder behind, and a remainder in a
    ///      permissionless pass-through is somebody else's to claim. The recipe sizes the order from
    ///      what arrives regardless, so the reported amounts are not needed to be correct — only to
    ///      name which tokens to look at.
    ///
    ///      Native is swept unconditionally at the end rather than in response to the sentinel, so a
    ///      route that sends value without naming it still cannot leave any here. An empty balance is
    ///      skipped rather than reverted: a delivery naming three tokens should move the two that
    ///      arrived.
    function _forward(address[] memory tokens, address to) internal {
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            if (token == NATIVE || token == address(0)) continue;

            uint256 balance = IERC20Like(token).balanceOf(address(this));
            if (balance == 0) continue;
            // SafeERC20, because a delivery should not be defeated by a token that returns no boolean.
            IERC20(token).safeTransfer(to, balance);
        }

        uint256 native = address(this).balance;
        if (native != 0) {
            (bool ok,) = payable(to).call{value: native}("");
            if (!ok) revert NativeTransferFailed();
        }
    }
}
