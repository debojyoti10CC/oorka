// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {OorkaHook} from "../src/OorkaHook.sol";
import {OorkaKeeper, IOorkaHook} from "../src/reactive/OorkaKeeper.sol";
import {IReactiveSystem} from "../src/reactive/OorkaReactive.sol";
import {OorkaPulse} from "../src/reactive/OorkaPulse.sol";
import {MockSystem} from "./OorkaReactive.t.sol";

/// @notice Event-driven settlement: a pool Swap on Unichain -> OorkaPulse on Reactive -> callback -> OorkaKeeper
/// -> hook. The system contract is a mock etched at 0x8888…8888; logs are built by hand the way Reactive Network
/// delivers them; `proxy` plays the callback proxy.
contract OorkaPulseTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    uint256 constant ORIGIN = 1301;
    address constant SYS = 0x8888888888888888888888888888888888888888;
    uint256 constant COOLDOWN = 30;

    OorkaHook hook;
    OorkaKeeper keeper;
    OorkaPulse pulse;
    address proxy = makeAddr("callbackProxy");
    address alice = makeAddr("alice");
    bytes32 pid;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        address flags = address(
            uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG) ^ (0x4444 << 144)
        );
        OorkaHook.Config memory cfg = OorkaHook.Config({
            epochLength: 15 minutes,
            winStreak: 2,
            marginBps: 10,
            switchCostBps: 30,
            slashBps: 2000,
            maxTickDeviation: 200,
            minBond: 100e18,
            perfFeeBps: 1000
        });
        deployCodeTo("OorkaHook.sol:OorkaHook", abi.encode(manager, cfg), flags);
        hook = OorkaHook(flags);
        (key,) = initPool(currency0, currency1, IHooks(address(hook)), 3000, 60, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 1e22, salt: 0}), ""
        );
        MockERC20(Currency.unwrap(currency0)).transfer(alice, 1_000_000e18);
        MockERC20(Currency.unwrap(currency1)).transfer(alice, 1_000_000e18);
        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);
        hook.register("Wide Alice", -6000, 6000, 100e18);
        vm.stopPrank();

        vm.etch(SYS, address(new MockSystem()).code);
        pid = PoolId.unwrap(key.toId());
        (,, uint256 end,) = hook.epochInfo();
        pulse = new OorkaPulse(ORIGIN, address(manager), address(hook), pid, 15 minutes, end, COOLDOWN);
        keeper = new OorkaKeeper(proxy, address(pulse), IOorkaHook(address(hook)), true);
        pulse.setKeeper(address(keeper));
    }

    // ---------------------------------------------------------------- helpers
    function _log(address emitter, uint256 topic0, uint256 topic1) internal view returns (OorkaPulse.LogRecord memory r) {
        r.chainId = ORIGIN;
        r.contractAddress = emitter;
        r.topic0 = topic0;
        r.topic1 = topic1;
        r.blockNumber = block.number;
        r.txHash = uint256(keccak256(abi.encode(block.number, topic0)));
    }

    function _swapLog() internal view returns (OorkaPulse.LogRecord memory) {
        return _log(address(manager), pulse.SWAP_TOPIC(), uint256(pid));
    }

    function _react(OorkaPulse.LogRecord memory r) internal {
        vm.prank(SYS);
        pulse.react(r);
    }

    function _requests() internal view returns (uint256) {
        return MockSystem(payable(SYS)).requests();
    }

    function _deliverLastCallback() internal {
        IReactiveSystem.CallbackConfiguration_V_1_0 memory c = MockSystem(payable(SYS)).request(_requests() - 1);
        // Reactive replaces the first argument with the requesting reactive contract's address
        assertEq(c.payload, abi.encodeWithSignature("poke(address)", address(0)));
        vm.prank(proxy);
        keeper.poke(address(pulse));
    }

    function _toEpochEnd() internal {
        (,, uint256 end,) = hook.epochInfo();
        vm.warp(end);
        vm.roll(block.number + 1);
    }

    // ---------------------------------------------------------------- subscriptions
    function test_subscribesToSwapsAndHookEventsOnDeploy() public view {
        assertEq(MockSystem(payable(SYS)).subscriptions(), 4);
    }

    function test_reactOnlyFromSystem() public {
        OorkaPulse.LogRecord memory r = _swapLog();
        vm.expectRevert(abi.encodeWithSelector(OorkaPulse.NotAuthorized.selector, address(this)));
        pulse.react(r);
    }

    function test_keeperIsOneShot() public {
        vm.expectRevert(OorkaPulse.KeeperAlreadySet.selector);
        pulse.setKeeper(address(1));
    }

    // ---------------------------------------------------------------- epoch due
    function test_swapMidEpochDoesNothing() public {
        _react(_swapLog());
        assertEq(_requests(), 0);
    }

    function test_firstSwapAfterEpochEndRequestsACallback() public {
        _toEpochEnd();
        OorkaPulse.LogRecord memory r = _swapLog();
        vm.expectEmit(true, true, false, true, address(pulse));
        emit OorkaPulse.Triggered(OorkaPulse.Reason.EpochDue, r.blockNumber, r.txHash, 1);
        _react(r);
        assertEq(_requests(), 1);
        IReactiveSystem.CallbackConfiguration_V_1_0 memory c = MockSystem(payable(SYS)).request(0);
        assertEq(c.chainId, ORIGIN);
        assertEq(c.recipient, address(keeper));
        assertEq(c.gasLimit, 3_000_000);
    }

    function test_fullLoopSettlesInTheSameSecond() public {
        _toEpochEnd();
        uint256 t = block.timestamp;
        _react(_swapLog());
        vm.expectEmit(true, false, false, true, address(keeper));
        emit OorkaKeeper.Settled(0);
        _deliverLastCallback();
        assertEq(hook.epoch(), 1, "settled by the event loop");
        assertEq(block.timestamp, t, "no CRON wait: settled at the epoch boundary");
    }

    function test_cooldownStopsABurst() public {
        _toEpochEnd();
        for (uint256 i; i < 10; ++i) {
            _react(_swapLog());
        }
        assertEq(_requests(), 1, "ten swaps, one callback");
        vm.warp(block.timestamp + COOLDOWN);
        _react(_swapLog());
        assertEq(_requests(), 2, "retries once the cooldown has passed");
    }

    function test_epochSettledResetsTheClock() public {
        _toEpochEnd();
        _react(_log(address(hook), pulse.EPOCH_SETTLED_TOPIC(), 0));
        assertEq(pulse.epochDueAt(), block.timestamp + 15 minutes);
        _react(_swapLog());
        assertEq(_requests(), 0, "next epoch not due yet");
        vm.warp(block.timestamp + 15 minutes);
        _react(_swapLog());
        assertEq(_requests(), 1);
    }

    // ---------------------------------------------------------------- deferred vault moves
    function test_deferredMoveIsFinishedOnTheNextSwap() public {
        _react(_log(address(hook), pulse.VAULT_MOVE_DEFERRED_TOPIC(), 0));
        assertTrue(pulse.vaultMovePending());
        vm.expectEmit(true, true, false, false, address(pulse));
        emit OorkaPulse.Triggered(OorkaPulse.Reason.VaultMovePending, block.number, 0, 1);
        _react(_swapLog());
        assertEq(_requests(), 1);
        // the keeper's idle path calls compound(), which finishes the move at an honest price
        vm.expectEmit(false, false, false, false, address(keeper));
        emit OorkaKeeper.Compounded();
        _deliverLastCallback();
    }

    function test_vaultMovedClearsThePendingFlag() public {
        _react(_log(address(hook), pulse.VAULT_MOVE_DEFERRED_TOPIC(), 0));
        _react(_log(address(hook), pulse.VAULT_MOVED_TOPIC(), 0));
        assertFalse(pulse.vaultMovePending());
        _react(_swapLog());
        assertEq(_requests(), 0);
    }

    // ---------------------------------------------------------------- filters and safeguards
    function test_ignoresOtherPoolsChainsAndContracts() public {
        _toEpochEnd();
        OorkaPulse.LogRecord memory r = _swapLog();
        r.topic1 = uint256(keccak256("another pool"));
        _react(r);
        r = _swapLog();
        r.chainId = 84532;
        _react(r);
        r = _swapLog();
        r.contractAddress = makeAddr("otherManager");
        _react(r);
        r = _log(makeAddr("notTheHook"), pulse.VAULT_MOVE_DEFERRED_TOPIC(), 0);
        _react(r);
        assertEq(_requests(), 0);
        assertFalse(pulse.vaultMovePending());
    }

    function test_waitsForKeeper() public {
        (,, uint256 end,) = hook.epochInfo();
        OorkaPulse fresh = new OorkaPulse(ORIGIN, address(manager), address(hook), pid, 15 minutes, end, COOLDOWN);
        _toEpochEnd();
        OorkaPulse.LogRecord memory r = _swapLog();
        vm.prank(SYS);
        fresh.react(r);
        assertEq(_requests(), 0);
    }

    function test_pauseUnsubscribesAndResumeCoversDebt() public {
        pulse.setPaused(true);
        assertEq(MockSystem(payable(SYS)).subscriptions(), 0);
        vm.deal(address(pulse), 1 ether);
        MockSystem(payable(SYS)).setDebt(0.1 ether);
        pulse.setPaused(false);
        assertEq(MockSystem(payable(SYS)).subscriptions(), 4);
        assertEq(SYS.balance, 0.1 ether);
    }

    function test_onlyOwnerPauses() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OorkaPulse.NotAuthorized.selector, alice));
        pulse.setPaused(true);
    }

    function test_keeperRejectsAnyOtherReactiveSender() public {
        vm.prank(proxy);
        vm.expectRevert(
            abi.encodeWithSelector(OorkaKeeper.CallbackNotAuthorized.selector, address(0xBEEF), address(pulse))
        );
        keeper.poke(address(0xBEEF));
    }
}
