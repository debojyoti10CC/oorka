// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
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

/// @notice Deploy Oorka against an existing Uniswap v4 PoolManager (e.g. Unichain Sepolia).
///
/// Testnet PoolManagers (from developers.uniswap.org/docs/protocols/v4/deployments):
///   Unichain Sepolia 1301      0x00b036b58a818b1bc34d502d3fe730db729e62ac
///   Sepolia          11155111  0xE03A1074c86CFeDd5C142C4F04F1a1536e203543
///   Base Sepolia     84532     0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408
///   Arbitrum Sepolia 421614    0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317
///
/// Usage:
///   PRIVATE_KEY=0x... POOL_MANAGER=0x00b036b58a818b1bc34d502d3fe730db729e62ac \
///   forge script script/DeployTestnet.s.sol --rpc-url https://sepolia.unichain.org --broadcast
contract DeployTestnet is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    int24 constant TICK_SPACING = 60;
    int24 constant START_TICK = 80040; // ~3000 tUSD per tETH

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        IPoolManager manager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        uint64 epochSeconds = uint64(vm.envOr("EPOCH_SECONDS", uint256(1 hours)));
        address me = vm.addr(pk);

        vm.startBroadcast(pk);
        PoolSwapTest swapRouter = new PoolSwapTest(manager);
        PoolModifyLiquidityTest lpRouter = new PoolModifyLiquidityTest(manager);

        bytes32 runSalt = keccak256(abi.encode(me, block.timestamp));
        MockERC20 teth = new MockERC20{salt: runSalt}("Test Ether", "tETH", 18);
        bytes memory usdInit = abi.encodePacked(type(MockERC20).creationCode, abi.encode("Test USD", "tUSD", uint8(18)));
        bytes32 usdSalt;
        for (uint256 s;; ++s) {
            bytes32 cand = keccak256(abi.encode(runSalt, s));
            if (vm.computeCreate2Address(cand, keccak256(usdInit), CREATE2_DEPLOYER) > address(teth)) {
                usdSalt = cand;
                break;
            }
        }
        MockERC20 tusd = new MockERC20{salt: usdSalt}("Test USD", "tUSD", 18);

        OorkaHook.Config memory cfg = OorkaHook.Config({
            epochLength: epochSeconds,
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
            bytes32 cand = keccak256(abi.encode(runSalt, "hook", s));
            address predicted = vm.computeCreate2Address(cand, keccak256(hookInit), CREATE2_DEPLOYER);
            if (uint160(predicted) & Hooks.ALL_HOOK_MASK == flags && predicted.code.length == 0) {
                hookSalt = cand;
                break;
            }
        }
        OorkaHook hook = new OorkaHook{salt: hookSalt}(manager, cfg);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(teth)),
            currency1: Currency.wrap(address(tusd)),
            fee: 3000,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        manager.initialize(key, TickMath.getSqrtPriceAtTick(START_TICK));

        teth.mint(me, 1_000_000e18);
        tusd.mint(me, 3_000_000_000e18);
        teth.approve(address(lpRouter), type(uint256).max);
        tusd.approve(address(lpRouter), type(uint256).max);
        teth.approve(address(hook), type(uint256).max);
        tusd.approve(address(hook), type(uint256).max);
        teth.approve(address(swapRouter), type(uint256).max);
        tusd.approve(address(swapRouter), type(uint256).max);

        lpRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: START_TICK - 6960, tickUpper: START_TICK + 6960, liquidityDelta: 4e22, salt: 0}),
            ""
        );
        hook.register("Genesis", 74880, 83400, 500e18);
        hook.registerBenchmark("Benchmark", START_TICK - 6960, START_TICK + 4080);
        hook.deposit(50e18, 150_000e18, 0);
        vm.stopBroadcast();

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
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
        console2.log("hook", address(hook));
    }
}
