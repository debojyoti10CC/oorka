// Deploy Oorka on an existing token pair (default: Circle's testnet USDC and WETH on Unichain Sepolia) against
// an existing Uniswap v4 PoolManager, using the contract artifacts Foundry built in CI.
//
//   node scripts/deploy-pool.mjs <artifactsDir> [envFile]
//
// artifactsDir: the unpacked "contracts-out" CI artifact. envFile: PRIVATE_KEY=0x... (default ../../.oorka-deployer.env).
// The deployer needs a little ETH and the quote token (USDC from https://faucet.circle.com). WETH is wrapped from
// ETH here. Optional env overrides: RPC_URL, POOL_MANAGER, SWAP_ROUTER, LP_ROUTER, BASE, QUOTE, START_PRICE,
// EPOCH_SECONDS, SEED_QUOTE (quote for background liquidity), VAULT_QUOTE, BOND (base units), MIN_BOND.
// Afterwards run scripts/deploy-pulse.mjs and scripts/deploy-reactive.mjs for automatic settlement.
import fs from "node:fs";
import path from "node:path";
import {
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeDeployData,
  formatUnits,
  getContractAddress,
  http,
  keccak256,
  pad,
  parseAbi,
  parseEther,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const artifactsDir = process.argv[2];
const envFile = process.argv[3] ?? path.resolve(process.cwd(), "../../.oorka-deployer.env");
if (!artifactsDir) throw new Error("usage: node scripts/deploy-pool.mjs <artifactsDir> [envFile]");
const env = Object.fromEntries(
  fs
    .readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const E = (k, d) => process.env[k] ?? d;

const RPC_URL = E("RPC_URL", "https://sepolia.unichain.org");
const POOL_MANAGER = E("POOL_MANAGER", "0x00b036b58a818b1bc34d502d3fe730db729e62ac");
const SWAP_ROUTER = E("SWAP_ROUTER", "0xa93b93a962d8b00d409f084f2262c0a773b2e0dd");
const LP_ROUTER = E("LP_ROUTER", "0xbe8e4ed28186051fecf425ba945a4a687f827c77");
const CALLBACK_PROXY = E("CALLBACK_PROXY", "0x775c9B990ADe401060B78D0e98684eEf8d2466C1");
const BASE = E("BASE", "0x4200000000000000000000000000000000000006"); // WETH (OP-stack predeploy)
const QUOTE = E("QUOTE", "0x31d0220469e10c4E71834a79b1f276d740d3768F"); // Circle USDC on Unichain Sepolia
const START_PRICE = Number(E("START_PRICE", "3000")); // quote per base
const EPOCH_SECONDS = BigInt(E("EPOCH_SECONDS", "900"));
const SEED_QUOTE = Number(E("SEED_QUOTE", "8"));
const VAULT_QUOTE = Number(E("VAULT_QUOTE", "5"));
const BOND = E("BOND", "0.0002");
const MIN_BOND = E("MIN_BOND", "0.0001");
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const FEE = 3000;
const TICK_SPACING = 60;
const FLAGS = (1n << 12n) | (1n << 7n) | (1n << 5n); // AFTER_INITIALIZE | BEFORE_SWAP | BEFORE_DONATE
const ALL_HOOK_MASK = (1n << 14n) - 1n;

const art = (name) => JSON.parse(fs.readFileSync(path.join(artifactsDir, `${name}.sol`, `${name}.json`), "utf8"));
const Hook = art("OorkaHook");
const Lp = art("PoolModifyLiquidityTest");
const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function deposit() payable",
]);

const account = privateKeyToAccount(env.PRIVATE_KEY);
const transport = http(RPC_URL);
const chainId = await createPublicClient({ transport }).getChainId();
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
const write = async (address, abi, functionName, args, what, value) =>
  wait(await wallet.writeContract({ address, abi, functionName, args, value }), what ?? functionName);

// ---------------------------------------------------------------- the pair
const [c0, c1] = BigInt(BASE) < BigInt(QUOTE) ? [BASE, QUOTE] : [QUOTE, BASE];
const baseIdx = c0.toLowerCase() === BASE.toLowerCase() ? 0 : 1;
const meta = async (a) => ({
  symbol: await pub.readContract({ address: a, abi: ERC20, functionName: "symbol" }),
  decimals: Number(await pub.readContract({ address: a, abi: ERC20, functionName: "decimals" })),
});
const m0 = await meta(c0);
const m1 = await meta(c1);
const [mBase, mQuote] = baseIdx === 0 ? [m0, m1] : [m1, m0];
log(`pair ${m0.symbol}/${m1.symbol} (token0/token1), base ${mBase.symbol}, price ${START_PRICE} ${mQuote.symbol} per ${mBase.symbol}`);

