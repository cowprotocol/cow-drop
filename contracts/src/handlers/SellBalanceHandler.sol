// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import {DropExecutor} from "../DropExecutor.sol";
import {IConditionalOrderHandler} from "../interfaces/IConditionalOrderHandler.sol";
import {IERC20Like} from "../interfaces/IDropExternal.sol";
import {HookOrderBase} from "../lib/HookOrderBase.sol";
import {Orders} from "../lib/Orders.sol";

/// @title SellBalanceHandler
/// @notice A ComposableCoW handler for "sell my whole balance of X for Y, at no worse than this price".
///
/// @dev The order is checked when it settles rather than fixed when the drop is activated, which is
///      what lets it be posted *before* activation: the amount and deadline are chosen off-chain, and
///      a pre-hook in the order's appData activates the drop inside the settlement that fills it.
///      That hook is plain `DropExecutor.activate`. The checks are `HookOrderBase`'s.
contract SellBalanceHandler is HookOrderBase {
    /// @dev `staticInput`. Must not mention the drop, which is derived from it.
    struct Data {
        address sellToken;
        address buyToken;
        address receiver;
        /// @dev Buy units per sell unit.
        uint256 limitNumerator;
        uint256 limitDenominator;
        /// @dev The furthest `validTo` may sit from the block the order settles in.
        uint256 validitySeconds;
        /// @dev Whether every order needs its own hook to have run the recipe: set it when the recipe
        ///      has a guard or a ration. See `HookOrderBase`.
        bool strict;
        /// @dev The appData of an order with no hook. Refused when `strict` and there is a template.
        bytes32 appData;
        /// @dev The JSON around the hook's calldata. Empty means no order carries a hook.
        bytes appDataPrefix;
        bytes appDataSuffix;
    }

    constructor(DropExecutor executor) HookOrderBase(executor) {}

    /// @inheritdoc IConditionalOrderHandler
    /// @dev `sender` is ignored: by the time a check reaches here through `DropExecutor` it is the
    ///      drop, not the settlement contract.
    function verify(
        address owner,
        address,
        bytes32 hash,
        bytes32 domainSeparator,
        bytes32,
        bytes calldata staticInput,
        bytes calldata offchainInput,
        LibCowOrder.Data calldata order
    ) external view override {
        Data memory data = abi.decode(staticInput, (Data));
        uint256 balance = _wholeBalance(owner, data.sellToken, order);
        _check(owner, hash, domainSeparator, order, _terms(data, balance), offchainInput);
    }

    /// @inheritdoc IConditionalOrderHandler
    /// @dev `validTo` is the end of a `validitySeconds` bucket rather than `now + validitySeconds`,
    ///      so every poll inside a bucket returns the same order instead of a new one per block.
    function getTradeableOrder(
        address owner,
        address,
        bytes32,
        bytes calldata staticInput,
        bytes calldata offchainInput
    ) external view override returns (LibCowOrder.Data memory) {
        Data memory data = abi.decode(staticInput, (Data));

        // A watch tower polls with no offchain input, and cannot produce the recipe. That is fine
        // for a recipe that takes an order without its hook, and the end of the road for one that
        // does not.
        if (data.strict && data.appDataPrefix.length != 0 && offchainInput.length == 0) {
            revert PollNever(NEEDS_RECIPE);
        }

        uint256 balance = IERC20Like(data.sellToken).balanceOf(owner);
        if (balance == 0) revert PollTryNextBlock("nothing to sell");

        uint256 validTo = block.timestamp;
        if (data.validitySeconds != 0) validTo = (validTo / data.validitySeconds + 1) * data.validitySeconds;
        if (validTo > type(uint32).max) revert PollNever("validTo overflow");

        Terms memory terms = _terms(data, balance);
        return LibCowOrder.Data({
            sellToken: IERC20(data.sellToken),
            buyToken: IERC20(data.buyToken),
            receiver: data.receiver,
            sellAmount: balance,
            buyAmount: terms.minBuyAmount,
            // casting to 'uint32' is safe because the bound is checked above
            // forge-lint: disable-next-line(unsafe-typecast)
            validTo: uint32(validTo),
            appData: _appData(owner, terms, offchainInput),
            feeAmount: 0,
            kind: Orders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: Orders.BALANCE_ERC20,
            buyTokenBalance: Orders.BALANCE_ERC20 // gitleaks:allow (balance-kind constant, not a secret)
        });
    }

    /// @dev The minimum is the committed price ratio applied to what arrived.
    function _terms(Data memory data, uint256 balance) internal pure returns (Terms memory) {
        return Terms({
            sellToken: data.sellToken,
            buyToken: data.buyToken,
            receiver: data.receiver,
            minBuyAmount: Orders.applyLimitPrice(balance, data.limitNumerator, data.limitDenominator),
            validitySeconds: data.validitySeconds,
            strict: data.strict,
            appData: data.appData,
            appDataPrefix: data.appDataPrefix,
            appDataSuffix: data.appDataSuffix
        });
    }

    /// @inheritdoc HookOrderBase
    function _hook(address shedOwner, bytes memory setupData, address) internal pure override returns (bytes memory) {
        return abi.encodeCall(DropExecutor.activate, (shedOwner, setupData));
    }
}
