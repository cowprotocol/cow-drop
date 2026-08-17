// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {DropExecutor} from "src/DropExecutor.sol";
import {DropRecipes} from "src/DropRecipes.sol";
import {IComposableCowLike, ISettlementLike} from "src/interfaces/IDropExternal.sol";

import {COWShedExecutorFactory} from "cow-shed/COWShedExecutorFactory.sol";
import {COWShedWithExecutorSigner} from "cow-shed/COWShedWithExecutorSigner.sol";
import {IComposableCow} from "cow-shed/IComposableCow.sol";

import {DropConfig} from "./DropConfig.sol";

/// @notice Deploys the cow-drop stack.
///
/// @dev Everything is CREATE2 with a zero salt, so the addresses are reproducible and identical
///      across chains — which matters more here than usual: the shed implementation address is
///      part of every drop's init code and the factory is the CREATE2 deployer, so these four
///      addresses collectively define what every drop address is.
///
///      Both cow-shed contracts are the canonical ones cow-shed#79 records as live on Gnosis, reused
///      rather than redeployed — so the only contracts this deploys are `DropRecipes` and
///      `DropExecutor`. On a chain where they do not exist yet they land at the same addresses.
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

        // `COWShedWithExecutorSigner`: its EIP-1271 delegates to the shed's trusted executor, which
        // for a drop is `DropExecutor` — so that is where ComposableCoW forwarding lives, and one
        // implementation serves both order paths (pre-signing needs nothing from it).
        //
        // This is the exact implementation cow-shed#79 records as live on Gnosis, together with the
        // factory below. Reusing them rather than deploying our own variants means a drop address is
        // derived entirely from canonical cow-shed contracts; the only things we deploy are
        // `DropRecipes` and `DropExecutor`. Because a CREATE2 address is derived from the init code,
        // landing on #79's addresses is also proof this build reproduces the deployed bytecode.
        bytes memory implInit = type(COWShedWithExecutorSigner).creationCode;
        address implementation = _create2(implInit);
        if (implementation.code.length == 0) {
            vm.broadcast();
            new COWShedWithExecutorSigner{salt: SALT}();
        } else {
            console.log("reusing canonical cow-shed implementation (cow-shed#79)");
        }

        bytes memory factoryInit =
            abi.encodePacked(type(COWShedExecutorFactory).creationCode, abi.encode(implementation));
        address factory = _create2(factoryInit);
        if (factory.code.length == 0) {
            vm.broadcast();
            new COWShedExecutorFactory{salt: SALT}(implementation);
        } else {
            console.log("reusing canonical executor factory (cow-shed#79)");
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

        bytes memory executorInit =
            abi.encodePacked(type(DropExecutor).creationCode, abi.encode(factory, composableCow));
        address executor = _create2(executorInit);
        if (executor.code.length == 0) {
            vm.broadcast();
            new DropExecutor{salt: SALT}(COWShedExecutorFactory(factory), IComposableCow(composableCow));
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
