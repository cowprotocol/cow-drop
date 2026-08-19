// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {CowOrderPoster} from "src/CowOrderPoster.sol";
import {DropExecutor} from "src/DropExecutor.sol";
import {IComposableCowLike, ISettlementLike} from "src/interfaces/IDropExternal.sol";
import {GuardSteps} from "src/steps/GuardSteps.sol";
import {PresignSteps} from "src/steps/PresignSteps.sol";
import {StopLossSteps} from "src/steps/StopLossSteps.sol";
import {TokenSteps} from "src/steps/TokenSteps.sol";
import {TwapSteps} from "src/steps/TwapSteps.sol";

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
///      rather than redeployed — so the only contracts this deploys are the four step contracts and
///      `DropExecutor`. On a chain where they do not exist yet they land at the same addresses.
///
///      Usage:
///        forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
contract DeployScript is Script {
    bytes32 internal constant SALT = bytes32(0);

    /// @notice Which generation of the stack this script deploys.
    ///
    /// @dev Every address below is part of the CREATE2 preimage of every drop, so any change to the
    ///      code, the constructor arguments or the compiler settings moves *every* drop address. A
    ///      recipe file therefore cannot mean anything on its own — it has to say which generation it
    ///      was compiled against, or the address it resolves to today is not the address it resolved
    ///      to when someone wrote the file down. That matters more than usual here: a drop is funded
    ///      before it exists, and the recipe is the only way back to the funds.
    ///
    ///      So each generation gets its own output directory and is never overwritten. Bump this
    ///      whenever any input to an address changes, and leave the previous directory alone: the
    ///      contracts it names stay deployed, and the SDK keeps compiling old recipes against them.
    uint256 internal constant GENERATION = 1;

    struct Deployment {
        address shedImplementation;
        address factory;
        address guardSteps;
        address tokenSteps;
        address presignSteps;
        address twapSteps;
        address stopLossSteps;
        address cowOrderPoster;
        address composableCow;
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
        // derived entirely from canonical cow-shed contracts; the only things we deploy are the step
        // contracts and `DropExecutor`. Because a CREATE2 address is derived from the init code,
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

        // The step contracts, deployed separately so that each one's address depends only on what it
        // actually needs. A step's address is committed into every drop address that reaches it, so a
        // single contract would make the guards and the rescue sweep move every time the TWAP handler
        // did. `GuardSteps` and `TokenSteps` take no constructor arguments at all, which is what
        // makes their addresses depend on nothing but their own code. See `src/steps/`.
        address guardSteps = _create2(type(GuardSteps).creationCode);
        if (guardSteps.code.length == 0) {
            vm.broadcast();
            new GuardSteps{salt: SALT}();
        }

        address tokenSteps = _create2(type(TokenSteps).creationCode);
        if (tokenSteps.code.length == 0) {
            vm.broadcast();
            new TokenSteps{salt: SALT}();
        }

        bytes memory presignInit = abi.encodePacked(
            type(PresignSteps).creationCode, abi.encode(DropConfig.SETTLEMENT, DropConfig.VAULT_RELAYER)
        );
        address presignSteps = _create2(presignInit);
        if (presignSteps.code.length == 0) {
            vm.broadcast();
            new PresignSteps{salt: SALT}(ISettlementLike(DropConfig.SETTLEMENT), DropConfig.VAULT_RELAYER);
        }

        bytes memory twapInit = abi.encodePacked(
            type(TwapSteps).creationCode,
            abi.encode(DropConfig.VAULT_RELAYER, composableCow, twapHandler, timestampFactory)
        );
        address twapSteps = _create2(twapInit);
        if (twapSteps.code.length == 0) {
            vm.broadcast();
            new TwapSteps{salt: SALT}(
                DropConfig.VAULT_RELAYER, IComposableCowLike(composableCow), twapHandler, timestampFactory
            );
        }

        bytes memory executorInit =
            abi.encodePacked(type(DropExecutor).creationCode, abi.encode(factory, composableCow));
        address executor = _create2(executorInit);
        if (executor.code.length == 0) {
            vm.broadcast();
            new DropExecutor{salt: SALT}(COWShedExecutorFactory(factory), IComposableCow(composableCow));
        }

        address stopLossHandler = vm.envOr("STOP_LOSS_HANDLER", DropConfig.STOP_LOSS_HANDLER);
        bytes memory stopLossInit = abi.encodePacked(
            type(StopLossSteps).creationCode, abi.encode(DropConfig.VAULT_RELAYER, composableCow, stopLossHandler)
        );
        address stopLossSteps = _create2(stopLossInit);
        if (stopLossSteps.code.length == 0) {
            vm.broadcast();
            new StopLossSteps{salt: SALT}(DropConfig.VAULT_RELAYER, IComposableCowLike(composableCow), stopLossHandler);
        }

        // Not part of any drop address: nothing in a recipe reaches it, because the steps inline the
        // `CowOrder` library instead. It ships with the generation because it is the address a
        // third-party contract integrates against, and that address has to be stable and recorded.
        bytes memory posterInit = abi.encodePacked(type(CowOrderPoster).creationCode, abi.encode(DropConfig.SETTLEMENT));
        address cowOrderPoster = _create2(posterInit);
        if (cowOrderPoster.code.length == 0) {
            vm.broadcast();
            new CowOrderPoster{salt: SALT}(ISettlementLike(DropConfig.SETTLEMENT));
        }

        return Deployment({
            shedImplementation: implementation,
            factory: factory,
            guardSteps: guardSteps,
            tokenSteps: tokenSteps,
            presignSteps: presignSteps,
            twapSteps: twapSteps,
            stopLossSteps: stopLossSteps,
            cowOrderPoster: cowOrderPoster,
            composableCow: composableCow,
            executor: executor
        });
    }

    function _create2(bytes memory initCode) internal pure returns (address) {
        return vm.computeCreate2Address(SALT, keccak256(initCode), CREATE2_DEPLOYER);
    }

    /// @dev Numbers go through `vm.toString` deliberately. `forge-std/console.sol` encodes its uint
    ///      overload with the legacy `log(string,uint)` signature, which Foundry's decoder does not
    ///      know, so `console.log("chainId ", block.chainid)` prints *nothing at all* — it silently
    ///      dropped the chain id here for as long as this script has existed. The generation is the
    ///      one line an operator most needs to see before broadcasting, so it must not depend on that.
    function _report(Deployment memory d) internal view {
        console.log("generation         ", vm.toString(GENERATION));
        console.log("chainId            ", vm.toString(block.chainid));
        console.log("shedImplementation ", d.shedImplementation);
        console.log("factory            ", d.factory);
        console.log("guardSteps         ", d.guardSteps);
        console.log("tokenSteps         ", d.tokenSteps);
        console.log("presignSteps       ", d.presignSteps);
        console.log("twapSteps          ", d.twapSteps);
        console.log("stopLossSteps      ", d.stopLossSteps);
        console.log("cowOrderPoster     ", d.cowOrderPoster);
        console.log("executor           ", d.executor);
    }

    /// @dev Written to a stable path so the SDK's constants can be generated from it rather than
    ///      transcribed by hand. A hand-copied address here is a wrong drop address everywhere.
    ///
    ///      One file per (generation, chain). Splitting on generation rather than appending to a
    ///      single per-chain file keeps the record append-only with no JSON merging — `vm.serializeX`
    ///      builds one flat object and `vm.writeJson` replaces the file wholesale, so a nested
    ///      `{"generations": {...}}` shape would mean reading the old file back and re-emitting it,
    ///      which is exactly the transcription step this indirection exists to avoid.
    function _write(Deployment memory d) internal {
        string memory obj = "deployment";
        vm.serializeUint(obj, "generation", GENERATION);
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "shedImplementation", d.shedImplementation);
        vm.serializeAddress(obj, "factory", d.factory);
        // Not cow-drop's own contracts, and not inputs to a *drop* address — but they are constructor
        // inputs to the step contracts, so they are part of what defines this generation. Recorded so
        // the SDK can build a rescue that retires live orders without an RPC round-trip.
        vm.serializeAddress(obj, "settlement", DropConfig.SETTLEMENT);
        vm.serializeAddress(obj, "composableCow", d.composableCow);
        vm.serializeAddress(obj, "guardSteps", d.guardSteps);
        vm.serializeAddress(obj, "tokenSteps", d.tokenSteps);
        vm.serializeAddress(obj, "presignSteps", d.presignSteps);
        vm.serializeAddress(obj, "twapSteps", d.twapSteps);
        vm.serializeAddress(obj, "stopLossSteps", d.stopLossSteps);
        vm.serializeAddress(obj, "cowOrderPoster", d.cowOrderPoster);
        string memory json = vm.serializeAddress(obj, "executor", d.executor);

        // `vm.writeJson` does not create parent directories, so the first run of a new generation would
        // otherwise fail — at exactly the moment the addresses have already been broadcast.
        string memory dir = string.concat("./deployments/gen", vm.toString(GENERATION));
        vm.createDir(dir, true);
        vm.writeJson(json, string.concat(dir, "/", vm.toString(block.chainid), ".json"));
    }
}
