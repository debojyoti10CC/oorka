// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/libraries/SqrtPriceMath.sol";
import {FixedPoint128} from "v4-core/libraries/FixedPoint128.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// @title OorkaHook
/// @notice A curated LP vault for one Uniswap v4 pool where the curator seat is contested on-chain.
///
/// Anyone can challenge the current curator by posting a bond and declaring the range they would run.
/// The hook places a dust-sized "probe" position at every declared range. The probe makes the PoolManager
/// track fee growth for those exact ticks, so the hook can compute what a range *would have* earned per unit
/// of liquidity using real swap data, with no capital at risk. Each curator gets a virtual portfolio
/// (paper NAV) marked to a manipulation-resistant reference price. A challenger that beats the incumbent by a
/// margin for `winStreak` consecutive epochs takes over, and the vault's real liquidity migrates to their range.
contract OorkaHook is IHooks, IUnlockCallback, ERC20 {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // ------------------------------------------------------------------
    // Errors / events
    // ------------------------------------------------------------------
    error NotPoolManager();
    error HookNotImplemented();
    error PoolAlreadySet();
    error PoolNotSet();
    error WrongHook();
    error BadRange();
    error BondTooSmall();
    error TooManyCurators();
    error NotCuratorOwner();
    error NotIncumbent();
    error IsIncumbent();
    error NoIncumbent();
    error EpochNotOver();
    error PriceDeviation();
    error ZeroAmount();
    error Slippage();
    error Inactive();
    error DonationsDisabled();
    error BenchmarkExists();

    event CuratorRegistered(uint256 indexed id, address indexed owner, string name, int24 lower, int24 upper);
    event RangeDeclared(uint256 indexed id, int24 lower, int24 upper, uint256 navAfterCost);
    event CuratorExited(uint256 indexed id);
    event EpochSettled(uint256 indexed epoch, uint256 incumbentId, uint256 incumbentGrowthWad);
    event Scored(uint256 indexed epoch, uint256 indexed id, uint256 growthWad, uint32 streak);
    event Takeover(uint256 indexed epoch, uint256 indexed oldId, uint256 indexed newId, uint256 slashed);
    event VaultMoved(int24 lower, int24 upper, uint128 liquidity);
    event Deposited(address indexed user, uint256 amount0, uint256 amount1, uint256 shares);
    event Withdrawn(address indexed user, uint256 amount0, uint256 amount1, uint256 shares);
    event BenchmarkRegistered(uint256 indexed id, string name, int24 lower, int24 upper);
    /// @notice Per-epoch report card: did the contested vault beat a passive range that never moves?
    event BenchmarkScored(uint256 indexed epoch, uint256 vaultGrowthWad, uint256 benchmarkGrowthWad);

    // ------------------------------------------------------------------
    // Config
    // ------------------------------------------------------------------
    struct Config {
        uint64 epochLength; // seconds
        uint32 winStreak; // consecutive winning epochs needed to take over
        uint32 marginBps; // challenger must beat incumbent growth by this many bps
        uint32 switchCostBps; // paper cost charged on every range change (fees + slippage proxy)
        uint32 slashBps; // share of a dethroned incumbent's bond paid to vault depositors
        int24 maxTickDeviation; // max |spot tick - reference tick| allowed for vault-moving actions
        uint256 minBond; // in token1
    }

    struct Curator {
        address owner;
        string name;
        int24 lower;
        int24 upper;
        uint128 vL; // virtual liquidity of the paper portfolio
        uint256 fg0Last; // feeGrowthInside snapshots (X128)
        uint256 fg1Last;
        uint256 cash0; // paper fees collected but not reinvested
        uint256 cash1;
        uint256 epochStartNav;
        uint256 bond;
        uint32 streak;
        uint32 joinedEpoch;
        bool active;
        bool benchmark; // passive reference portfolio: never competes, never moves
    }

    uint256 public constant INITIAL_NAV = 1_000e18; // every paper portfolio starts with 1,000 token1 of notional
    uint128 public constant PROBE_LIQUIDITY = 1e9; // dust liquidity used to keep ticks initialized
    uint256 public constant MAX_CURATORS = 8;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant MIN_SHARES = 1e3;

    IPoolManager public immutable poolManager;
    Config public config;

    PoolKey public poolKey;
    PoolId public poolId;
    bool public poolSet;

    Curator[] internal curators;
    uint256 public incumbentId;
    bool public hasIncumbent;

    uint256 public epoch;
    uint256 public epochStart;

    // benchmark: a fixed paper portfolio the vault is judged against
    bool public hasBenchmark;
    uint256 public benchmarkId;
    uint256 public vaultStartSharePrice; // share price (WAD, token1 per share) at the first deposit
    uint256 public vaultEpochStartSharePrice; // share price at the start of the current epoch

    // reference price: the pool price at the start of the current block (set on first swap of a block)
    uint160 internal refSqrtPriceStored;
    uint256 internal refBlock;

    // real vault position (salt = VAULT_SALT)
    bytes32 internal constant VAULT_SALT = bytes32(uint256(type(uint256).max));
    int24 public vaultLower;
    int24 public vaultUpper;
    uint128 public vaultLiquidity;
    uint256 public idle0;
    uint256 public idle1;

    // ------------------------------------------------------------------
    // Unlock callback actions
    // ------------------------------------------------------------------
    enum Action {
        MOVE_PROBE,
        MOVE_VAULT,
        DEPOSIT,
        WITHDRAW
    }

    constructor(IPoolManager _poolManager, Config memory _config) ERC20("Oorka Vault Share", "oLP", 18) {
        poolManager = _poolManager;
        config = _config;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: true,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: true, // donations would inflate feeGrowthInside, which is the score
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    modifier poolReady() {
        if (!poolSet) revert PoolNotSet();
        _;
    }

    // ------------------------------------------------------------------
    // Hook callbacks
    // ------------------------------------------------------------------
    function afterInitialize(address, PoolKey calldata key, uint160, int24)
        external
        onlyPoolManager
        returns (bytes4)
    {
        if (poolSet) revert PoolAlreadySet();
        if (address(key.hooks) != address(this)) revert WrongHook();
        poolKey = key;
        poolId = key.toId();
        poolSet = true;
        epochStart = block.timestamp;
        return IHooks.afterInitialize.selector;
    }

    /// @dev Snapshot the block-open price before the first swap of each block. Paper NAVs, vault share pricing and
    /// the deviation guard all use this price, so an in-block price push (flash swap, sandwich) cannot be used to
    /// inflate a curator's score or to deposit/withdraw at a manipulated price.
    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (refBlock != block.number) {
            (uint160 sp,,,) = poolManager.getSlot0(poolId);
            refSqrtPriceStored = sp;
            refBlock = block.number;
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    // ------------------------------------------------------------------
    // Curator actions
    // ------------------------------------------------------------------

    /// @notice Enter the arena. The first curator ever registered becomes the incumbent.
    /// @dev Caller must approve this contract for `bond` token1 plus dust amounts of both tokens for the probe.
    function register(string calldata name, int24 lower, int24 upper, uint256 bond)
        external
        poolReady
        returns (uint256 id)
    {
        _checkRange(lower, upper);
        if (bond < config.minBond) revert BondTooSmall();
        if (_activeCount() >= MAX_CURATORS) revert TooManyCurators();

        IERC20Minimal(Currency.unwrap(poolKey.currency1)).transferFrom(msg.sender, address(this), bond);

        id = curators.length;
        curators.push();
        Curator storage c = curators[id];
        c.owner = msg.sender;
        c.name = name;
        c.bond = bond;
        c.active = true;
        c.joinedEpoch = uint32(epoch);

        _moveProbe(id, 0, 0, lower, upper, msg.sender);
        uint160 p = refSqrtPrice();
        c.lower = lower;
        c.upper = upper;
        c.vL = _liquidityForValue(INITIAL_NAV, lower, upper, p);
        (c.fg0Last, c.fg1Last) = poolManager.getFeeGrowthInside(poolId, lower, upper);
        c.epochStartNav = INITIAL_NAV;

        emit CuratorRegistered(id, msg.sender, name, lower, upper);

        if (!hasIncumbent) {
            hasIncumbent = true;
            incumbentId = id;
            _moveVault(lower, upper);
        }
    }

    /// @notice Change your declared range. For the incumbent this also moves the vault's real liquidity.
    function declareRange(uint256 id, int24 lower, int24 upper) external poolReady {
        Curator storage c = curators[id];
        if (!c.active) revert Inactive();
        if (c.owner != msg.sender) revert NotCuratorOwner();
        _checkRange(lower, upper);

        bool isInc = hasIncumbent && id == incumbentId;
        if (isInc) _checkDeviation();

        uint160 p = refSqrtPrice();
        uint256 nav = _navOf(c, p);
        uint256 navAfter = nav * (10_000 - config.switchCostBps) / 10_000;

        _moveProbe(id, c.lower, c.upper, lower, upper, msg.sender);
        c.lower = lower;
        c.upper = upper;
        c.cash0 = 0;
        c.cash1 = 0;
        c.vL = _liquidityForValue(navAfter, lower, upper, p);
        (c.fg0Last, c.fg1Last) = poolManager.getFeeGrowthInside(poolId, lower, upper);

        // keep the epoch growth comparable: the switch cost is the only thing that should hit the score
        emit RangeDeclared(id, lower, upper, navAfter);

        if (isInc) _moveVault(lower, upper);
    }

    /// @notice Leave the arena and reclaim your bond. The incumbent cannot exit.
    function exit(uint256 id) external poolReady {
        Curator storage c = curators[id];
        if (!c.active) revert Inactive();
        if (c.owner != msg.sender) revert NotCuratorOwner();
        if (hasIncumbent && id == incumbentId) revert IsIncumbent();
        _moveProbe(id, c.lower, c.upper, 0, 0, msg.sender);
        c.active = false;
        uint256 b = c.bond;
        c.bond = 0;
        IERC20Minimal(Currency.unwrap(poolKey.currency1)).transfer(msg.sender, b);
        emit CuratorExited(id);
    }

    /// @notice Register the pool's benchmark: a passive paper portfolio at a fixed range that never competes,
    /// never moves and can't be exited. Each epoch the vault's real return is reported against it, so depositors
    /// can see whether the contested seat is worth more than "just sit in a wide range". One per hook.
    /// @dev No bond. The caller pays the dust for the probe position (approve both tokens to this contract).
    function registerBenchmark(string calldata name, int24 lower, int24 upper) external poolReady returns (uint256 id) {
        if (hasBenchmark) revert BenchmarkExists();
        _checkRange(lower, upper);

        id = curators.length;
        curators.push();
        Curator storage c = curators[id];
        c.owner = address(0); // nobody can move or exit it
        c.name = name;
        c.active = true;
        c.benchmark = true;
        c.joinedEpoch = uint32(epoch);

        _moveProbe(id, 0, 0, lower, upper, msg.sender);
        uint160 p = refSqrtPrice();
        c.lower = lower;
        c.upper = upper;
        c.vL = _liquidityForValue(INITIAL_NAV, lower, upper, p);
        (c.fg0Last, c.fg1Last) = poolManager.getFeeGrowthInside(poolId, lower, upper);
        c.epochStartNav = INITIAL_NAV;

        hasBenchmark = true;
        benchmarkId = id;
        emit BenchmarkRegistered(id, name, lower, upper);
    }

    /// @notice Close the epoch: score every curator against the incumbent and hand over the vault if a challenger
    /// has won enough epochs in a row. Permissionless.
    function settleEpoch() external poolReady {
        if (!hasIncumbent) revert NoIncumbent();
        if (block.timestamp < epochStart + config.epochLength) revert EpochNotOver();

        uint160 p = refSqrtPrice();
        uint256 n = curators.length;
        uint256[] memory growth = new uint256[](n);

        for (uint256 i; i < n; ++i) {
            Curator storage c = curators[i];
            if (!c.active) continue;
            _mark(c);
            uint256 nav = _navOf(c, p);
            growth[i] = c.epochStartNav == 0 ? WAD : nav * WAD / c.epochStartNav;
        }

        // the vault's real return this epoch, measured before any takeover reshuffles it
        if (hasBenchmark) {
            uint256 vsp = _sharePrice(p);
            uint256 vGrowth = vaultEpochStartSharePrice == 0 ? WAD : vsp * WAD / vaultEpochStartSharePrice;
            emit BenchmarkScored(epoch, vGrowth, growth[benchmarkId]);
        }

        uint256 incId = incumbentId;
        uint256 gInc = growth[incId];
        uint256 bar = gInc + (gInc * config.marginBps) / 10_000;

        uint256 bestId = type(uint256).max;
        uint256 bestGrowth;
        for (uint256 i; i < n; ++i) {
            Curator storage c = curators[i];
            if (!c.active || i == incId || c.benchmark) continue;
            // must have been present for the whole epoch to be eligible
            if (c.joinedEpoch < epoch && growth[i] > bar) {
                c.streak += 1;
            } else {
                c.streak = 0;
            }
            emit Scored(epoch, i, growth[i], c.streak);
            if (c.streak >= config.winStreak && growth[i] > bestGrowth) {
                bestGrowth = growth[i];
                bestId = i;
            }
        }
        emit Scored(epoch, incId, gInc, 0);
        emit EpochSettled(epoch, incId, gInc);

        if (bestId != type(uint256).max) {
            Curator storage old = curators[incId];
            uint256 slash = old.bond * config.slashBps / 10_000;
            old.bond -= slash;
            idle1 += slash; // paid to depositors
            // wins only count against the seat holder they were earned against: everyone starts over
            for (uint256 i; i < n; ++i) {
                curators[i].streak = 0;
            }
            incumbentId = bestId;
            emit Takeover(epoch, incId, bestId, slash);
            Curator storage nw = curators[bestId];
            _moveVault(nw.lower, nw.upper);
        }

        // roll the epoch: every portfolio's current NAV becomes the new baseline
        for (uint256 i; i < n; ++i) {
            Curator storage c = curators[i];
            if (!c.active) continue;
            c.epochStartNav = _navOf(c, p);
        }
        if (totalSupply > 0) vaultEpochStartSharePrice = _sharePrice(p);
        epoch += 1;
        epochStart = block.timestamp;
    }

    /// @notice Collect vault fees and reinvest idle balances at the current vault range. Permissionless.
    function compound() external poolReady {
        if (!hasIncumbent) revert NoIncumbent();
        _checkDeviation();
        _moveVault(vaultLower, vaultUpper);
    }

    // ------------------------------------------------------------------
    // Depositor actions
    // ------------------------------------------------------------------

    /// @notice Deposit into the vault. Liquidity is added at the incumbent's range; unused amounts stay with you.
    function deposit(uint256 amount0Max, uint256 amount1Max, uint256 minShares)
        external
        poolReady
        returns (uint256 shares)
    {
        if (!hasIncumbent) revert NoIncumbent();
        if (amount0Max == 0 && amount1Max == 0) revert ZeroAmount();
        _checkDeviation();
        shares = abi.decode(
            poolManager.unlock(abi.encode(Action.DEPOSIT, abi.encode(msg.sender, amount0Max, amount1Max))), (uint256)
        );
        if (shares < minShares) revert Slippage();
    }

    function withdraw(uint256 shares, uint256 min0, uint256 min1) external poolReady returns (uint256 a0, uint256 a1) {
        if (shares == 0) revert ZeroAmount();
        _checkDeviation();
        (a0, a1) = abi.decode(
            poolManager.unlock(abi.encode(Action.WITHDRAW, abi.encode(msg.sender, shares))), (uint256, uint256)
        );
        if (a0 < min0 || a1 < min1) revert Slippage();
    }

    // ------------------------------------------------------------------
    // Unlock callback
    // ------------------------------------------------------------------
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (Action action, bytes memory inner) = abi.decode(data, (Action, bytes));

        if (action == Action.MOVE_PROBE) {
            (uint256 id, int24 oldL, int24 oldU, int24 newL, int24 newU, address who) =
                abi.decode(inner, (uint256, int24, int24, int24, int24, address));
            bytes32 salt = bytes32(id);
            if (oldL != oldU) {
                BalanceDelta d = _modify(oldL, oldU, -int256(uint256(PROBE_LIQUIDITY)), salt);
                _resolve(d, who);
            }
            if (newL != newU) {
                BalanceDelta d = _modify(newL, newU, int256(uint256(PROBE_LIQUIDITY)), salt);
                _resolve(d, who);
            }
            return "";
        }

        if (action == Action.MOVE_VAULT) {
            (int24 newL, int24 newU) = abi.decode(inner, (int24, int24));
            if (vaultLiquidity > 0) {
                BalanceDelta d = _modify(vaultLower, vaultUpper, -int256(uint256(vaultLiquidity)), VAULT_SALT);
                _creditIdle(d);
                vaultLiquidity = 0;
            }
            (uint160 sp,,,) = poolManager.getSlot0(poolId);
            uint128 L = LiquidityAmounts.getLiquidityForAmounts(
                sp, TickMath.getSqrtPriceAtTick(newL), TickMath.getSqrtPriceAtTick(newU), idle0, idle1
            );
            if (L > 0) {
                BalanceDelta d = _modify(newL, newU, int256(uint256(L)), VAULT_SALT);
                _payFromIdle(d);
            }
            vaultLower = newL;
            vaultUpper = newU;
            vaultLiquidity = L;
            emit VaultMoved(newL, newU, L);
            return "";
        }

        if (action == Action.DEPOSIT) {
            (address user, uint256 m0, uint256 m1) = abi.decode(inner, (address, uint256, uint256));
            _pokeVault();
            uint160 p = refSqrtPrice();
            uint256 navBefore = _vaultNav(p);

            (uint160 sp,,,) = poolManager.getSlot0(poolId);
            uint128 L = LiquidityAmounts.getLiquidityForAmounts(
                sp, TickMath.getSqrtPriceAtTick(vaultLower), TickMath.getSqrtPriceAtTick(vaultUpper), m0, m1
            );
            if (L == 0) revert ZeroAmount();
            BalanceDelta d = _modify(vaultLower, vaultUpper, int256(uint256(L)), VAULT_SALT);
            uint256 paid0 = uint256(int256(-d.amount0()));
            uint256 paid1 = uint256(int256(-d.amount1()));
            _resolve(d, user);
            vaultLiquidity += L;

            uint256 value = _value(paid0, paid1, p);
            uint256 supply = totalSupply;
            uint256 shares;
            if (supply == 0) {
                shares = value - MIN_SHARES;
                _mint(address(0xdead), MIN_SHARES);
            } else {
                shares = navBefore == 0 ? value : FullMath.mulDiv(value, supply, navBefore);
            }
            _mint(user, shares);
            if (vaultStartSharePrice == 0) {
                uint256 sp0 = _sharePrice(p);
                vaultStartSharePrice = sp0;
                vaultEpochStartSharePrice = sp0;
            }
            emit Deposited(user, paid0, paid1, shares);
            return abi.encode(shares);
        }

        if (action == Action.WITHDRAW) {
            (address user, uint256 shares) = abi.decode(inner, (address, uint256));
            _pokeVault();
            uint256 supply = totalSupply;
            _burn(user, shares);

            // idle slice: held by this contract
            uint256 i0 = FullMath.mulDiv(idle0, shares, supply);
            uint256 i1 = FullMath.mulDiv(idle1, shares, supply);
            idle0 -= i0;
            idle1 -= i1;
            if (i0 > 0) IERC20Minimal(Currency.unwrap(poolKey.currency0)).transfer(user, i0);
            if (i1 > 0) IERC20Minimal(Currency.unwrap(poolKey.currency1)).transfer(user, i1);

            // liquidity slice: removed from the pool and sent straight to the user
            uint256 out0 = i0;
            uint256 out1 = i1;
            uint128 Lrem = uint128(FullMath.mulDiv(vaultLiquidity, shares, supply));
            if (Lrem > 0) {
                BalanceDelta d = _modify(vaultLower, vaultUpper, -int256(uint256(Lrem)), VAULT_SALT);
                vaultLiquidity -= Lrem;
                _resolve(d, user);
                out0 += uint256(int256(d.amount0()));
                out1 += uint256(int256(d.amount1()));
            }
            emit Withdrawn(user, out0, out1, shares);
            return abi.encode(out0, out1);
        }

        revert HookNotImplemented();
    }

    // ------------------------------------------------------------------
    // Views for frontends
    // ------------------------------------------------------------------
    struct CuratorView {
        uint256 id;
        address owner;
        string name;
        int24 lower;
        int24 upper;
        uint256 nav;
        uint256 epochStartNav;
        uint256 epochGrowthWad;
        uint256 bond;
        uint32 streak;
        uint32 joinedEpoch;
        bool active;
        bool incumbent;
        bool benchmark;
    }

    function curatorCount() external view returns (uint256) {
        return curators.length;
    }

    function getCurators() external view returns (CuratorView[] memory out) {
        uint256 n = curators.length;
        out = new CuratorView[](n);
        uint160 p = poolSet ? refSqrtPrice() : 0;
        for (uint256 i; i < n; ++i) {
            Curator storage c = curators[i];
            uint256 nav = c.active ? _navLive(c, p) : 0;
            out[i] = CuratorView({
                id: i,
                owner: c.owner,
                name: c.name,
                lower: c.lower,
                upper: c.upper,
                nav: nav,
                epochStartNav: c.epochStartNav,
                epochGrowthWad: c.epochStartNav == 0 ? 0 : nav * WAD / c.epochStartNav,
                bond: c.bond,
                streak: c.streak,
                joinedEpoch: c.joinedEpoch,
                active: c.active,
                incumbent: hasIncumbent && i == incumbentId,
                benchmark: c.benchmark
            });
        }
    }

    /// @notice Paper NAV of a curator right now (includes unrealized fees since last mark).
    function curatorNav(uint256 id) external view returns (uint256) {
        return _navLive(curators[id], refSqrtPrice());
    }

    /// @notice Total vault value in token1 at the reference price, including uncollected fees.
    function vaultNav() public view returns (uint256) {
        if (!poolSet) return 0;
        return _vaultNavWithFees(refSqrtPrice());
    }

    /// @notice Vault vs benchmark, both as growth multipliers (WAD, 1e18 = flat).
    /// @return vaultSinceStart share price now / share price at the first deposit
    /// @return vaultThisEpoch share price now / share price at epoch start
    /// @return benchSinceStart benchmark paper NAV now / INITIAL_NAV
    /// @return benchThisEpoch benchmark paper NAV now / its NAV at epoch start
    function benchmarkReport()
        external
        view
        returns (uint256 vaultSinceStart, uint256 vaultThisEpoch, uint256 benchSinceStart, uint256 benchThisEpoch)
    {
        if (!poolSet) return (WAD, WAD, WAD, WAD);
        uint160 p = refSqrtPrice();
        uint256 sp = _sharePrice(p);
        vaultSinceStart = vaultStartSharePrice == 0 ? WAD : sp * WAD / vaultStartSharePrice;
        vaultThisEpoch = vaultEpochStartSharePrice == 0 ? WAD : sp * WAD / vaultEpochStartSharePrice;
        if (hasBenchmark) {
            Curator storage b = curators[benchmarkId];
            uint256 nav = _navOf(b, p);
            benchSinceStart = nav * WAD / INITIAL_NAV;
            benchThisEpoch = b.epochStartNav == 0 ? WAD : nav * WAD / b.epochStartNav;
        } else {
            (benchSinceStart, benchThisEpoch) = (WAD, WAD);
        }
    }

    function vaultState()
        external
        view
        returns (int24 lower, int24 upper, uint128 liquidity, uint256 i0, uint256 i1, uint256 nav, uint256 supply)
    {
        return (vaultLower, vaultUpper, vaultLiquidity, idle0, idle1, vaultNav(), totalSupply);
    }

    function epochInfo() external view returns (uint256 current, uint256 start, uint256 end, uint256 nowTs) {
        return (epoch, epochStart, epochStart + config.epochLength, block.timestamp);
    }

    /// @notice Price used for all accounting: the pool price at the start of the current block.
    function refSqrtPrice() public view returns (uint160) {
        if (refBlock == block.number && refSqrtPriceStored != 0) return refSqrtPriceStored;
        (uint160 sp,,,) = poolManager.getSlot0(poolId);
        return sp;
    }

    // ------------------------------------------------------------------
    // Internal: paper portfolio math
    // ------------------------------------------------------------------
    function _feesSince(Curator storage c) internal view returns (uint256 f0, uint256 f1) {
        (uint256 g0, uint256 g1) = poolManager.getFeeGrowthInside(poolId, c.lower, c.upper);
        unchecked {
            f0 = FullMath.mulDiv(g0 - c.fg0Last, c.vL, FixedPoint128.Q128);
            f1 = FullMath.mulDiv(g1 - c.fg1Last, c.vL, FixedPoint128.Q128);
        }
    }

    function _mark(Curator storage c) internal {
        (uint256 f0, uint256 f1) = _feesSince(c);
        c.cash0 += f0;
        c.cash1 += f1;
        (c.fg0Last, c.fg1Last) = poolManager.getFeeGrowthInside(poolId, c.lower, c.upper);
    }

    function _navOf(Curator storage c, uint160 p) internal view returns (uint256) {
        (uint256 f0, uint256 f1) = _feesSince(c);
        (uint256 a0, uint256 a1) = _amountsForLiquidity(p, c.lower, c.upper, c.vL);
        return _value(a0 + c.cash0 + f0, a1 + c.cash1 + f1, p);
    }

    function _navLive(Curator storage c, uint160 p) internal view returns (uint256) {
        return _navOf(c, p);
    }

    function _liquidityForValue(uint256 value, int24 lower, int24 upper, uint160 p) internal pure returns (uint128) {
        (uint256 u0, uint256 u1) = _amountsForLiquidity(p, lower, upper, uint128(WAD));
        uint256 per = _value(u0, u1, p);
        if (per == 0) revert BadRange();
        uint256 L = FullMath.mulDiv(value, WAD, per);
        if (L > type(uint128).max) revert BadRange();
        return uint128(L);
    }

    function _amountsForLiquidity(uint160 p, int24 lower, int24 upper, uint128 L)
        internal
        pure
        returns (uint256 a0, uint256 a1)
    {
        uint160 sa = TickMath.getSqrtPriceAtTick(lower);
        uint160 sb = TickMath.getSqrtPriceAtTick(upper);
        if (p <= sa) {
            a0 = SqrtPriceMath.getAmount0Delta(sa, sb, L, false);
        } else if (p < sb) {
            a0 = SqrtPriceMath.getAmount0Delta(p, sb, L, false);
            a1 = SqrtPriceMath.getAmount1Delta(sa, p, L, false);
        } else {
            a1 = SqrtPriceMath.getAmount1Delta(sa, sb, L, false);
        }
    }

    /// @dev value of (a0, a1) in token1 units at sqrt price p (Q64.96)
    function _value(uint256 a0, uint256 a1, uint160 p) internal pure returns (uint256) {
        uint256 v0 = FullMath.mulDiv(FullMath.mulDiv(a0, p, 1 << 96), p, 1 << 96);
        return v0 + a1;
    }

    // ------------------------------------------------------------------
    // Internal: vault accounting
    // ------------------------------------------------------------------
    function _vaultNav(uint160 p) internal view returns (uint256) {
        (uint256 a0, uint256 a1) = _amountsForLiquidity(p, vaultLower, vaultUpper, vaultLiquidity);
        return _value(a0 + idle0, a1 + idle1, p);
    }

    function _vaultNavWithFees(uint160 p) internal view returns (uint256 nav) {
        nav = _vaultNav(p);
        if (vaultLiquidity > 0) {
            (uint256 f0, uint256 f1) = _pendingVaultFees();
            nav += _value(f0, f1, p);
        }
    }

    /// @dev token1 value of one vault share (WAD), fees included
    function _sharePrice(uint160 p) internal view returns (uint256) {
        uint256 supply = totalSupply;
        if (supply == 0) return WAD;
        return FullMath.mulDiv(_vaultNavWithFees(p), WAD, supply);
    }

    function _pendingVaultFees() internal view returns (uint256 f0, uint256 f1) {
        (uint256 g0, uint256 g1) = poolManager.getFeeGrowthInside(poolId, vaultLower, vaultUpper);
        (, uint256 last0, uint256 last1) =
            poolManager.getPositionInfo(poolId, address(this), vaultLower, vaultUpper, VAULT_SALT);
        unchecked {
            f0 = FullMath.mulDiv(g0 - last0, vaultLiquidity, FixedPoint128.Q128);
            f1 = FullMath.mulDiv(g1 - last1, vaultLiquidity, FixedPoint128.Q128);
        }
    }

    /// @dev must be called inside unlock. Collects accrued vault fees into idle.
    function _pokeVault() internal {
        if (vaultLiquidity == 0) return;
        BalanceDelta d = _modify(vaultLower, vaultUpper, 0, VAULT_SALT);
        _creditIdle(d);
    }

    // ------------------------------------------------------------------
    // Internal: PoolManager plumbing (inside unlock)
    // ------------------------------------------------------------------
    function _moveProbe(uint256 id, int24 oldL, int24 oldU, int24 newL, int24 newU, address who) internal {
        poolManager.unlock(abi.encode(Action.MOVE_PROBE, abi.encode(id, oldL, oldU, newL, newU, who)));
    }

    function _moveVault(int24 newL, int24 newU) internal {
        poolManager.unlock(abi.encode(Action.MOVE_VAULT, abi.encode(newL, newU)));
    }

    function _modify(int24 lower, int24 upper, int256 liquidityDelta, bytes32 salt) internal returns (BalanceDelta d) {
        (d,) = poolManager.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: liquidityDelta, salt: salt}),
            ""
        );
    }

    /// @dev negative delta -> `who` pays; positive delta -> `who` receives
    function _resolve(BalanceDelta d, address who) internal {
        int128 a0 = d.amount0();
        int128 a1 = d.amount1();
        if (a0 < 0) _settleFrom(poolKey.currency0, who, uint256(int256(-a0)));
        else if (a0 > 0) _take(poolKey.currency0, who, uint256(int256(a0)), false);
        if (a1 < 0) _settleFrom(poolKey.currency1, who, uint256(int256(-a1)));
        else if (a1 > 0) _take(poolKey.currency1, who, uint256(int256(a1)), false);
    }

    /// @dev positive deltas are taken into this contract and booked as idle vault balance
    function _creditIdle(BalanceDelta d) internal {
        int128 a0 = d.amount0();
        int128 a1 = d.amount1();
        if (a0 > 0) {
            _take(poolKey.currency0, address(this), uint256(int256(a0)), false);
            idle0 += uint256(int256(a0));
        }
        if (a1 > 0) {
            _take(poolKey.currency1, address(this), uint256(int256(a1)), false);
            idle1 += uint256(int256(a1));
        }
    }

    /// @dev negative deltas are paid out of idle vault balance
    function _payFromIdle(BalanceDelta d) internal {
        int128 a0 = d.amount0();
        int128 a1 = d.amount1();
        if (a0 < 0) {
            uint256 amt = uint256(int256(-a0));
            idle0 -= amt;
            _settleFrom(poolKey.currency0, address(this), amt);
        }
        if (a1 < 0) {
            uint256 amt = uint256(int256(-a1));
            idle1 -= amt;
            _settleFrom(poolKey.currency1, address(this), amt);
        }
    }

    function _settleFrom(Currency currency, address payer, uint256 amount) internal {
        poolManager.sync(currency);
        if (payer == address(this)) {
            IERC20Minimal(Currency.unwrap(currency)).transfer(address(poolManager), amount);
        } else {
            IERC20Minimal(Currency.unwrap(currency)).transferFrom(payer, address(poolManager), amount);
        }
        poolManager.settle();
    }

    function _take(Currency currency, address to, uint256 amount, bool) internal {
        poolManager.take(currency, to, amount);
    }

    // ------------------------------------------------------------------
    // Internal: guards
    // ------------------------------------------------------------------
    function _checkRange(int24 lower, int24 upper) internal view {
        int24 ts = poolKey.tickSpacing;
        if (lower >= upper || lower % ts != 0 || upper % ts != 0) revert BadRange();
        if (lower < TickMath.minUsableTick(ts) || upper > TickMath.maxUsableTick(ts)) revert BadRange();
    }

    function _checkDeviation() internal view {
        (, int24 spotTick,,) = poolManager.getSlot0(poolId);
        int24 refTick = TickMath.getTickAtSqrtPrice(refSqrtPrice());
        int24 diff = spotTick > refTick ? spotTick - refTick : refTick - spotTick;
        if (diff > config.maxTickDeviation) revert PriceDeviation();
    }

    function _activeCount() internal view returns (uint256 k) {
        for (uint256 i; i < curators.length; ++i) {
            if (curators[i].active && !curators[i].benchmark) ++k;
        }
    }

    // ------------------------------------------------------------------
    // Unused hook callbacks
    // ------------------------------------------------------------------
    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    /// @dev `donate()` adds to feeGrowthGlobal for every in-range position without a swap. Curator scores are
    /// read from feeGrowthInside, so a donation could pump a tight range's paper NAV for free. Block them.
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert DonationsDisabled();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
