// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {OorkaHook} from "../src/OorkaHook.sol";

/// @notice Drives the hook with random sequences of trades, deposits, withdrawals, curator churn, range changes,
/// time passing and settlements. Every action is bounded to inputs a real user could send; a call that reverts is
/// simply skipped, the way a failed transaction would be.
contract OorkaHandler is Test {
    OorkaHook public hook;
    PoolSwapTest public router;
    PoolKey public key;
    MockERC20 public t0;
    MockERC20 public t1;
    address[] public actors;
    mapping(address => uint256) public curatorOf; // id + 1, 0 = none

    uint256 public settled;
    uint256 public takeovers;

    constructor(OorkaHook _hook, PoolSwapTest _router, PoolKey memory _key) {
        hook = _hook;
        router = _router;
        key = _key;
        t0 = MockERC20(Currency.unwrap(_key.currency0));
        t1 = MockERC20(Currency.unwrap(_key.currency1));
        for (uint256 i; i < 4; ++i) {
            address a = address(uint160(0xA11CE + i));
            actors.push(a);
            t0.mint(a, 10_000_000e18);
            t1.mint(a, 10_000_000e18);
            vm.startPrank(a);
            t0.approve(address(hook), type(uint256).max);
            t1.approve(address(hook), type(uint256).max);
            t0.approve(address(router), type(uint256).max);
            t1.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function trade(uint256 seed, bool zeroForOne, uint256 amount) external {
        amount = bound(amount, 1e15, 500e18);
        vm.prank(_actor(seed));
        try router.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {} catch {}
    }

    function nextBlock(uint256 secs) external {
        secs = bound(secs, 1, 900);
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + 1);
    }

    function deposit(uint256 seed, uint256 a0, uint256 a1) external {
        a0 = bound(a0, 1e16, 50_000e18);
        a1 = bound(a1, 1e16, 50_000e18);
        vm.prank(_actor(seed));
        try hook.deposit(a0, a1, 0) {} catch {}
    }

    function withdraw(uint256 seed, uint256 frac) external {
        address a = _actor(seed);
        uint256 bal = hook.balanceOf(a);
        if (bal == 0) return;
        uint256 shares = bal * bound(frac, 1, 100) / 100;
        if (shares == 0) return;
        vm.prank(a);
        try hook.withdraw(shares, 0, 0) {} catch {}
    }

    function register(uint256 seed, uint256 lo, uint256 width) external {
        address a = _actor(seed);
        if (curatorOf[a] != 0) return;
        int24 lower = int24(int256(bound(lo, 0, 200)) - 100) * 60;
        int24 upper = lower + int24(int256(bound(width, 1, 100))) * 60;
        vm.prank(a);
        try hook.register("fuzz", lower, upper, 100e18) returns (uint256 id) {
            curatorOf[a] = id + 1;
        } catch {}
    }

    function declare(uint256 seed, uint256 lo, uint256 width) external {
        address a = _actor(seed);
        if (curatorOf[a] == 0) return;
        int24 lower = int24(int256(bound(lo, 0, 200)) - 100) * 60;
        int24 upper = lower + int24(int256(bound(width, 1, 100))) * 60;
        vm.prank(a);
        try hook.declareRange(curatorOf[a] - 1, lower, upper) {} catch {}
    }

    function exitArena(uint256 seed) external {
        address a = _actor(seed);
        if (curatorOf[a] == 0) return;
        vm.prank(a);
        try hook.exit(curatorOf[a] - 1) {
            curatorOf[a] = 0;
        } catch {}
    }

    function settle() external {
        (,, uint256 end, uint256 nowTs) = hook.epochInfo();
        if (nowTs < end) vm.warp(end);
        vm.roll(block.number + 1);
        uint256 before = hook.incumbentId();
        try hook.settleEpoch() {
            settled++;
            if (hook.incumbentId() != before) takeovers++;
        } catch {}
    }
}

contract OorkaInvariantTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    bytes32 constant VAULT_SALT = bytes32(type(uint256).max);
    OorkaHook hook;
    OorkaHandler handler;

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

        handler = new OorkaHandler(hook, swapRouter, key);
        // a seat holder and a benchmark from the start, so every code path is reachable
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);
        hook.register("Seed", -3000, 3000, 100e18);
        hook.registerBenchmark("Benchmark", -6000, 6000);
        hook.deposit(1_000e18, 1_000e18, 0);

        bytes4[] memory sel = new bytes4[](9);
        sel[0] = OorkaHandler.trade.selector;
        sel[1] = OorkaHandler.trade.selector; // trades twice as likely: they move the scores
        sel[2] = OorkaHandler.nextBlock.selector;
        sel[3] = OorkaHandler.deposit.selector;
        sel[4] = OorkaHandler.withdraw.selector;
        sel[5] = OorkaHandler.register.selector;
        sel[6] = OorkaHandler.declare.selector;
        sel[7] = OorkaHandler.exitArena.selector;
        sel[8] = OorkaHandler.settle.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// The hook always holds at least what its books say it holds: idle vault balances plus every curator's bond.
    function invariant_solvent() public view {
        OorkaHook.CuratorView[] memory cs = hook.getCurators();
        uint256 bonds;
        for (uint256 i; i < cs.length; ++i) {
            bonds += cs[i].bond;
        }
        (,,, uint256 i0, uint256 i1,,) = hook.vaultState();
        assertGe(currency0.balanceOf(address(hook)), i0, "token0 covers idle");
        assertGe(currency1.balanceOf(address(hook)), i1 + bonds, "token1 covers idle + bonds");
    }

    /// The vault's booked liquidity is exactly what the PoolManager has for the vault position.
    function invariant_vaultLiquidityMatchesPoolManager() public view {
        (int24 lower, int24 upper, uint128 L,,,,) = hook.vaultState();
        (uint128 pmL,,) = manager.getPositionInfo(key.toId(), address(hook), lower, upper, VAULT_SALT);
        assertEq(pmL, L);
    }

    /// Curator churn never grows the array settleEpoch loops over beyond MAX_CURATORS plus the benchmark.
    function invariant_curatorArrayBounded() public view {
        assertLe(hook.curatorCount(), hook.MAX_CURATORS() + 1);
    }

    /// There is always exactly one seat holder, it is active, and it is never the benchmark.
    function invariant_seatHolderIsALiveCurator() public view {
        OorkaHook.CuratorView[] memory cs = hook.getCurators();
        uint256 seats;
        for (uint256 i; i < cs.length; ++i) {
            if (cs[i].incumbent) {
                seats++;
                assertTrue(cs[i].active, "seat holder is active");
                assertFalse(cs[i].benchmark, "benchmark never holds the seat");
            }
        }
        assertEq(seats, 1);
    }

    /// Every probe holds exactly the dust liquidity at its curator's declared range.
    function invariant_probesTrackDeclaredRanges() public view {
        OorkaHook.CuratorView[] memory cs = hook.getCurators();
        for (uint256 i; i < cs.length; ++i) {
            if (!cs[i].active) continue;
            (uint128 pL,,) = manager.getPositionInfo(key.toId(), address(hook), cs[i].lower, cs[i].upper, bytes32(i));
            assertEq(pL, hook.PROBE_LIQUIDITY());
        }
    }
}
