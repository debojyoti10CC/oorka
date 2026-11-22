// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IReactive} from "reactive-lib/interfaces/IReactive.sol";
import {OorkaHook} from "../src/OorkaHook.sol";
import {OorkaKeeper, IOorkaHook} from "../src/reactive/OorkaKeeper.sol";
import {OorkaReactive} from "../src/reactive/OorkaReactive.sol";

/// @notice Keeper-free epoch settlement: Reactive CRON -> OorkaReactive -> callback -> OorkaKeeper -> hook.
/// Reactive Network itself isn't available in a unit test, so the callback proxy is played by `proxy`, and the
/// RVM id is this test contract (the keeper's deployer), exactly as it would be on a real deployment.
contract OorkaReactiveTest is Test, Deployers {
    uint256 constant CRON100 = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;
    uint256 constant UNICHAIN_SEPOLIA = 1301;

    OorkaHook hook;
    OorkaKeeper keeper;
    address proxy = makeAddr("callbackProxy");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 inc;
    uint256 chal;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        address flags = address(
            uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG) ^ (0x4444 << 144)
        );
        OorkaHook.Config memory cfg = OorkaHook.Config({
            epochLength: 1 hours,
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
        address[2] memory users = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            MockERC20(Currency.unwrap(currency0)).transfer(users[i], 1_000_000e18);
            MockERC20(Currency.unwrap(currency1)).transfer(users[i], 1_000_000e18);
            vm.startPrank(users[i]);
            MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
            MockERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);
            vm.stopPrank();
        }
        vm.prank(alice);
        inc = hook.register("Wide Alice", -6000, 6000, 100e18);
        vm.prank(bob);
        chal = hook.register("Tight Bob", -240, 240, 100e18);

        keeper = new OorkaKeeper(proxy, IOorkaHook(address(hook)), false);
    }

    function _trade() internal {
        for (uint256 i; i < 20; ++i) {
            swap(key, true, -int256(50e18), ZERO_BYTES);
            swap(key, false, -int256(50e18), ZERO_BYTES);
        }
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _toEpochEnd() internal {
        (,, uint256 end,) = hook.epochInfo();
        vm.warp(end);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _poke() internal {
        vm.prank(proxy);
        keeper.poke(address(this));
    }

    // ---------------- keeper ----------------
    function test_pokeIsANoOpMidEpoch() public {
        vm.expectEmit(true, false, false, false, address(keeper));
        emit OorkaKeeper.Idle(0, 0);
        _poke();
        assertEq(hook.epoch(), 0);
    }

    function test_pokeSettlesAnEndedEpoch() public {
        _toEpochEnd();
        vm.expectEmit(true, false, false, true, address(keeper));
        emit OorkaKeeper.Settled(0);
        _poke();
        assertEq(hook.epoch(), 1);
    }

    function test_takeoverHappensWithNoHumanSettling() public {
        for (uint256 i; i < 3; ++i) {
            _trade();
            _toEpochEnd();
            uint256 g = gasleft();
            _poke();
            uint256 used = g - gasleft();
            // the takeover epoch migrates the vault; it must fit the callback gas budget with room to spare
            assertLt(used, 1_500_000, "settle uses under half the 3M callback budget");
        }
        assertEq(hook.incumbentId(), chal, "the keeper alone drove the seat change");
        assertEq(hook.vaultLower(), -240);
    }

    function test_onlyCallbackProxy() public {
        vm.expectRevert("Authorized sender only");
        keeper.poke(address(this));
    }

    function test_onlyOurReactiveContract() public {
        // a callback relayed for somebody else's reactive contract carries a different RVM id
        vm.prank(proxy);
        vm.expectRevert("Authorized RVM ID only");
        keeper.poke(makeAddr("someoneElsesRvm"));
    }

    // ---------------- reactive contract ----------------
    function _cronLog(uint256 topic) internal view returns (IReactive.LogRecord memory l) {
        l.chain_id = block.chainid;
        l._contract = address(0xfffFfF);
        l.topic_0 = topic;
        l.block_number = block.number;
    }

    function test_reactiveEmitsCallbackEveryNTicks() public {
        // no system contract at 0xfffFfF here, so this instance behaves like the ReactVM copy
        OorkaReactive rc = new OorkaReactive(CRON100, UNICHAIN_SEPOLIA, address(keeper), 2);

        vm.recordLogs();
        rc.react(_cronLog(CRON100));
        assertEq(vm.getRecordedLogs().length, 0, "tick 1 of 2: nothing yet");

        vm.expectEmit(true, true, true, true, address(rc));
        emit IReactive.Callback(
            UNICHAIN_SEPOLIA, address(keeper), rc.CALLBACK_GAS_LIMIT(), abi.encodeWithSignature("poke(address)", address(0))
        );
        rc.react(_cronLog(CRON100));
        assertEq(rc.ticks(), 2);
    }

    function test_reactivePaysTheCurrentSystemContract() public {
        OorkaReactive rc = new OorkaReactive(CRON100, UNICHAIN_SEPOLIA, address(keeper), 1);
        vm.deal(address(rc), 1 ether);
        address sys = rc.SYSTEM_CONTRACT();
        // the fee-charging system contract can collect what's owed...
        vm.prank(sys);
        rc.pay(0.01 ether);
        assertEq(sys.balance, 0.01 ether);
        // ...nobody else can
        vm.prank(makeAddr("stranger"));
        vm.expectRevert("Authorized sender only");
        rc.pay(0.01 ether);
    }

    function test_reactiveIgnoresOtherTopics() public {
        OorkaReactive rc = new OorkaReactive(CRON100, UNICHAIN_SEPOLIA, address(keeper), 1);
        vm.recordLogs();
        rc.react(_cronLog(uint256(keccak256("SomethingElse()"))));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0);
        assertEq(rc.ticks(), 0);
    }
}