// display price (quote per base) <-> tick
const ratioOf = (p) => (baseIdx === 0 ? p : 1 / p) * 10 ** (m1.decimals - m0.decimals); // raw token1 per token0
const tickOf = (p) => Math.log(ratioOf(p)) / Math.log(1.0001);
const snap = (t) => Math.round(t / TICK_SPACING) * TICK_SPACING;
const band = (lo, hi) => {
  const a = tickOf(lo);
  const b = tickOf(hi);
  return [Math.floor(Math.min(a, b) / TICK_SPACING) * TICK_SPACING, Math.ceil(Math.max(a, b) / TICK_SPACING) * TICK_SPACING];
};
const START_TICK = snap(tickOf(START_PRICE));
const sqrtAt = (t) => Math.sqrt(Math.pow(1.0001, t));
const sqrtPriceX96 = BigInt(Math.floor(sqrtAt(START_TICK) * 2 ** 96));

/** liquidity for a range that holds `amountQuote` of the quote token at the start price */
function liquidityFor(lower, upper, amountQuote) {
  const s = sqrtAt(START_TICK);
  const sl = sqrtAt(lower);
  const su = sqrtAt(upper);
  const raw = amountQuote * 10 ** mQuote.decimals;
  // amount0 = L (1/s - 1/su), amount1 = L (s - sl)
  const perL = baseIdx === 1 ? 1 / s - 1 / su : s - sl;
  return BigInt(Math.floor(raw / perL));
}

// ---------------------------------------------------------------- funds
const bal = (a) => pub.readContract({ address: a, abi: ERC20, functionName: "balanceOf", args: [me] });
log(`deployer ${me}: ${formatUnits(await pub.getBalance({ address: me }), 18)} ETH, ${formatUnits(await bal(QUOTE), mQuote.decimals)} ${mQuote.symbol}`);
const quoteNeed = parseUnits(String(SEED_QUOTE + VAULT_QUOTE + 1), mQuote.decimals);
if ((await bal(QUOTE)) < quoteNeed) throw new Error(`Need ${formatUnits(quoteNeed, mQuote.decimals)} ${mQuote.symbol}. Get it from https://faucet.circle.com`);
if (((await pub.getCode({ address: POOL_MANAGER })) ?? "0x").length <= 2) throw new Error(`No PoolManager at ${POOL_MANAGER}`);

const deployBlock = await pub.getBlockNumber();

// ---------------------------------------------------------------- hook
log("hook (mining a CREATE2 salt for the permission bits)");
const cfg = {
  epochLength: EPOCH_SECONDS,
  winStreak: 2,
  marginBps: 10,
  switchCostBps: 30,
  slashBps: 2000,
  maxTickDeviation: 300,
  minBond: parseUnits(MIN_BOND, m1.decimals), // bonds are booked in token1
  perfFeeBps: 1000,
};
const runSalt = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [me, BigInt(Date.now())]));
const hookInit = encodeDeployData({ abi: Hook.abi, bytecode: Hook.bytecode.object, args: [POOL_MANAGER, cfg] });
const hookInitHash = keccak256(hookInit);
let hookSalt;
for (let s = 0n; ; s++) {
  const cand = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "string" }, { type: "uint256" }], [runSalt, "hook", s]));
  const a = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: cand, bytecodeHash: hookInitHash });
  if ((BigInt(a) & ALL_HOOK_MASK) === FLAGS) {
    hookSalt = cand;
    break;
  }
}
const hook = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: hookSalt, bytecodeHash: hookInitHash });
await wait(await wallet.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([hookSalt, hookInit]) }), `OorkaHook ${hook}`);

// ---------------------------------------------------------------- pool
log("pool");
const key = { currency0: c0, currency1: c1, fee: FEE, tickSpacing: TICK_SPACING, hooks: hook };
const PM = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function initialize(PoolKey key, uint160 sqrtPriceX96) returns (int24)",
]);
await write(POOL_MANAGER, PM, "initialize", [key, sqrtPriceX96], `initialize at tick ${START_TICK}`);

