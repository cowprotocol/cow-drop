// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {IConditionalOrder} from "cow-shed/IConditionalOrder.sol";

/// @dev The slice of ERC20 the recipe primitives need.
interface IERC20Like {
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @dev The slice of GPv2Settlement the recipe primitives need.
interface ISettlementLike {
    function domainSeparator() external view returns (bytes32);
    function setPreSignature(bytes calldata orderUid, bool signed) external;
    function preSignature(bytes calldata orderUid) external view returns (uint256);
}

/// @dev `createWithContext` is missing from cow-shed's vendored `IComposableCow`, and it is the
///      overload that matters here: it seeds ComposableCoW's `cabinet` from a value factory, which
///      is how a TWAP starts counting from activation instead of from a timestamp that would
///      otherwise have to be committed into the drop address.
interface IComposableCowLike {
    function create(IConditionalOrder.ConditionalOrderParams calldata params, bool dispatch) external;

    function createWithContext(
        IConditionalOrder.ConditionalOrderParams calldata params,
        address valueFactory,
        bytes calldata data,
        bool dispatch
    ) external;

    function singleOrders(address owner, bytes32 singleOrderHash) external view returns (bool);
    function cabinet(address owner, bytes32 ctx) external view returns (bytes32);
    function domainSeparator() external view returns (bytes32);
}

/// @dev Wrapped native token (WETH / WXDAI), so native-funded drops can trade.
interface IWrappedNative {
    function deposit() external payable;
}

/// @dev Chainlink's `AggregatorV3Interface`, narrowed to what a price-reading step needs.
interface IPriceFeedLike {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
