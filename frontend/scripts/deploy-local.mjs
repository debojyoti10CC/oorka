// Stand up the full local Oorka world on a Hardhat (or anvil) node with Node + viem, using the contract
// artifacts Foundry built in CI. Same world as contracts/script/DeployLocal.s.sol, for machines where forge
// can't run.
//
//   cd local-chain && npm run node            # terminal 1: devnet on :8545
//   node scripts/deploy-local.mjs <artifactsDir>   # terminal 2, from frontend/
//   npx vite --mode hardhat                   # then open http://localhost:5173
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeDeployData,
  getContractAddress,
  http,
  keccak256,
  parseEther,
  concat,
  pad,
  toHex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const artifactsDir = process.argv[2];
if (!artifactsDir) throw new Error("usage: node scripts/deploy-local.mjs <artifactsDir>");
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const MNEMONIC = "test test test test test test test test test test test junk";
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
// runtime code of the deterministic deployment proxy (same on anvil, mainnet and most testnets)
const CREATE2_RUNTIME =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

const TICK_SPACING = 60;
const START_TICK = 80040;
const FEE = 3000;
const FLAGS = (1n << 12n) | (1n << 7n) | (1n << 5n); // afterInitialize | beforeSwap | beforeDonate
const ALL_HOOK_MASK = (1n << 14n) - 1n;
const MAX = 2n ** 256n - 1n;

const art = (name) => JSON.parse(fs.readFileSync(path.join(artifactsDir, `${name}.sol`, `${name}.json`), "utf8"));
const PM = art("PoolManager");
const Hook = art("OorkaHook");
const Swap = art("PoolSwapTest");
const Lp = art("PoolModifyLiquidityTest");
const Token = art("MockERC20");

const transport = http(RPC_URL);
const pub = createPublicClient({ chain: foundry, transport, pollingInterval: 100 });
const test = createTestClient({ chain: foundry, mode: "hardhat", transport });
const acct = (i) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const wallet = (i) => createWalletClient({ account: acct(i), chain: foundry, transport });
const deployer = acct(0);
const w0 = wallet(0);

const log = (...a) => console.log(...a);
const wait = async (hash, what) => {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${what} reverted: ${hash}`);
  if (what) log(`  ✓ ${what}`);
  return r;
};
const deploy = async (a, args, what) =>
  (await wait(await w0.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, gas: 30_000_000n }), what)).contractAddress;
const create2 = async (salt, initCode, what) => {
  const addr = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecode: initCode });
  await wait(await w0.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([salt, initCode]), gas: 30_000_000n }), what);
  return addr;
};
const write = async (i, address, abi, functionName, args, what) =>
  wait(await wallet(i).writeContract({ address, abi, functionName, args, gas: 5_000_000n }), what);
const sqrtPriceAtTick = (tick) => BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, tick)) * 2 ** 96));
const round = (t) => Math.trunc(t / TICK_SPACING) * TICK_SPACING;

// ---------------------------------------------------------------- go
const chainId = await pub.getChainId();
log(`chain ${chainId} at ${RPC_URL}`);
if ((await pub.getCode({ address: CREATE2_DEPLOYER }))?.length > 2) log("  = CREATE2 deployer present");
else {
  await test.setCode({ address: CREATE2_DEPLOYER, bytecode: CREATE2_RUNTIME });
  log("  ✓ installed the CREATE2 deployer");
}

log("PoolManager and routers");
const manager = await deploy(PM, [deployer.address], "PoolManager");
const swapRouter = await deploy(Swap, [manager], "PoolSwapTest");
const lpRouter = await deploy(Lp, [manager], "PoolModifyLiquidityTest");

log("tokens (tETH sorts below tUSD)");
const tethInit = encodeDeployData({ abi: Token.abi, bytecode: Token.bytecode.object, args: ["Test Ether", "tETH", 18] });
const tusdInit = encodeDeployData({ abi: Token.abi, bytecode: Token.bytecode.object, args: ["Test USD", "tUSD", 18] });
const teth = await create2(pad("0x0"), tethInit, "tETH");
let usdSalt;
for (let s = 0n; ; s++) {
  const cand = pad(toHex(s), { size: 32 });
  if (BigInt(getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: cand, bytecode: tusdInit })) > BigInt(teth)) {
    usdSalt = cand;
    break;
  }
}
const tusd = await create2(usdSalt, tusdInit, "tUSD");

log("hook (mining the permission-bit address)");
const cfg = {
  epochLength: 600n,
  winStreak: 2,
  marginBps: 10,
  switchCostBps: 30,
  slashBps: 2000,
  maxTickDeviation: 300,
  minBond: parseEther("100"),
  perfFeeBps: 1000,
};
const hookInit = encodeDeployData({ abi: Hook.abi, bytecode: Hook.bytecode.object, args: [manager, cfg] });
const hookHash = keccak256(hookInit);
let hookSalt;
for (let s = 0n; ; s++) {
  const cand = pad(toHex(s), { size: 32 });
  const a = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: cand, bytecodeHash: hookHash });
  if ((BigInt(a) & ALL_HOOK_MASK) === FLAGS) {
    hookSalt = cand;
    break;
  }
}
const hook = await create2(hookSalt, hookInit, "OorkaHook");

log("pool");
const key = { currency0: teth, currency1: tusd, fee: FEE, tickSpacing: TICK_SPACING, hooks: hook };
await write(0, manager, PM.abi, "initialize", [key, sqrtPriceAtTick(START_TICK)], "initialize tETH/tUSD at ~3,000");

log("funding and approvals for the deployer and actor slots 1-9");
for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 9]) {
  const who = acct(i).address;
  await write(0, teth, Token.abi, "mint", [who, parseEther("100000")]);
  await write(0, tusd, Token.abi, "mint", [who, parseEther("300000000")]);
  for (const t of [teth, tusd]) for (const spender of [hook, swapRouter, lpRouter]) await write(i, t, Token.abi, "approve", [spender, MAX]);
}
log("  ✓ minted and approved");

log("background liquidity");
await write(
  0,
  lpRouter,
  Lp.abi,
  "modifyLiquidity",
  [key, { tickLower: START_TICK - 6960, tickUpper: START_TICK + 6960, liquidityDelta: 4n * 10n ** 22n, salt: pad("0x0") }, "0x"],
  "modifyLiquidity",
);

log("curators, benchmark, vault");
await write(1, hook, Hook.abi, "register", ["Passive Pam", round(START_TICK - 5160), round(START_TICK + 3360), parseEther("500")], "Passive Pam (seat)");
await write(2, hook, Hook.abi, "register", ["Tight Tony", round(START_TICK - 300), round(START_TICK + 300), parseEther("500")], "Tight Tony");
await write(3, hook, Hook.abi, "register", ["Mid Mia", round(START_TICK - 1020), round(START_TICK + 960), parseEther("500")], "Mid Mia");
await write(4, hook, Hook.abi, "registerBenchmark", ["Benchmark", round(START_TICK - 6960), round(START_TICK + 4080)], "Benchmark");
await write(4, hook, Hook.abi, "deposit", [parseEther("50"), parseEther("150000"), 0n], "vault deposit");

const out = { chainId, poolManager: manager, swapRouter, lpRouter, hook, token0: teth, token1: tusd, fee: FEE, tickSpacing: TICK_SPACING };
const file = path.resolve(process.cwd(), "public/deployments.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 2));
log(`\nwrote ${file}`);
log(JSON.stringify(out, null, 2));
