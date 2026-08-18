// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {IERC20Like, IPriceFeedLike} from "../interfaces/IDropExternal.sol";

/// @notice A price feed answered with a non-positive price.
error BadOraclePrice(address feed, int256 answer);

/// @notice A price feed has not been updated recently enough to be trusted.
error StaleOraclePrice(address feed, uint256 updatedAt, uint256 maxAge);

/// @title Oracle
/// @notice Turning a pair of Chainlink-style feeds into an amount of buy token.
///
/// @dev A library of `internal` functions, so it is inlined and never deployed — no address, and
///      therefore nothing here can move a drop address. See `contracts/README.md` on the layout.
///
///      Every read is checked for a positive answer and for staleness. A feed that has stopped
///      updating otherwise reads as a confident wrong price, which for a step that sets an order's
///      limit is the worst kind of failure: the order still looks valid.
library Oracle {
    uint256 internal constant ONE = 1e18;

    /// @notice The value of `sellAmount` sell-token atoms, expressed in buy-token atoms.
    ///
    /// @dev Both feeds **must quote the same currency** — that is not checkable on-chain and is on the
    ///      author. The prices are normalised to 18 decimals before the ratio, and the ratio is then
    ///      adjusted for the two tokens' own decimals, which is what makes this an atom-to-atom answer
    ///      rather than a price.
    function valueOf(
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        address sellFeed,
        address buyFeed,
        uint256 maxAge
    ) internal view returns (uint256 buyAmount) {
        uint256 sellPrice = _price(sellFeed, maxAge);
        uint256 buyPrice = _price(buyFeed, maxAge);

        // sellAmount * (sellPrice / buyPrice), then rebased from sell-token atoms to buy-token atoms.
        buyAmount = (sellAmount * sellPrice) / buyPrice;

        uint8 sellDecimals = IERC20Like(sellToken).decimals();
        uint8 buyDecimals = IERC20Like(buyToken).decimals();
        if (buyDecimals > sellDecimals) {
            buyAmount = buyAmount * (10 ** (buyDecimals - sellDecimals));
        } else if (sellDecimals > buyDecimals) {
            buyAmount = buyAmount / (10 ** (sellDecimals - buyDecimals));
        }
    }

    /// @dev A feed's answer, scaled to 18 decimals, having checked it is positive and fresh.
    function _price(address feed, uint256 maxAge) private view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = IPriceFeedLike(feed).latestRoundData();
        if (answer <= 0) revert BadOraclePrice(feed, answer);
        if (block.timestamp - updatedAt > maxAge) revert StaleOraclePrice(feed, updatedAt, maxAge);

        uint8 feedDecimals = IPriceFeedLike(feed).decimals();
        uint256 price = uint256(answer);
        if (feedDecimals < 18) return price * (10 ** (18 - feedDecimals));
        if (feedDecimals > 18) return price / (10 ** (feedDecimals - 18));
        return price;
    }
}
