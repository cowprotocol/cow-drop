// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Script} from "forge-std/Script.sol";

import {DropExecutor} from "src/DropExecutor.sol";

import {COWShed} from "cow-shed/COWShed.sol";
import {COWShedExecutorFactory} from "cow-shed/COWShedExecutorFactory.sol";
import {Call} from "cow-shed/ICOWAuthHook.sol";
import {IComposableCow} from "cow-shed/IComposableCow.sol";
import {IConditionalOrder} from "cow-shed/IConditionalOrder.sol";

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

        string memory json = vm.serializeString(root, "conditionalOrders", orders);
        vm.writeJson(json, "./deployments/derivation-fixtures.json");
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
                calls[j] = Call({
                    target: address(uint160(0xC0FFEE + j)),
                    value: j,
                    callData: abi.encodePacked(bytes4(uint32(j)), new bytes(j * 40)),
                    allowFailure: j % 2 == 0,
                    isDelegateCall: j % 2 == 1
                });
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
