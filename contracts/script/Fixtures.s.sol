// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Script} from "forge-std/Script.sol";

import {DropExecutor} from "src/DropExecutor.sol";
import {Orders} from "src/lib/Orders.sol";

import {COWShed} from "cow-shed/COWShed.sol";
import {COWShedExecutorFactory} from "cow-shed/COWShedExecutorFactory.sol";
import {Call} from "cow-shed/ICOWAuthHook.sol";
import {IComposableCow} from "cow-shed/IComposableCow.sol";
import {IConditionalOrder} from "cow-shed/IConditionalOrder.sol";
import {LibCowOrder} from "cow-shed/LibCowOrder.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/// @notice Generates address-derivation fixtures for the SDK to check itself against.
///
/// @dev The SDK reimplements the CREATE2 derivation off-chain so a UI can quote a drop address
///      without an RPC round trip. Two implementations of the same formula is exactly the kind of
///      duplication that silently drifts, and drift here means quoting an address that funds are
///      then sent to and stranded at. So the contract emits the ground truth and the SDK's test
///      suite asserts against it.
///
///      Every input the SDK needs is included, so the fixtures validate the formula rather than
///      one particular deployment's addresses.
///
///      Regenerate with:  forge script script/Fixtures.s.sol
contract FixturesScript is Script {
    function run() external {
        COWShed implementation = new COWShed();
        COWShedExecutorFactory factory = new COWShedExecutorFactory(address(implementation));
        DropExecutor executor = new DropExecutor(factory, IComposableCow(address(0)));

        string memory root = "fixtures";
        vm.serializeAddress(root, "implementation", address(implementation));
        vm.serializeAddress(root, "factory", address(factory));
        vm.serializeAddress(root, "executor", address(executor));
        vm.serializeBytes(root, "proxyCreationCode", factory.PROXY_CREATION_CODE());

        string[] memory cases = new string[](_caseCount());
        for (uint256 i; i < _caseCount(); i++) {
            (address owner, bytes memory setupData, string memory name) = _case(i);

            string memory obj = string.concat("case", vm.toString(i));
            vm.serializeString(obj, "name", name);
            vm.serializeAddress(obj, "owner", owner);
            vm.serializeBytes(obj, "setupData", setupData);
            cases[i] = vm.serializeAddress(obj, "expected", executor.dropOf(owner, setupData));
        }

        vm.serializeString(root, "cases", cases);

        // ComposableCoW keys an authorisation by `keccak256(abi.encode(params))`, and a rescue that
        // retires an order has to reproduce that hash off-chain. Same reasoning as the drop-address
        // cases above: two implementations of one formula drift silently, and here the failure mode is
        // a rescue that looks like it retired an order and did not.
        string[] memory orders = new string[](_orderCaseCount());
        for (uint256 i; i < _orderCaseCount(); i++) {
            (IConditionalOrder.ConditionalOrderParams memory params, string memory name) = _orderCase(i);

            string memory obj = string.concat("order", vm.toString(i));
            vm.serializeString(obj, "name", name);
            vm.serializeAddress(obj, "handler", address(params.handler));
            vm.serializeBytes32(obj, "salt", params.salt);
            vm.serializeBytes(obj, "staticInput", params.staticInput);
            orders[i] = vm.serializeBytes32(obj, "expected", keccak256(abi.encode(params)));
        }

        vm.serializeString(root, "conditionalOrders", orders);

        // `OrderPlacement` carries no order uid — the owner travels in `sender` and the digest is
        // recomputed by whoever reads the log. So the SDK now hashes GPv2 orders itself, and that is a
        // second implementation of `LibCowOrder.hash` plus `Orders.packUid`. Drift here means a watch
        // tower that checks the pre-signature of a uid no order ever had, and therefore posts nothing.
        string[] memory uids = new string[](_orderUidCaseCount());
        for (uint256 i; i < _orderUidCaseCount(); i++) {
            (LibCowOrder.Data memory order, bytes32 domainSeparator, address owner, string memory name) =
                _orderUidCase(i);

            bytes32 digest = LibCowOrder.hash(order, domainSeparator);

            string memory obj = string.concat("uid", vm.toString(i));
            vm.serializeString(obj, "name", name);
            vm.serializeBytes32(obj, "domainSeparator", domainSeparator);
            vm.serializeAddress(obj, "owner", owner);
            vm.serializeString(obj, "order", _serializeOrder(string.concat(obj, "order"), order));
            vm.serializeBytes32(obj, "digest", digest);
            uids[i] = vm.serializeBytes(obj, "expected", Orders.packUid(digest, owner, order.validTo));
        }

        string memory json = vm.serializeString(root, "orderUids", uids);
        vm.writeJson(json, "./deployments/derivation-fixtures.json");
    }

    function _serializeOrder(string memory obj, LibCowOrder.Data memory order) internal returns (string memory) {
        vm.serializeAddress(obj, "sellToken", address(order.sellToken));
        vm.serializeAddress(obj, "buyToken", address(order.buyToken));
        vm.serializeAddress(obj, "receiver", order.receiver);
        vm.serializeUint(obj, "sellAmount", order.sellAmount);
        vm.serializeUint(obj, "buyAmount", order.buyAmount);
        vm.serializeUint(obj, "validTo", order.validTo);
        vm.serializeBytes32(obj, "appData", order.appData);
        vm.serializeUint(obj, "feeAmount", order.feeAmount);
        vm.serializeBytes32(obj, "kind", order.kind);
        vm.serializeBool(obj, "partiallyFillable", order.partiallyFillable);
        vm.serializeBytes32(obj, "sellTokenBalance", order.sellTokenBalance);
        return vm.serializeBytes32(obj, "buyTokenBalance", order.buyTokenBalance);
    }

    function _orderUidCaseCount() internal pure returns (uint256) {
        return 4;
    }

    /// @dev Spans what the EIP-712 encoding and the uid packing can get wrong: a zero receiver (which
    ///      GPv2 reads as "same as owner"), both order kinds, both balance sources, a `validTo` at the
    ///      uint32 boundary, and amounts above 2^128 so a 64-bit slip shows up.
    function _orderUidCase(uint256 i)
        internal
        pure
        returns (LibCowOrder.Data memory order, bytes32 domainSeparator, address owner, string memory name)
    {
        order = LibCowOrder.Data({
            sellToken: IERC20(address(0x5E11)),
            buyToken: IERC20(address(0xB111)),
            receiver: address(0xBEEF),
            sellAmount: 100e18,
            buyAmount: 95e18,
            validTo: 1_800_003_600,
            appData: keccak256("appData"),
            feeAmount: 0,
            kind: Orders.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: Orders.BALANCE_ERC20,
            buyTokenBalance: Orders.BALANCE_ERC20
        });

        if (i == 0) {
            return (order, keccak256("domain"), address(0xA11CE), "sell order, plain");
        }
        if (i == 1) {
            order.receiver = address(0);
            order.kind = Orders.KIND_BUY;
            order.partiallyFillable = true;
            return (order, keccak256("domain"), address(0xA11CE), "buy order, zero receiver, partial");
        }
        if (i == 2) {
            order.sellAmount = type(uint128).max;
            order.buyAmount = uint256(type(uint128).max) + 1;
            order.validTo = type(uint32).max;
            order.feeAmount = 12_345;
            return (order, keccak256("another domain"), address(0xD00D), "large amounts, max validTo, non-zero fee");
        }
        order.appData = bytes32(0);
        order.validTo = 0;
        return (order, bytes32(0), address(type(uint160).max), "zero appData, zero validTo, max owner");
    }

    function _caseCount() internal pure returns (uint256) {
        return 8;
    }

    function _orderCaseCount() internal pure returns (uint256) {
        return 4;
    }

    /// @dev Spans the shapes that matter to the encoding: empty `staticInput`, a short one, one that
    ///      crosses a word boundary (so the length prefix and padding both matter), and a non-zero salt.
    function _orderCase(uint256 i)
        internal
        pure
        returns (IConditionalOrder.ConditionalOrderParams memory params, string memory name)
    {
        if (i == 0) {
            return (
                IConditionalOrder.ConditionalOrderParams({
                    handler: IConditionalOrder(address(0x7A9F)), salt: bytes32(0), staticInput: ""
                }),
                "empty static input"
            );
        }
        if (i == 1) {
            return (
                IConditionalOrder.ConditionalOrderParams({
                    handler: IConditionalOrder(address(0x7A9F)), salt: bytes32(0), staticInput: hex"deadbeef"
                }),
                "short static input"
            );
        }
        if (i == 2) {
            return (
                IConditionalOrder.ConditionalOrderParams({
                    handler: IConditionalOrder(address(0x570F)),
                    salt: bytes32(uint256(1)),
                    staticInput: abi.encode(uint256(1), uint256(2), address(0xB0B))
                }),
                "multi-word static input, non-zero salt"
            );
        }
        return (
            IConditionalOrder.ConditionalOrderParams({
                handler: IConditionalOrder(address(0x570F)),
                salt: bytes32(type(uint256).max),
                staticInput: hex"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff11"
            }),
            "static input crossing a word boundary, max salt"
        );
    }

    /// @dev Deliberately spans the encoding edge cases: no calls, one call, several calls, empty
    ///      calldata, long calldata, non-zero value, both booleans, and the `once` flag.
    function _case(uint256 i) internal pure returns (address owner, bytes memory setupData, string memory name) {
        if (i == 0) {
            return (address(0xA11CE), _encode("empty", false, new Call[](0)), "no calls");
        }
        if (i == 1) {
            Call[] memory calls = new Call[](1);
            calls[0] = Call({
                target: address(0xB0B), value: 0, callData: hex"deadbeef", allowFailure: false, isDelegateCall: false
            });
            return (address(0xA11CE), _encode("single", false, calls), "one plain call");
        }
        if (i == 2) {
            Call[] memory calls = new Call[](1);
            calls[0] =
                Call({target: address(0xB0B), value: 1 ether, callData: "", allowFailure: true, isDelegateCall: true});
            return (address(0xA11CE), _encode("flags", true, calls), "empty calldata, both flags, once");
        }
        if (i == 3) {
            Call[] memory calls = new Call[](3);
            for (uint256 j; j < 3; j++) {
                // both casts are safe because `j < 3`
                // forge-lint: disable-start(unsafe-typecast)
                calls[j] = Call({
                    target: address(uint160(0xC0FFEE + j)),
                    value: j,
                    callData: abi.encodePacked(bytes4(uint32(j)), new bytes(j * 40)),
                    allowFailure: j % 2 == 0,
                    isDelegateCall: j % 2 == 1
                });
                // forge-lint: disable-end(unsafe-typecast)
            }
            return (address(0xA11CE), _encode("multi", false, calls), "three calls, varying lengths");
        }
        if (i == 4) {
            // Same recipe as case 1, different owner: must give a different address.
            Call[] memory calls = new Call[](1);
            calls[0] = Call({
                target: address(0xB0B), value: 0, callData: hex"deadbeef", allowFailure: false, isDelegateCall: false
            });
            return (address(0xD00D), _encode("single", false, calls), "different owner, same recipe");
        }
        if (i == 6) {
            // Same recipe as case 1 but with a non-zero salt: exercises the salt being read back out
            // of the encoding and fed to the factory, in both implementations.
            Call[] memory calls = new Call[](1);
            calls[0] = Call({
                target: address(0xB0B), value: 0, callData: hex"deadbeef", allowFailure: false, isDelegateCall: false
            });
            return (address(0xA11CE), _encodeSalted("single", bytes32(uint256(1)), false, calls), "non-zero salt");
        }
        if (i == 7) {
            // A high-bit salt, so the SDK cannot get away with treating it as a small number.
            Call[] memory calls = new Call[](1);
            calls[0] = Call({
                target: address(0xB0B), value: 0, callData: hex"deadbeef", allowFailure: false, isDelegateCall: false
            });
            return (address(0xA11CE), _encodeSalted("single", bytes32(type(uint256).max), false, calls), "max salt");
        }
        // Same recipe as case 1, different label: must give a different address.
        Call[] memory relabelled = new Call[](1);
        relabelled[0] = Call({
            target: address(0xB0B), value: 0, callData: hex"deadbeef", allowFailure: false, isDelegateCall: false
        });
        return (address(0xA11CE), _encode("relabelled", false, relabelled), "different label, same calls");
    }

    function _encode(bytes32 label, bool once, Call[] memory calls) internal pure returns (bytes memory) {
        return _encodeSalted(label, bytes32(0), once, calls);
    }

    function _encodeSalted(bytes32 label, bytes32 salt, bool once, Call[] memory calls)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(DropExecutor.Recipe({label: label, salt: salt, once: once, calls: calls}));
    }
}
