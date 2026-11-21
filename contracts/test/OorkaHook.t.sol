// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {OorkaHook} from "../src/OorkaHook.sol";

contract OorkaHookTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    OorkaHook hook;
    address alice = makeAddr("alice"); // incumbent: wide range
    address bob = makeAddr("bob"); // challenger: tight range
    address carol = makeAddr("carol"); // challenger: range far from price
    address dave = makeAddr("dave"); // depositor

    int24 constant WIDE_L = -6000;
    int24 constant WIDE_U = 6000;
    int24 constant TIGHT_L = -240;
    int24 constant TIGHT_U = 240;

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
            minBond: 100e18
        });
        deployCodeTo("OorkaHook.sol:OorkaHook", abi.encode(manager, cfg), flags);
        hook = OorkaHook(flags);

        (key,) = initPool(currency0, currency1, IHooks(address(hook)), 3000, 60, SQRT_PRICE_1_1);

        // deep external liquidity so the market can trade
        modifyLiquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 1e22, salt: 0}), ""
        );

        address[4] memory users = [alice, bob, carol, dave];
        for (uint256 i; i < users.length; ++i) {
            MockERC20(Currency.unwrap(currency0)).transfer(users[i], 1_000_000e18);
            MockERC20(Currency.unwrap(currency1)).transfer(users[i], 1_000_000e18);
            vm.startPrank(users[i]);
            MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
            MockERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ---------------- helpers ----------------
    function _trade(uint256 rounds, uint256 size) internal {
        for (uint256 i; i < rounds; ++i) {
            swap(key, true, -int256(size), ZERO_BYTES);
            swap(key, false, -int256(size), ZERO_BYTES);
        }
        vm.roll(block.number + 1);
    }

    function _nextEpoch() internal {
        (,, uint256 end,) = hook.epochInfo();
        vm.warp(end);
        vm.roll(block.number + 1);
        hook.settleEpoch();
    }

    function _registerBase() internal returns (uint256 inc, uint256 chal) {
        vm.prank(alice);
        inc = hook.register("Wide Alice", WIDE_L, WIDE_U, 100e18);
        vm.prank(bob);
        chal = hook.register("Tight Bob", TIGHT_L, TIGHT_U, 100e18);
    }

    // ---------------- tests ----------------
    function test_firstRegistrantIsIncumbentAndVaultFollows() public {
        (uint256 inc, uint256 chal) = _registerBase();
        assertEq(hook.incumbentId(), inc);
        assertTrue(hook.hasIncumbent());
        assertEq(hook.vaultLower(), WIDE_L);
        assertEq(hook.vaultUpper(), WIDE_U);
        assertApproxEqRel(hook.curatorNav(inc), hook.INITIAL_NAV(), 1e12, "paper portfolio starts at 1000");
        assertApproxEqRel(hook.curatorNav(chal), hook.INITIAL_NAV(), 1e12);
    }

    function test_depositWithdrawRoundTrip() public {
        _registerBase();
        uint256 b0 = currency0.balanceOf(dave);
        uint256 b1 = currency1.balanceOf(dave);
        vm.prank(dave);
        uint256 shares = hook.deposit(10_000e18, 10_000e18, 0);
        assertGt(shares, 0);
        assertGt(hook.vaultLiquidity(), 0);

        vm.prank(dave);
        hook.withdraw(shares, 0, 0);
        // within rounding dust (dead shares + v4 rounding)
        assertApproxEqAbs(currency0.balanceOf(dave), b0, 1e6);
        assertApproxEqAbs(currency1.balanceOf(dave), b1, 1e6);
    }

    function test_vaultEarnsRealFees() public {
        _registerBase();
        vm.prank(dave);
        hook.deposit(10_000e18, 10_000e18, 0);
        uint256 navBefore = hook.vaultNav();
        _trade(20, 50e18);
        assertGt(hook.vaultNav(), navBefore, "vault NAV grows from swap fees");
    }

    function test_probeMeasuresFeesWithoutCapital() public {
        (uint256 inc, uint256 chal) = _registerBase();
        _trade(30, 50e18);
        uint256 navInc = hook.curatorNav(inc);
        uint256 navChal = hook.curatorNav(chal);
        assertGt(navInc, hook.INITIAL_NAV(), "wide range earned something");
        assertGt(navChal, navInc, "tight range earns more fees per unit capital in a ranging market");
    }

    function test_challengerTakesOverAfterStreak() public {
        (uint256 inc, uint256 chal) = _registerBase();
        vm.prank(dave);
        hook.deposit(10_000e18, 10_000e18, 0);

        // epoch 0: bob joined this epoch, so he is not eligible yet
        _trade(20, 50e18);
        _nextEpoch();
        assertEq(hook.incumbentId(), inc);

        // epoch 1: first win
        _trade(20, 50e18);
        _nextEpoch();
        assertEq(hook.incumbentId(), inc, "one win is not enough");

        // epoch 2: second win -> takeover
        _trade(20, 50e18);
        _nextEpoch();
        assertEq(hook.incumbentId(), chal, "bob takes the seat");
        assertEq(hook.vaultLower(), TIGHT_L);
        assertEq(hook.vaultUpper(), TIGHT_U);
        assertGt(hook.vaultLiquidity(), 0, "vault liquidity migrated");
    }

    function test_takeoverResetsEveryStreak() public {
        _registerBase();
        vm.prank(carol);
        hook.register("Mid Carol", -1200, 1200, 100e18);
        for (uint256 i; i < 3; ++i) {
            _trade(20, 50e18);
            _nextEpoch();
        }
        OorkaHook.CuratorView[] memory cs = hook.getCurators();
        for (uint256 i; i < cs.length; ++i) {
            assertEq(cs[i].streak, 0, "streaks earned against the old seat holder are wiped");
        }
    }

    function test_dethronedIncumbentIsSlashedToDepositors() public {
        (uint256 inc,) = _registerBase();
        vm.prank(dave);
        hook.deposit(10_000e18, 10_000e18, 0);
        for (uint256 i; i < 3; ++i) {
            _trade(20, 50e18);
            _nextEpoch();
        }
        OorkaHook.CuratorView[] memory cs = hook.getCurators();
        assertEq(cs[inc].bond, 80e18, "20% of alice's bond slashed");
        assertFalse(cs[inc].incumbent);
    }

    function test_trendingMarketFavorsWideRange() public {
        (uint256 inc, uint256 chal) = _registerBase();
        // one-way flow pushes price far outside bob's tight range
        for (uint256 i; i < 10; ++i) {
            swap(key, true, -int256(400e18), ZERO_BYTES);
            vm.roll(block.number + 1);
        }
        (, int24 tick,,) = _slot0();
        assertLt(tick, TIGHT_L, "price left the tight range");
        assertGt(hook.curatorNav(inc), hook.curatorNav(chal), "wide range wins a trending market");
    }

    function _slot0() internal view returns (uint160, int24, uint24, uint24) {
        return StateLibrary.getSlot0(manager, key.toId());
    }

    function test_outOfRangeChallengerNeverWins() public {
        _registerBase();
        vm.prank(carol);
        uint256 far = hook.register("Far Carol", 6000, 9000, 100e18);
        for (uint256 i; i < 4; ++i) {
            _trade(20, 50e18);
            _nextEpoch();
        }
        OorkaHook.CuratorView[] memory cs = hook.getCurators();
        assertEq(cs[far].streak, 0);
        assertFalse(cs[far].incumbent);
    }

    function test_referencePriceIgnoresInBlockManipulation() public {
        (uint256 inc,) = _registerBase();
        vm.prank(dave);
        hook.deposit(10_000e18, 10_000e18, 0);
        vm.roll(block.number + 1);

        uint256 navBefore = hook.curatorNav(inc);
        uint256 vaultBefore = hook.vaultNav();
        // attacker pushes the price hard inside one block
        swap(key, true, -int256(5_000e18), ZERO_BYTES);
        // paper NAVs and vault NAV are still priced at block-open: only the fee bump shows up
        assertApproxEqRel(hook.curatorNav(inc), navBefore, 0.01e18);
        assertApproxEqRel(hook.vaultNav(), vaultBefore, 0.01e18);
        // and vault-moving actions are blocked while spot is far from the reference
        vm.prank(dave);
        vm.expectRevert(OorkaHook.PriceDeviation.selector);
        hook.deposit(1e18, 1e18, 0);
    }

    function test_incumbentRebalanceMovesVault() public {
        (uint256 inc,) = _registerBase();
        vm.prank(dave);
        hook.deposit(10_000e18, 10_000e18, 0);
        vm.prank(alice);
        hook.declareRange(inc, -1200, 1200);
        assertEq(hook.vaultLower(), -1200);
        assertEq(hook.vaultUpper(), 1200);
        // switching cost is charged on the paper portfolio
        assertLt(hook.curatorNav(inc), hook.INITIAL_NAV());
    }

    function test_challengerRangeChangeDoesNotTouchVault() public {
        (, uint256 chal) = _registerBase();
        vm.prank(bob);
        hook.declareRange(chal, -600, 600);
        assertEq(hook.vaultLower(), WIDE_L);
    }

    function test_exitReturnsBond() public {
        (, uint256 chal) = _registerBase();
        uint256 before = currency1.balanceOf(bob);
        vm.prank(bob);
        hook.exit(chal);
        // bond back in full; probe dust may lose a few wei to v4 rounding
        assertApproxEqAbs(currency1.balanceOf(bob), before + 100e18, 1e9);
    }

    function test_incumbentCannotExit() public {
        (uint256 inc,) = _registerBase();
        vm.prank(alice);
        vm.expectRevert(OorkaHook.IsIncumbent.selector);
        hook.exit(inc);
    }

    function test_cannotSettleEarly() public {
        _registerBase();
        vm.expectRevert(OorkaHook.EpochNotOver.selector);
        hook.settleEpoch();
    }

    function test_onlyOwnerDeclares() public {
        (, uint256 chal) = _registerBase();
        vm.prank(carol);
        vm.expectRevert(OorkaHook.NotCuratorOwner.selector);
        hook.declareRange(chal, -600, 600);
    }

    function test_bondTooSmall() public {
        vm.prank(alice);
        vm.expectRevert(OorkaHook.BondTooSmall.selector);
        hook.register("x", WIDE_L, WIDE_U, 1e18);
    }

    // ---------------- donations ----------------
    function test_donationsAreBlocked() public {
        _registerBase();
        // a donation would raise feeGrowthInside for every in-range probe without a single swap
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeDonate.selector,
                abi.encodeWithSelector(OorkaHook.DonationsDisabled.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        donateRouter.donate(key, 100e18, 100e18, ZERO_BYTES);
    }

    // ---------------- benchmark ----------------
    function _registerBenchmark() internal returns (uint256 id) {
        vm.prank(dave);
        id = hook.registerBenchmark("Benchmark", WIDE_L, WIDE_U);
    }

    function test_benchmarkStartsFlatAndIsImmovable() public {
        _registerBase();
        uint256 b = _registerBenchmark();
        assertTrue(hook.hasBenchmark());
        assertEq(hook.benchmarkId(), b);
        assertApproxEqRel(hook.curatorNav(b), hook.INITIAL_NAV(), 1e12);

        // nobody owns it: it can't be moved or exited
        vm.prank(dave);
        vm.expectRevert(OorkaHook.NotCuratorOwner.selector);
        hook.declareRange(b, -600, 600);
        vm.prank(dave);
        vm.expectRevert(OorkaHook.NotCuratorOwner.selector);
        hook.exit(b);
    }

    function test_onlyOneBenchmark() public {
        _registerBase();
        _registerBenchmark();
        vm.prank(carol);
        vm.expectRevert(OorkaHook.BenchmarkExists.selector);
        hook.registerBenchmark("Another", -1200, 1200);
    }

    function test_benchmarkNeverTakesTheSeat() public {
        // benchmark sits on a tight range, so it would out-earn the wide incumbent if it were allowed to compete
        vm.prank(alice);
        uint256 inc = hook.register("Wide Alice", WIDE_L, WIDE_U, 100e18);
        vm.prank(dave);
        uint256 b = hook.registerBenchmark("Tight benchmark", TIGHT_L, TIGHT_U);
        for (uint256 i; i < 4; ++i) {
            _trade(20, 50e18);
            _nextEpoch();
        }
        assertEq(hook.incumbentId(), inc, "benchmark is not a challenger");
        OorkaHook.CuratorView[] memory cs = hook.getCurators();
        assertTrue(cs[b].benchmark);
        assertEq(cs[b].streak, 0);
        assertGt(cs[b].nav, cs[inc].nav, "it did earn more, it just can't win");
    }

    function test_benchmarkReportTracksVaultAndBenchmark() public {
        _registerBase();
        _registerBenchmark();
        vm.prank(dave);
        hook.deposit(10_000e18, 10_000e18, 0);

        (uint256 v0,, uint256 b0,) = hook.benchmarkReport();
        assertApproxEqRel(v0, 1e18, 1e12, "vault starts flat");
        assertApproxEqRel(b0, 1e18, 1e12, "benchmark starts flat");

        _trade(20, 50e18);
        (uint256 vs, uint256 ve, uint256 bs, uint256 be) = hook.benchmarkReport();
        assertGt(vs, 1e18, "vault earned fees");
        assertGt(bs, 1e18, "benchmark earned fees");
        assertEq(vs, ve, "first epoch: since-start equals this-epoch");
        assertEq(bs, be);

        // vault and benchmark are on the same wide range here, so they should track each other closely
        assertApproxEqRel(vs, bs, 0.002e18);

        _nextEpoch();
        (, uint256 veAfter,, uint256 beAfter) = hook.benchmarkReport();
        assertApproxEqRel(veAfter, 1e18, 1e12, "epoch baseline rolled for the vault");
        assertApproxEqRel(beAfter, 1e18, 1e12, "and for the benchmark");
    }

    function test_benchmarkDoesNotUseACuratorSlot() public {
        _registerBenchmark();
        // 8 real curators still fit alongside the benchmark
        for (uint256 i; i < 8; ++i) {
            address u = address(uint160(0x1000 + i));
            MockERC20(Currency.unwrap(currency0)).transfer(u, 10e18);
            MockERC20(Currency.unwrap(currency1)).transfer(u, 1_000e18);
            vm.startPrank(u);
            MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
            MockERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);
            hook.register("c", WIDE_L, WIDE_U, 100e18);
            vm.stopPrank();
        }
        assertEq(hook.curatorCount(), 9);
    }

    function test_badRangeReverts() public {
        vm.prank(alice);
        vm.expectRevert(OorkaHook.BadRange.selector);
        hook.register("x", 10, 600, 100e18); // not a multiple of tickSpacing
    }
}
