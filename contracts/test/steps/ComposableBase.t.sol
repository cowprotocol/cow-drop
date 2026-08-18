// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {IComposableCowLike} from "src/interfaces/IDropExternal.sol";
import {ComposableBase} from "src/lib/ComposableBase.sol";

import {StepsBase} from "./StepsBase.sol";

/// @dev A minimal second handler, existing only to exercise the half of `ComposableBase` that `TwapSteps`
///      does not reach. Not deployed by the deploy script and not in the SDK: a handler with no cabinet
///      to seed is the shape `StopLoss` would take, and the branch that serves it should not ship
///      unexercised — extracting it later would change `ComposableBase`, and therefore every derived
///      contract's address.
contract CabinetlessSteps is ComposableBase {
    constructor(address vaultRelayer, IComposableCowLike composableCow) ComposableBase(vaultRelayer, composableCow) {}

    /// @dev Sells the whole balance (`divisor == 1`) and registers with no value factory.
    function registerWholeBalance(address sellToken, address handler, bytes32 orderSalt)
        external
        returns (bytes32 paramsHash, uint256 amount)
    {
        amount = _amountFromBalance(sellToken, 1);
        paramsHash = _register(handler, orderSalt, abi.encode(sellToken, amount), address(0));
    }
}

contract ComposableBaseTest is StepsBase {
    CabinetlessSteps internal cabinetless;

    function setUp() public override {
        super.setUp();
        cabinetless = new CabinetlessSteps(VAULT_RELAYER, IComposableCowLike(address(composableCow)));
    }

    /// @dev `divisor == 1` means "sell the whole balance", the shape any single-shot handler wants.
    function test_amountFromBalance_takesTheWholeBalanceWhenTheDivisorIsOne() external {
        bytes memory recipe = _recipe(
            "whole",
            address(cabinetless),
            abi.encodeCall(CabinetlessSteps.registerWholeBalance, (address(sellToken), TWAP_HANDLER, bytes32(0)))
        );
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 777e18);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertEq(composableCow.createCount(), 1, "order not registered");
        assertEq(sellToken.allowance(drop, VAULT_RELAYER), type(uint256).max, "relayer not approved");
    }

    /// @dev A zero value factory must route to `create`, not `createWithContext`. Seeding a cabinet a
    ///      handler never reads would leave an entry nothing consults, and — more to the point — the
    ///      real `createWithContext` calls the factory, so passing `address(0)` there would revert.
    function test_register_withoutAValueFactoryUsesPlainCreate() external {
        bytes memory recipe = _recipe(
            "no-cabinet",
            address(cabinetless),
            abi.encodeCall(CabinetlessSteps.registerWholeBalance, (address(sellToken), TWAP_HANDLER, bytes32(0)))
        );
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 10e18);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertEq(composableCow.createCount(), 1, "order not registered");
        // The mock records these only in `createWithContext`, so untouched values prove the other path.
        assertEq(composableCow.lastValueFactory(), address(0), "createWithContext was used");
        assertTrue(composableCow.lastDispatch(), "dispatch must be true so the watch tower sees it");
    }

    /// @dev And the TWAP step still takes the context path, so the two branches are genuinely distinct.
    function test_register_withAValueFactoryUsesCreateWithContext() external {
        bytes memory recipe = _twapRecipe(4, 1 hours);
        address drop = executor.dropOf(owner, recipe);
        sellToken.mint(drop, 400e18);

        vm.prank(keeper);
        executor.activate(owner, recipe);

        assertEq(composableCow.lastValueFactory(), TIMESTAMP_FACTORY, "start time not seeded from the factory");
    }
}
