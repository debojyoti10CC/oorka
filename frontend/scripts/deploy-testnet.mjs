// Deploy Oorka to a chain with an existing Uniswap v4 PoolManager (default: Unichain Sepolia), using the
// contract artifacts Foundry built in CI. Same steps as contracts/script/DeployTestnet.s.sol, for machines
// where forge can't run.
//
//   node scripts/deploy-testnet.mjs <artifactsDir> [envFile]
//
// artifactsDir: the unpacked "contracts-out" CI artifact (folders like OorkaHook.sol/OorkaHook.json).
// envFile: file with PRIVATE_KEY=0x... (default ../../.oorka-deployer.env). Optional overrides via env vars:
//   RPC_URL, POOL_MANAGER, CALLBACK_PROXY, EPOCH_SECONDS, KEEPER_FUNDING_ETH
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeDeployData,
  getContractAddress,
  http,
  keccak256,
  parseEther,
  concat,
  toHex,
  pad,
  defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const artifactsDir = process.argv[2];
const envFile = process.argv[3] ?? path.resolve(process.cwd(), "../../.oorka-deployer.env");
if (!artifactsDir) throw new Error("usage: node scripts/deploy-testnet.mjs <artifactsDir> [envFile]");

const env = Object.fromEntries(
  fs
    .readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const RPC_URL = process.env.RPC_URL ?? "https://sepolia.unichain.org";
const POOL_MANAGER = process.env.POOL_MANAGER ?? "0x00b036b58a818b1bc34d502d3fe730db729e62ac";
const CALLBACK_PROXY = process.env.CALLBACK_PROXY ?? "0x775c9B990ADe401060B78D0e98684eEf8d2466C1"; // Reactive, Unichain Sepolia
const EPOCH_SECONDS = BigInt(process.env.EPOCH_SECONDS ?? "600");
const KEEPER_FUNDING = parseEther(process.env.KEEPER_FUNDING_ETH ?? "0.005");
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

const TICK_SPACING = 60;
const START_TICK = 80040; // ~3000 tUSD per tETH
const FEE = 3000;
// v4 Hooks permission bits: AFTER_INITIALIZE (1<<12) | BEFORE_SWAP (1<<7) | BEFORE_DONATE (1<<5)
const FLAGS = (1n << 12n) | (1n << 7n) | (1n << 5n);
const ALL_HOOK_MASK = (1n << 14n) - 1n;

const art = (name) => JSON.parse(fs.readFileSync(path.join(artifactsDir, `${name}.sol`, `${name}.json`), "utf8"));
const Hook = art("OorkaHook");
const Keeper = art("OorkaKeeper");
const Swap = art("PoolSwapTest");
const Lp = art("PoolModifyLiquidityTest");
const Token = art("MockERC20");

const account = privateKeyToAccount(env.PRIVATE_KEY);
const transport = http(RPC_URL);
const pub0 = createPublicClient({ transport });
const chainId = await pub0.getChainId();
const chain = defineChain({
  id: chainId,
  name: `chain-${chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });
const me = account.address;

const log = (...a) => console.log(...a);
const wait = async (hash, what) => {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${what} reverted: ${hash}`);
  log(`  ✓ ${what}  ${hash}`);
  return r;
};
const deploy = async (artifact, args, what, value = 0n) => {
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args, value });
  const r = await wait(hash, what);
  return r.contractAddress;
};
const create2 = async (salt, initCode, what) => {
  const addr = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecode: initCode });
  if ((await pub.getCode({ address: addr }))?.length > 2) {
    log(`  = ${what} already at ${addr}`);
    return addr;
  }
  await wait(await wallet.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([salt, initCode]) }), what);
  return addr;
};
const write = async (address, abi, functionName, args, what, value) =>
  wait(await wallet.writeContract({ address, abi, functionName, args, value }), what ?? functionName);

const sqrtPriceAtTick = (tick) => {
  // float is plenty precise for picking a start price
  const s = Math.sqrt(Math.pow(1.0001, tick)) * 2 ** 96;
  return BigInt(Math.floor(s));
};

// ---------------------------------------------------------------- go
const balance = await pub.getBalance({ address: me });
log(`chain ${chainId}  deployer ${me}  balance ${Number(balance) / 1e18} ETH`);
if (balance < parseEther("0.01")) throw new Error("Deployer needs at least 0.01 ETH on this chain. Fund it from a faucet first.");
if (((await pub.getCode({ address: POOL_MANAGER })) ?? "0x").length <= 2) throw new Error(`No PoolManager at ${POOL_MANAGER}`);

log("routers");
const swapRouter = await deploy(Swap, [POOL_MANAGER], "PoolSwapTest");
const lpRouter = await deploy(Lp, [POOL_MANAGER], "PoolModifyLiquidityTest");

