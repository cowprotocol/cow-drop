// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {COWShed} from "cow-shed/COWShed.sol";
import {COWShedExecutorFactory} from "cow-shed/COWShedExecutorFactory.sol";
import {Call} from "cow-shed/ICOWAuthHook.sol";
import {ICOWShedSetup} from "cow-shed/ICOWShedSetup.sol";

/// @title DropExecutor
/// @notice Turns a cow-shed address into a commitment to a recipe: send funds to the address and
///         anyone can run the baked-in calls. No signature exists anywhere in the flow.
///
/// @dev ## How the authorization works
///
/// `COWShedExecutorFactory` derives a shed address from
/// `keccak256(abi.encode(owner, trustedExecutor, salt, setupTarget, keccak256(setupData)))`.
/// This contract is deployed once and used as *both* the `trustedExecutor` and the `setupTarget`
/// of every drop, with `salt` fixed at zero. That makes the derivation a pure function of
/// `(owner, setupData)` — so given a shed address and a candidate recipe, we can re-derive the
/// address and check they match. A recipe that does not reproduce the address is not that
/// address's recipe, and is rejected. The address *is* the authorization.
///
/// ## Why every entry point must re-derive
///
/// `COWShed.trustedExecuteHooks` is `onlyTrustedRole` and takes no nonce, no deadline and no
/// signature. Because this contract is the trusted executor of every drop, a `setup`
/// implementation that merely decoded `setupData` and forwarded the calls would let anyone call
/// `setup(someoneElsesDrop, ..., arbitraryCalls)` and drain every drop in the system. The
/// re-derivation in `_run` is the only thing standing between a drop and that attack, which is
/// why it guards the factory callback too rather than trusting `msg.sender == FACTORY`.
///
/// ## Recovery
///
/// The shed's admin is `owner`, so a drop whose recipe turns out to be broken or unrunnable is
/// never a loss of funds: the owner can always sweep it with an ordinary signed
/// `COWShed.executeHooks`. Passing `owner == address(0)` gives up that escape hatch in exchange
/// for a drop nobody can interfere with; that is a deliberate choice, not a default.
contract DropExecutor is ICOWShedSetup {
    /// @notice A recipe: the calls a drop runs, plus how it is allowed to run them.
    /// @dev The abi encoding of this struct is `setupData`, i.e. exactly what the drop address
    ///      commits to. Adding a field changes every address, so this struct is versioned by
    ///      the deployment of this contract.
    struct Recipe {
        /// @dev Free-form tag. Its only mechanical role is to let two otherwise-identical
        ///      recipes resolve to two different addresses.
        bytes32 label;
        /// @dev If set, the recipe runs at most once per drop. Leave false for a reusable
        ///      deposit address that processes each new arrival of funds.
        bool once;
        Call[] calls;
    }

    /// @notice The recipe presented does not reproduce this shed address.
    error NotADrop();

    /// @notice A `once` recipe has already run for this drop.
    error AlreadyConsumed();

    event DropTriggered(address indexed drop, address indexed owner, bytes32 indexed recipeHash);

    /// @notice The executor factory every drop is derived from. Pinned at deployment: a
    ///         different factory means different addresses, so it must never be mutable.
    COWShedExecutorFactory public immutable FACTORY;

    /// @notice Drops whose `once` recipe has already run.
    mapping(address => bool) public consumed;

    constructor(COWShedExecutorFactory factory) {
        FACTORY = factory;
    }

    /// @notice The drop address for a given owner and recipe.
    /// @dev Deliberately delegates to the factory rather than reimplementing the CREATE2
    ///      derivation, so this contract and the factory can never disagree. The SDK reimplements
    ///      it off-chain and the test suite asserts the two agree.
    function dropOf(address owner, bytes calldata setupData) public view returns (address) {
        return FACTORY.proxyOf(owner, address(this), bytes32(0), address(this), setupData);
    }

    /// @notice Deploy the drop and run its recipe, or re-run it if the drop already exists.
    /// @dev Idempotent and permissionless — the recipe is fixed by the address, so it does not
    ///      matter who calls this. Safe to run as a discardable solver pre-interaction.
    /// @return drop The drop address, deployed and triggered.
    function activate(address owner, bytes calldata setupData) external returns (address drop) {
        drop = dropOf(owner, setupData);

        if (drop.code.length == 0) {
            // The factory deploys, initializes us as the trusted executor, and calls `setup`
            // back — which is where the recipe actually runs.
            FACTORY.initializeProxyWithSetup(owner, address(this), bytes32(0), address(this), setupData);
        } else {
            // Already deployed, so the factory would skip the setup callback. Run directly:
            // this is the path for funds that arrive after the first activation.
            _run(drop, owner, setupData);
        }
    }

    /// @inheritdoc ICOWShedSetup
    /// @dev Called by the factory inside `initializeProxyWithSetup`. Not restricted to the
    ///      factory on purpose — see the contract-level note on why re-derivation, not caller
    ///      identity, is the security boundary.
    function setup(address shed, address owner, bytes calldata setupData) external override {
        _run(shed, owner, setupData);
    }

    /// @dev Verify the recipe reproduces the shed address, then execute it as the shed.
    function _run(address shed, address owner, bytes calldata setupData) internal {
        if (dropOf(owner, setupData) != shed) revert NotADrop();

        Recipe memory recipe = abi.decode(setupData, (Recipe));

        if (recipe.once) {
            if (consumed[shed]) revert AlreadyConsumed();
            // Written before the external call: a reusable recipe is replayable by design, and
            // a `once` recipe must not be re-enterable through its own calls.
            consumed[shed] = true;
        }

        COWShed(payable(shed)).trustedExecuteHooks(recipe.calls);

        emit DropTriggered(shed, owner, keccak256(setupData));
    }
}
