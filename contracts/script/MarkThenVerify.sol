// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {PaymentHandler} from "src/handlers/PaymentHandler.sol";

/// @dev Marks itself as having run, then checks an order, in one transaction. Etched over a drop's
///      address by `_hookPayment`, since the mark is keyed by caller and lives one transaction.
contract MarkThenVerify {
    function run(PaymentHandler handler, bytes calldata verify) external {
        handler.markRan();
        (bool ok, bytes memory data) = address(handler).staticcall(verify);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(data, 0x20), mload(data))
            }
        }
    }
}
