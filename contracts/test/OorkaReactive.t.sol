// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {OorkaHook} from "../src/OorkaHook.sol";
import {OorkaKeeper, IOorkaHook} from "../src/reactive/OorkaKeeper.sol";
import {OorkaReactive, IReactiveSystem} from "../src/reactive/OorkaReactive.sol";

/// @notice Stand-in for Reactive Network's system contract at 0x8888…8888: accepts subscriptions, records
/// callback requests, and reports debt.
contract MockSystem {
    uint256 public subscriptions;
    uint256 public owed;
    IReactiveSystem.CallbackConfiguration_V_1_0[] internal _requests;

    function subscribe(uint256, address, uint256, uint256, uint256, uint256) external { subscriptions++; }
    function unsubscribe(uint256, address, uint256, uint256, uint256, uint256) external { subscriptions--; }
    function requestCallbackV_1_0(IReactiveSystem.CallbackConfiguration_V_1_0 memory c) external { _requests.push(c); }
    function debt(address) external view returns (uint256) { return owed; }
    function setDebt(uint256 d) external { owed = d; }
    function requests() external view returns (uint256) { return _requests.length; }
    function request(uint256 i) external view returns (IReactiveSystem.CallbackConfiguration_V_1_0 memory) { return _requests[i]; }
    receive() external payable {}
}

/// @notice Keeper-free epoch settlement: Reactive CRON -> OorkaReactive -> callback -> OorkaKeeper -> hook.
/// Reactive Network itself isn't available in a unit test, so the system contract is a mock etched at 0x8888…8888,
/// the callback proxy is played by `proxy`, and `reactiveAddr` stands for OorkaReactive's address, which the
/// network injects as the callback's first argument.
contract OorkaReactiveTest is Test, Deployers {
    uint256 constant CRON100 = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;
    uint256 constant UNICHAIN_SEPOLIA = 1301;

    OorkaHook hook;
    OorkaKeeper keeper;
    address proxy = makeAddr("callbackProxy");
    address reactiveAddr = makeAddr("oorkaReactive");
    address constant SYS = 0x8888888888888888888888888888888888888888;
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

        keeper = new OorkaKeeper(proxy, reactiveAddr, IOorkaHook(address(hook)), false);
        vm.etch(SYS, address(new MockSystem()).code);
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
        keeper.poke(reactiveAddr);
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
        vm.expectRevert(abi.encodeWithSelector(OorkaKeeper.NotAuthorized.selector, address(this)));
        keeper.poke(reactiveAddr);
    }

    function test_onlyOurReactiveContract() public {
        // a callback relayed through the real proxy for somebody else's reactive contract carries their address
        address other = makeAddr("someoneElsesReactive");
        vm.prank(proxy);
        vm.expectRevert(abi.encodeWithSelector(OorkaKeeper.CallbackNotAuthorized.selector, other, reactiveAddr));
        keeper.poke(other);
    }

    function test_keeperPaysOnlyTheProxy() public {
        vm.deal(address(keeper), 1 ether);
        vm.prank(proxy);
        keeper.pay(0.01 ether);
        assertEq(proxy.balance, 0.01 ether);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        keeper.pay(0.01 ether);
    }

    // ---------------- reactive contract ----------------
    function _cronLog(uint256 topic) internal view returns (OorkaReactive.LogRecord memory l) {
        l.chainId = block.chainid;
        l.contractAddress = address(0xfffFfF);
        l.topic0 = topic;
        l.blockNumber = block.number;
    }

    function _reactive(uint256 every) internal returns (OorkaReactive rc) {
        rc = new OorkaReactive(CRON100, UNICHAIN_SEPOLIA, every);
        rc.setKeeper(address(keeper));
    }

    function test_reactiveSubscribesToCronOnDeploy() public {
        _reactive(1);
        assertEq(MockSystem(payable(SYS)).subscriptions(), 1);
    }

    function test_reactiveRequestsCallbackEveryNTicks() public {
        OorkaReactive rc = _reactive(2);
        MockSystem sys = MockSystem(payable(SYS));

        vm.prank(SYS);
        rc.react(_cronLog(CRON100));
        assertEq(sys.requests(), 0, "tick 1 of 2: nothing yet");

        vm.expectEmit(true, true, true, true, address(rc));
        emit OorkaReactive.Poked(2);
        vm.prank(SYS);
        rc.react(_cronLog(CRON100));
        assertEq(sys.requests(), 1);
        IReactiveSystem.CallbackConfiguration_V_1_0 memory c = sys.request(0);
        assertEq(c.chainId, UNICHAIN_SEPOLIA);
        assertEq(c.recipient, address(keeper));
        assertEq(c.gasLimit, rc.CALLBACK_GAS_LIMIT());
        assertEq(c.payload, abi.encodeWithSignature("poke(address)", address(0)));
    }

    function test_reactOnlyFromSystem() public {
        OorkaReactive rc = _reactive(1);
        vm.expectRevert(abi.encodeWithSelector(OorkaReactive.NotAuthorized.selector, address(this)));
        rc.react(_cronLog(CRON100));
    }

    function test_reactiveWaitsForKeeper() public {
        OorkaReactive rc = new OorkaReactive(CRON100, UNICHAIN_SEPOLIA, 1);
        vm.prank(SYS);
        rc.react(_cronLog(CRON100));
        assertEq(MockSystem(payable(SYS)).requests(), 0);
        rc.setKeeper(address(keeper));
        vm.expectRevert(OorkaReactive.KeeperAlreadySet.selector);
        rc.setKeeper(address(1));
    }

    function test_reactivePaysTheSystemContract() public {
        OorkaReactive rc = _reactive(1);
        vm.deal(address(rc), 1 ether);
        uint256 before = SYS.balance;
        vm.prank(SYS);
        rc.pay(0.01 ether);
        assertEq(SYS.balance - before, 0.01 ether);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        rc.pay(0.01 ether);
    }

    function test_pauseUnsubscribesAndResumeCoversDebt() public {
        OorkaReactive rc = _reactive(1);
        MockSystem sys = MockSystem(payable(SYS));
        vm.deal(address(rc), 1 ether);
        rc.setPaused(true);
        assertEq(sys.subscriptions(), 0);
        sys.setDebt(0.2 ether);
        uint256 before = SYS.balance;
        rc.setPaused(false);
        assertEq(sys.subscriptions(), 1);
        assertEq(SYS.balance - before, 0.2 ether, "debt settled before resubscribing");
    }

    function test_reactiveIgnoresOtherTopics() public {
        OorkaReactive rc = _reactive(1);
        vm.prank(SYS);
        rc.react(_cronLog(uint256(keccak256("SomethingElse()"))));
        assertEq(rc.ticks(), 0);
        assertEq(MockSystem(payable(SYS)).requests(), 0);
    }
}
