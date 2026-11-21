// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {OorkaHook} from "../src/OorkaHook.sol";

/// @notice Deploys a complete local Oorka world on anvil:
/// PoolManager, tETH/tUSD, routers, the hook at a flag-mined address, a tETH/tUSD pool at ~3000,
/// deep background liquidity, three seeded curators and a seeded vault deposit.
contract DeployLocal is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // anvil default keys
    uint256 constant PK0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // deployer / background LP
    uint256 constant PK1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; // Passive Pam
    uint256 constant PK2 = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a; // Tight Tony
    uint256 constant PK3 = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6; // Mid Mia
    uint256 constant PK4 = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a; // depositor
    uint256 constant PK9 = 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6; // market maker sim

    int24 constant TICK_SPACING = 60;

    function run() external {
        address deployer = vm.addr(PK0);
        vm.startBroadcast(PK0);

        PoolManager manager = new PoolManager(deployer);
        PoolSwapTest swapRouter = new PoolSwapTest(manager);
        PoolModifyLiquidityTest lpRouter = new PoolModifyLiquidityTest(manager);

        // tETH must sort below tUSD so prices read as "tUSD per tETH"
        MockERC20 teth = new MockERC20{salt: bytes32(0)}("Test Ether", "tETH", 18);
        bytes32 usdSalt;
        bytes memory usdInit = abi.encodePacked(type(MockERC20).creationCode, abi.encode("Test USD", "tUSD", uint8(18)));
        for (uint256 s;; ++s) {
            address predicted = vm.computeCreate2Address(bytes32(s), keccak256(usdInit), CREATE2_DEPLOYER);
            if (predicted > address(teth)) {
                usdSalt = bytes32(s);
                break;
            }
        }
        MockERC20 tusd = new MockERC20{salt: usdSalt}("Test USD", "tUSD", 18);
        require(address(teth) < address(tusd), "token order");

        // mine a hook address with the right permission bits
        OorkaHook.Config memory cfg = OorkaHook.Config({
            epochLength: 10 minutes,
            winStreak: 2,
            marginBps: 10,
            switchCostBps: 30,
            slashBps: 2000,
            maxTickDeviation: 300,
            minBond: 100e18
        });
        uint160 flags = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG);
        bytes memory hookInit = abi.encodePacked(type(OorkaHook).creationCode, abi.encode(manager, cfg));
        bytes32 hookSalt;
        for (uint256 s;; ++s) {
            address predicted = vm.computeCreate2Address(bytes32(s), keccak256(hookInit), CREATE2_DEPLOYER);
            if (uint160(predicted) & Hooks.ALL_HOOK_MASK == flags && predicted.code.length == 0) {
                hookSalt = bytes32(s);
                break;
            }
        }
        OorkaHook hook = new OorkaHook{salt: hookSalt}(manager, cfg);
        require(uint160(address(hook)) & Hooks.ALL_HOOK_MASK == flags, "hook flags");

        // pool at ~3000 tUSD per tETH
        int24 startTick = 80040; // 1.0001^80040 ~= 2994
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(teth)),
            currency1: Currency.wrap(address(tusd)),
            fee: 3000,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        manager.initialize(key, TickMath.getSqrtPriceAtTick(startTick));

        // fund everyone
        address[6] memory who = [deployer, vm.addr(PK1), vm.addr(PK2), vm.addr(PK3), vm.addr(PK4), vm.addr(PK9)];
        for (uint256 i; i < who.length; ++i) {
            teth.mint(who[i], 100_000e18);
            tusd.mint(who[i], 300_000_000e18);
        }

        // background liquidity: someone else's LP so traders have depth (roughly -50% .. +100%)
        teth.approve(address(lpRouter), type(uint256).max);
        tusd.approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: startTick - 6960, tickUpper: startTick + 6960, liquidityDelta: 4e22, salt: 0}),
            ""
        );
        vm.stopBroadcast();

        // approvals for every actor
        uint256[5] memory pks = [PK1, PK2, PK3, PK4, PK9];
        for (uint256 i; i < pks.length; ++i) {
            vm.startBroadcast(pks[i]);
            teth.approve(address(hook), type(uint256).max);
            tusd.approve(address(hook), type(uint256).max);
            teth.approve(address(swapRouter), type(uint256).max);
            tusd.approve(address(swapRouter), type(uint256).max);
            vm.stopBroadcast();
        }

        // seed curators: first one becomes the incumbent
        vm.broadcast(PK1);
        hook.register("Passive Pam", _round(startTick - 5160), _round(startTick + 3360), 500e18); // ~ -40% .. +40%
        vm.broadcast(PK2);
        hook.register("Tight Tony", _round(startTick - 300), _round(startTick + 300), 500e18); // ~ +-3%
        vm.broadcast(PK3);
        hook.register("Mid Mia", _round(startTick - 1020), _round(startTick + 960), 500e18); // ~ +-10%

        // the passive reference the vault is judged against: a wide range (~ -50% .. +50%) that never moves
        vm.broadcast(PK4);
        hook.registerBenchmark("Benchmark", _round(startTick - 6960), _round(startTick + 4080));

        // seed the vault
        vm.broadcast(PK4);
        hook.deposit(50e18, 150_000e18, 0);

        string memory obj = "d";
        vm.serializeAddress(obj, "poolManager", address(manager));
        vm.serializeAddress(obj, "swapRouter", address(swapRouter));
        vm.serializeAddress(obj, "lpRouter", address(lpRouter));
        vm.serializeAddress(obj, "hook", address(hook));
        vm.serializeAddress(obj, "token0", address(teth));
        vm.serializeAddress(obj, "token1", address(tusd));
        vm.serializeUint(obj, "fee", 3000);
        vm.serializeInt(obj, "tickSpacing", TICK_SPACING);
        string memory json = vm.serializeUint(obj, "chainId", block.chainid);
        vm.writeJson(json, "./deployments/local.json");

        console2.log("hook", address(hook));
        console2.log("tETH", address(teth));
        console2.log("tUSD", address(tusd));
    }

    function _round(int24 t) internal pure returns (int24) {
        return (t / TICK_SPACING) * TICK_SPACING;
    }
}