log("tokens (tETH must sort below tUSD)");
const runSalt = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [me, BigInt(Date.now())]));
const tethInit = encodeDeployData({ abi: Token.abi, bytecode: Token.bytecode.object, args: ["Test Ether", "tETH", 18] });
const tusdInit = encodeDeployData({ abi: Token.abi, bytecode: Token.bytecode.object, args: ["Test USD", "tUSD", 18] });
const teth = await create2(runSalt, tethInit, "tETH");
let usdSalt;
for (let s = 0n; ; s++) {
  const cand = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [runSalt, s]));
  const a = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: cand, bytecode: tusdInit });
  if (BigInt(a) > BigInt(teth)) {
    usdSalt = cand;
    break;
  }
}
const tusd = await create2(usdSalt, tusdInit, "tUSD");

log("hook (mining a CREATE2 salt for the permission bits)");
const cfg = {
  epochLength: EPOCH_SECONDS,
  winStreak: 2,
  marginBps: 10,
  switchCostBps: 30,
  slashBps: 2000,
  maxTickDeviation: 300,
  minBond: parseEther("100"),
  perfFeeBps: 1000,
};
const hookInit = encodeDeployData({ abi: Hook.abi, bytecode: Hook.bytecode.object, args: [POOL_MANAGER, cfg] });
const hookInitHash = keccak256(hookInit);
let hookSalt;
for (let s = 0n; ; s++) {
  const cand = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "string" }, { type: "uint256" }], [runSalt, "hook", s]));
  const a = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: cand, bytecodeHash: hookInitHash });
  if ((BigInt(a) & ALL_HOOK_MASK) === FLAGS) {
    hookSalt = cand;
    log(`  salt found after ${s} tries`);
    break;
  }
}
const hook = await create2(hookSalt, hookInit, "OorkaHook");

log("pool");
const key = { currency0: teth, currency1: tusd, fee: FEE, tickSpacing: TICK_SPACING, hooks: hook };
const pmAbi = [
  {
    type: "function",
    name: "initialize",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "sqrtPriceX96", type: "uint160" },
    ],
    outputs: [{ name: "tick", type: "int24" }],
  },
];
await write(POOL_MANAGER, pmAbi, "initialize", [key, sqrtPriceAtTick(START_TICK)], "PoolManager.initialize");

log("funding and approvals");
const MAX = 2n ** 256n - 1n;
await write(teth, Token.abi, "mint", [me, parseEther("1000000")], "mint tETH");
await write(tusd, Token.abi, "mint", [me, parseEther("3000000000")], "mint tUSD");
for (const t of [teth, tusd]) for (const spender of [lpRouter, hook, swapRouter]) await write(t, Token.abi, "approve", [spender, MAX], `approve ${t === teth ? "tETH" : "tUSD"}`);

log("background liquidity");
await write(
  lpRouter,
  Lp.abi,
  "modifyLiquidity",
  [key, { tickLower: START_TICK - 6960, tickUpper: START_TICK + 6960, liquidityDelta: 4n * 10n ** 22n, salt: pad("0x0") }, "0x"],
  "modifyLiquidity",
);

log("curators, benchmark, vault");
const r = (t) => Math.trunc(t / TICK_SPACING) * TICK_SPACING;
await write(hook, Hook.abi, "register", ["Passive Pam", r(START_TICK - 5160), r(START_TICK + 3360), parseEther("500")], "register Passive Pam (seat)");
await write(hook, Hook.abi, "register", ["Tight Tony", r(START_TICK - 300), r(START_TICK + 300), parseEther("500")], "register Tight Tony");
await write(hook, Hook.abi, "register", ["Mid Mia", r(START_TICK - 1020), r(START_TICK + 960), parseEther("500")], "register Mid Mia");
await write(hook, Hook.abi, "registerBenchmark", ["Benchmark", r(START_TICK - 6960), r(START_TICK + 4080)], "registerBenchmark");
await write(hook, Hook.abi, "deposit", [parseEther("50"), parseEther("150000"), 0n], "deposit");

log("Reactive keeper (callback contract on this chain)");
const keeper = await deploy(Keeper, [CALLBACK_PROXY, hook, false], "OorkaKeeper", KEEPER_FUNDING);

const out = {
  chainId,
  rpcUrl: RPC_URL,
  poolManager: POOL_MANAGER,
  swapRouter,
  lpRouter,
  hook,
  keeper,
  callbackProxy: CALLBACK_PROXY,
  token0: teth,
  token1: tusd,
  fee: FEE,
  tickSpacing: TICK_SPACING,
  deployer: me,
  deployedAt: new Date().toISOString(),
};
const file = path.resolve(process.cwd(), `public/deployments.${chainId}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 2));
log(`\nwrote ${file}`);
log(JSON.stringify(out, null, 2));
