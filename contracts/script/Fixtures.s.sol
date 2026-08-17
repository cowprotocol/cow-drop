// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Script} from "forge-std/Script.sol";

import {DropExecutor} from "src/DropExecutor.sol";

import {COWShed} from "cow-shed/COWShed.sol";
import {COWShedExecutorFactory} from "cow-shed/COWShedExecutorFactory.sol";
import {Call} from "cow-shed/ICOWAuthHook.sol";

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
        DropExecutor executor = new DropExecutor(factory);

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

        string memory json = vm.serializeString(root, "cases", cases);
        vm.writeJson(json, "./deployments/derivation-fixtures.json");
    }

    function _caseCount() internal pure returns (uint256) {
        return 6;
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
                target: address(0xB0B),
                value: 0,
                callData: hex"deadbeef",
                allowFailure: false,
                isDelegateCall: false
            });
            return (address(0xA11CE), _encode("single", false, calls), "one plain call");
        }
        if (i == 2) {
            Call[] memory calls = new Call[](1);
            calls[0] = Call({
                target: address(0xB0B),
                value: 1 ether,
                callData: "",
                allowFailure: true,
                isDelegateCall: true
            });
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
                target: address(0xB0B),
                value: 0,
                callData: hex"deadbeef",
                allowFailure: false,
                isDelegateCall: false
            });
            return (address(0xD00D), _encode("single", false, calls), "different owner, same recipe");
        }
        // Same recipe as case 1, different label: must give a different address.
        Call[] memory relabelled = new Call[](1);
        relabelled[0] =
            Call({target: address(0xB0B), value: 0, callData: hex"deadbeef", allowFailure: false, isDelegateCall: false});
        return (address(0xA11CE), _encode("relabelled", false, relabelled), "different label, same calls");
    }

    function _encode(bytes32 label, bool once, Call[] memory calls) internal pure returns (bytes memory) {
        return abi.encode(DropExecutor.Recipe({label: label, once: once, calls: calls}));
    }
}
