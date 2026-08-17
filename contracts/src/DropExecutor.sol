// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {COWShed} from "cow-shed/COWShed.sol";
import {COWShedExecutorFactory} from "cow-shed/COWShedExecutorFactory.sol";
import {IComposableCow} from "cow-shed/IComposableCow.sol";
import {IERC1271} from "cow-shed/IERC1271.sol";
import {Call} from "cow-shed/ICOWAuthHook.sol";
import {ICOWShedSetup} from "cow-shed/ICOWShedSetup.sol";
import {LibCowOrder} from "cow-shed/LibCowOrder.sol";

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
contract DropExecutor is ICOWShedSetup, IERC1271 {
    /// @notice A recipe: the calls a drop runs, plus how it is allowed to run them.
    /// @dev The abi encoding of this struct is `setupData`, i.e. exactly what the drop address
    ///      commits to. Adding a field changes every address, so this struct is versioned by
    ///      the deployment of this contract.
    struct Recipe {
        /// @dev Free-form human tag, e.g. "payroll march". Part of the commitment like everything
        ///      else, so changing it changes the address.
        bytes32 label;
        /// @dev The factory's user salt, carried here so it can be recovered on-chain — see
        ///      `_saltOf`. Zero is the ordinary case; set it to get a second drop from an
        ///      otherwise identical recipe, or to grind for a vanity address without having to
        ///      put junk in `label`.
        bytes32 salt;
        /// @dev If set, the recipe runs at most once per drop. Leave false for a reusable
        ///      deposit address that processes each new arrival of funds.
        bool once;
        Call[] calls;
    }

    /// @notice The recipe presented does not reproduce this shed address.
    error NotADrop();

    /// @notice A `once` recipe has already run for this drop.
    error AlreadyConsumed();

    /// @notice `setupData` is too short to be an encoded `Recipe`.
    error MalformedRecipe();

    /// @notice The order in an EIP-1271 signature does not hash to the digest being validated.
    error InvalidHash();

    /// @notice A step delegatecalls an address with no code, which would silently do nothing.
    error NoCodeAtDelegateTarget(address target);

    event DropTriggered(address indexed drop, address indexed owner, bytes32 indexed recipeHash);

    /// @notice The executor factory every drop is derived from. Pinned at deployment: a
    ///         different factory means different addresses, so it must never be mutable.
    COWShedExecutorFactory public immutable FACTORY;

    /// @notice ComposableCoW, for the EIP-1271 forwarding below.
    IComposableCow public immutable COMPOSABLE_COW;

    /// @notice Drops whose `once` recipe has already run.
    mapping(address => bool) public consumed;

    constructor(COWShedExecutorFactory factory, IComposableCow composableCow) {
        FACTORY = factory;
        COMPOSABLE_COW = composableCow;
    }

    /// @inheritdoc IERC1271
    ///
    /// @notice Validates a drop's conditional orders, on the drop's behalf.
    ///
    /// @dev Drops are built over `COWShedWithExecutorSigner`, whose `isValidSignature` delegates to
    ///      its trusted executor — this contract. So this is what makes a drop able to own a
    ///      ComposableCoW order (a TWAP, say) at all.
    ///
    ///      `msg.sender` is the drop asking, which is exactly the owner ComposableCoW should be
    ///      queried about: it keys its authorisations by owner, so a drop can only ever vouch for
    ///      orders it registered itself. Nothing here grants this contract or anyone else authority.
    ///
    ///      The logic mirrors cow-shed's `ERC1271Forwarder`, with one unavoidable difference: that
    ///      contract passes the original caller (the settlement contract) as `sender`, while by the
    ///      time the call reaches us the drop has become `msg.sender` and the original caller is
    ///      lost. TWAP ignores `sender`, so this is fine today — but a handler or swap guard that
    ///      inspects `sender` would see the drop rather than the settlement.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        (LibCowOrder.Data memory order, IComposableCow.PayloadStruct memory payload) =
            abi.decode(signature, (LibCowOrder.Data, IComposableCow.PayloadStruct));

        bytes32 domainSeparator = COMPOSABLE_COW.domainSeparator();
        if (LibCowOrder.hash(order, domainSeparator) != hash) revert InvalidHash();

        return COMPOSABLE_COW.isValidSafeSignature(
            msg.sender, msg.sender, hash, domainSeparator, bytes32(0), abi.encode(order), abi.encode(payload)
        );
    }

    /// @notice The drop address for a given owner and recipe.
    /// @dev Deliberately delegates to the factory rather than reimplementing the CREATE2
    ///      derivation, so this contract and the factory can never disagree. The SDK reimplements
    ///      it off-chain and the test suite asserts the two agree.
    function dropOf(address owner, bytes calldata setupData) public view returns (address) {
        return FACTORY.proxyOf(owner, address(this), _saltOf(setupData), address(this), setupData);
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
            FACTORY.initializeProxyWithSetup(
                owner, address(this), _saltOf(setupData), address(this), setupData
            );
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

    /// @dev The factory's user salt, read back out of the recipe.
    ///
    ///      The factory takes an arbitrary `bytes32 salt`, but `ICOWShedSetup.setup` only receives
    ///      `(shed, owner, setupData)` — so a salt passed *only* as a factory argument could not be
    ///      recovered here, and the commitment could not be re-derived. Carrying it inside
    ///      `setupData` solves that: the salt is committed anyway, so reading it back costs nothing
    ///      and cannot be forged. A caller who deploys with a factory salt that disagrees with the
    ///      one in the recipe simply produces an address this function does not derive, and the
    ///      deployment reverts.
    ///
    ///      The alternative — stashing the salt in (transient) storage during `activate` — would
    ///      break deployment straight through the factory, which the design deliberately allows as
    ///      a discardable solver pre-interaction.
    ///
    ///      Decoded from the head of the encoding rather than by decoding the whole `Recipe`, so
    ///      that quoting an address does not pay to decode every call. `setupData` is
    ///      `abi.encode(Recipe)`: one offset word, then `label`, then `salt`.
    function _saltOf(bytes calldata setupData) internal pure returns (bytes32 salt) {
        if (setupData.length < 0x60) revert MalformedRecipe();
        (, salt) = abi.decode(setupData[0x20:0x60], (bytes32, bytes32));
    }

    /// @dev Reject a recipe that delegatecalls an address with no code.
    ///
    ///      The EVM treats a call to a codeless address as a *success* returning nothing, and cow-shed's
    ///      `executeCalls` only checks that flag. So a recipe whose primitives point at an undeployed
    ///      `DropRecipes` — a chain where it has not been deployed yet, or a stale address in a shared
    ///      recipe file — would activate cleanly and do absolutely nothing: no order placed, funds
    ///      untouched, and for a `once` recipe the single run spent. Silence is the worst possible
    ///      outcome here, so it becomes a revert, which leaves the run intact.
    ///
    ///      Only delegatecalls are checked. A plain call to a codeless address is sometimes exactly
    ///      what is meant — paying an EOA — whereas delegatecalling nothing never is.
    function _requireDelegateTargetsHaveCode(Call[] memory calls) internal view {
        for (uint256 i; i < calls.length; ++i) {
            if (calls[i].isDelegateCall && calls[i].target.code.length == 0) {
                revert NoCodeAtDelegateTarget(calls[i].target);
            }
        }
    }

    /// @dev Verify the recipe reproduces the shed address, then execute it as the shed.
    function _run(address shed, address owner, bytes calldata setupData) internal {
        if (dropOf(owner, setupData) != shed) revert NotADrop();

        Recipe memory recipe = abi.decode(setupData, (Recipe));
        _requireDelegateTargetsHaveCode(recipe.calls);

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
