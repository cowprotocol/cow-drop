// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {DropExecutor} from "src/DropExecutor.sol";
import {DropRecipes} from "src/DropRecipes.sol";
import {IComposableCowLike, ISettlementLike} from "src/interfaces/IDropExternal.sol";

import {COWShedExecutorFactory} from "cow-shed/COWShedExecutorFactory.sol";
import {COWShedForComposableCoW} from "cow-shed/COWShedForComposableCoW.sol";
import {IComposableCow} from "cow-shed/IComposableCow.sol";

import {DropConfig} from "./DropConfig.sol";

/// @notice Deploys the cow-drop stack.
///
/// @dev Everything is CREATE2 with a zero salt, so the addresses are reproducible and identical
///      across chains — which matters more here than usual: the shed implementation address is
///      part of every drop's init code and the factory is the CREATE2 deployer, so these four
///      addresses collectively define what every drop address is.
///
///      cow-shed's own deploy script builds a `COWShedExecutorFactory` over
///      `COWShedWithExecutorSigner`, but not one over `COWShedForComposableCoW` — and the
///      composable variant is the one that can own a conditional order. So we deploy our own.
///
///      Usage:
///        forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
contract DeployScript is Script {
    bytes32 internal constant SALT = bytes32(0);

    struct Deployment {
        address shedImplementation;
        address factory;
        address recipes;
        address executor;
    }

    function run() external returns (Deployment memory deployment) {
        deployment = deploy();
        _report(deployment);
        _write(deployment);
    }

    /// @dev Foundry routes `new X{salt: ...}` under `vm.broadcast()` through this canonical
        ///      CREATE2 deployer, so addresses are chain-independent.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function deploy() public returns (Deployment memory) {
        address composableCow = vm.envOr("COMPOSABLE_COW", DropConfig.COMPOSABLE_COW);

        // The ComposableCoW-aware shed: forwards EIP-1271 to ComposableCoW, which is what lets a
        // drop own a TWAP. Pre-signed orders need nothing from the implementation, so this one
        // implementation serves both order paths.
        //
        // Note this is the *canonical* cow-shed v2.1.0 implementation, not a fork: it is already
        // deployed on some chains at the address below, and because the CREATE2 address is derived
        // from the init code, reusing it is proof our build reproduces the official bytecode.
        bytes memory implInit =
            abi.encodePacked(type(COWShedForComposableCoW).creationCode, abi.encode(composableCow));
        address implementation = _create2(implInit);
        if (implementation.code.length == 0) {
            vm.broadcast();
            new COWShedForComposableCoW{salt: SALT}(IComposableCow(composableCow));
        } else {
            console.log("reusing existing shed implementation");
        }

        bytes memory factoryInit =
            abi.encodePacked(type(COWShedExecutorFactory).creationCode, abi.encode(implementation));
        address factory = _create2(factoryInit);
        if (factory.code.length == 0) {
            vm.broadcast();
            new COWShedExecutorFactory{salt: SALT}(implementation);
        } else {
            console.log("reusing existing executor factory");
        }

        address twapHandler = vm.envOr("TWAP_HANDLER", DropConfig.TWAP_HANDLER);
        address timestampFactory = vm.envOr("TIMESTAMP_FACTORY", DropConfig.CURRENT_BLOCK_TIMESTAMP_FACTORY);

        bytes memory recipesInit = abi.encodePacked(
            type(DropRecipes).creationCode,
            abi.encode(DropConfig.SETTLEMENT, DropConfig.VAULT_RELAYER, composableCow, twapHandler, timestampFactory)
        );
        address recipes = _create2(recipesInit);
        if (recipes.code.length == 0) {
            vm.broadcast();
            new DropRecipes{salt: SALT}(
                ISettlementLike(DropConfig.SETTLEMENT),
                DropConfig.VAULT_RELAYER,
                IComposableCowLike(composableCow),
                twapHandler,
                timestampFactory
            );
        }

        bytes memory executorInit = abi.encodePacked(type(DropExecutor).creationCode, abi.encode(factory));
        address executor = _create2(executorInit);
        if (executor.code.length == 0) {
            vm.broadcast();
            new DropExecutor{salt: SALT}(COWShedExecutorFactory(factory));
        }

        return Deployment({
            shedImplementation: implementation,
            factory: factory,
            recipes: recipes,
            executor: executor
        });
    }

    function _create2(bytes memory initCode) internal pure returns (address) {
        return vm.computeCreate2Address(SALT, keccak256(initCode), CREATE2_DEPLOYER);
    }

    function _report(Deployment memory d) internal view {
        console.log("chainId            ", block.chainid);
        console.log("shedImplementation ", d.shedImplementation);
        console.log("factory            ", d.factory);
        console.log("recipes            ", d.recipes);
        console.log("executor           ", d.executor);
    }

    /// @dev Written to a stable path so the SDK's constants can be generated from it rather than
    ///      transcribed by hand. A hand-copied address here is a wrong drop address everywhere.
    function _write(Deployment memory d) internal {
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "shedImplementation", d.shedImplementation);
        vm.serializeAddress(obj, "factory", d.factory);
        vm.serializeAddress(obj, "recipes", d.recipes);
        string memory json = vm.serializeAddress(obj, "executor", d.executor);

        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}