// ---------------------------------------------------------------- funding and approvals
const isWeth = (a) => a.toLowerCase() === "0x4200000000000000000000000000000000000006";
const baseSeed = START_PRICE > 0 ? (SEED_QUOTE + VAULT_QUOTE) / START_PRICE : 0;
const baseNeed = parseUnits((baseSeed * 1.6 + Number(BOND) * 3 + 0.0002).toFixed(mBase.decimals > 8 ? 8 : mBase.decimals), mBase.decimals);
const haveBase = await bal(BASE);
if (haveBase < baseNeed) {
  if (!isWeth(BASE)) throw new Error(`Need ${formatUnits(baseNeed, mBase.decimals)} ${mBase.symbol}`);
  await write(BASE, ERC20, "deposit", [], `wrap ${formatUnits(baseNeed - haveBase, 18)} ETH`, baseNeed - haveBase);
}
const MAX = 2n ** 256n - 1n;
for (const t of [c0, c1])
  for (const spender of [LP_ROUTER, hook, SWAP_ROUTER]) {
    const al = await pub.readContract({ address: t, abi: ERC20, functionName: "allowance", args: [me, spender] });
    if (al < MAX / 2n) await write(t, ERC20, "approve", [spender, MAX], `approve ${t === c0 ? m0.symbol : m1.symbol} to ${spender.slice(0, 8)}`);
  }

// ---------------------------------------------------------------- background liquidity
log("background liquidity");
const [bgL, bgU] = band(START_PRICE / 2, START_PRICE * 2);
await write(
  LP_ROUTER,
  Lp.abi,
  "modifyLiquidity",
  [key, { tickLower: bgL, tickUpper: bgU, liquidityDelta: liquidityFor(bgL, bgU, SEED_QUOTE), salt: pad("0x0") }, "0x"],
  `liquidity ${START_PRICE / 2}-${START_PRICE * 2}`,
);

// ---------------------------------------------------------------- curators, benchmark, vault
log("curators, benchmark, vault");
const HOOK_ABI = Hook.abi;
const bond = parseUnits(BOND, m1.decimals);
const P = START_PRICE;
const curators = [
  ["Passive Pam", P * 0.6, P * 1.4],
  ["Tight Tony", P * 0.97, P * 1.03],
  ["Mid Mia", P * 0.9, P * 1.1],
];
for (const [i, [name, lo, hi]] of curators.entries())
  await write(hook, HOOK_ABI, "register", [name, ...band(lo, hi), bond], `register ${name}${i === 0 ? " (seat)" : ""}`);
await write(hook, HOOK_ABI, "registerBenchmark", ["Benchmark", ...band(P * 0.5, P * 1.5)], "registerBenchmark");
const vq = parseUnits(String(VAULT_QUOTE), mQuote.decimals);
const vb = parseUnits(((VAULT_QUOTE / P) * 1.5).toFixed(8), mBase.decimals);
await write(hook, HOOK_ABI, "deposit", [baseIdx === 0 ? vb : vq, baseIdx === 0 ? vq : vb, 0n], "vault deposit");

// ---------------------------------------------------------------- write deployments
const file = path.resolve(process.cwd(), `public/deployments.${chainId}.json`);
const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const out = {
  chainId,
  rpcUrl: RPC_URL,
  poolManager: POOL_MANAGER,
  swapRouter: SWAP_ROUTER,
  lpRouter: LP_ROUTER,
  hook,
  keeper: null,
  callbackProxy: CALLBACK_PROXY,
  token0: c0,
  token1: c1,
  token0Symbol: m0.symbol,
  token1Symbol: m1.symbol,
  token0Decimals: m0.decimals,
  token1Decimals: m1.decimals,
  base: baseIdx,
  mintable: false,
  weth: isWeth(c0) ? c0 : isWeth(c1) ? c1 : undefined,
  faucets: { [mQuote.symbol]: "https://faucet.circle.com" },
  tradeBase: Number(((SEED_QUOTE / P) * 0.05).toPrecision(2)),
  fee: FEE,
  tickSpacing: TICK_SPACING,
  deployer: me,
  deployedAt: new Date().toISOString(),
  deployBlock: Number(deployBlock),
};
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
if (prev.hook && prev.hook !== hook) {
  const legacy = path.resolve(process.cwd(), `deployments/legacy-${prev.hook.slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify(prev, null, 2) + "\n");
  log(`previous deployment saved to ${legacy}`);
}
log(`\nwrote ${file}`);
log(JSON.stringify(out, null, 2));
