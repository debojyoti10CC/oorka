// Demo market for the public testnet pool: one run trades the price toward a slowly moving target, then adds a
// few round-trip trades for fee volume. A scheduled GitHub Action runs it every 15 minutes so the arena has real
// swaps to score. It never settles epochs: that stays with the Reactive keeper.
//
// The target is a deterministic function of time: a slow wave (about ±3.5% over 8 hours) plus a faster ripple.
// Near the middle of the wave the tight range collects the most fees; at the extremes the price leaves it and
// the wider ranges catch up. That is the trade-off the arena is built to measure.
//
//   TRADER_KEY=0x... node scripts/market.mjs [deploymentsFile]
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, maxUint256, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const file = process.argv[2] ?? path.resolve(process.cwd(), "public/deployments.1301.json");
const dep = JSON.parse(fs.readFileSync(file, "utf8"));
const key = process.env.TRADER_KEY;
if (!key) throw new Error("TRADER_KEY is not set");

const chain = defineChain({
  id: dep.chainId,
  name: "unichain-sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [dep.rpcUrl] } },
});
const transport = http(dep.rpcUrl, { retryCount: 4 });
const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
]);
const HOOK = parseAbi(["function refSqrtPrice() view returns (uint160)"]);
const ROUTER = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }",
  "struct TestSettings { bool takeClaims; bool settleUsingBurn; }",
  "function swap(PoolKey key, SwapParams params, TestSettings testSettings, bytes hookData) payable returns (int256)",
]);
const poolKey = { currency0: dep.token0, currency1: dep.token1, fee: dep.fee, tickSpacing: dep.tickSpacing, hooks: dep.hook };
const Q96 = 2n ** 96n;
const MIN_LIMIT = 4295128740n;
const MAX_LIMIT = 1461446703485210103287273052203988822378723970341n;

const toSqrt = (price) => BigInt(Math.floor(Math.sqrt(price) * 2 ** 48)) * 2n ** 48n;
const fromSqrt = (sp) => {
  const r = Number(sp) / Number(Q96);
  return r * r;
};

const send = async (args, what) => {
  const hash = await wallet.writeContract({ ...args, gas: 900_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${r.status === "success" ? "✓" : "✗"} ${what}  ${hash}`);
  return r;
};

// ---------------------------------------------------------------- funds
for (const token of [dep.token0, dep.token1]) {
  const bal = await pub.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [account.address] });
  if (bal < parseEther("1000000")) {
    await send({ address: token, abi: ERC20, functionName: "mint", args: [account.address, parseEther("100000000")] }, "mint");
  }
  const allowance = await pub.readContract({
    address: token,
    abi: ERC20,
    functionName: "allowance",
    args: [account.address, dep.swapRouter],
  });
  if (allowance < parseEther("1000000000")) {
    await send({ address: token, abi: ERC20, functionName: "approve", args: [dep.swapRouter, maxUint256] }, "approve");
  }
}

const swap = (zeroForOne, amountSpecified, limit, what) =>
  send(
    {
      address: dep.swapRouter,
      abi: ROUTER,
      functionName: "swap",
      args: [
        poolKey,
        { zeroForOne, amountSpecified, sqrtPriceLimitX96: limit ?? (zeroForOne ? MIN_LIMIT : MAX_LIMIT) },
        { takeClaims: false, settleUsingBurn: false },
        "0x",
      ],
    },
    what,
  );

// ---------------------------------------------------------------- 1. walk toward the target
const t = Date.now() / 1000;
const ANCHOR = 3000;
const wave = 0.035 * Math.sin((2 * Math.PI * t) / (8 * 3600)) + 0.012 * Math.sin((2 * Math.PI * t) / (77 * 60));
const target = ANCHOR * Math.exp(wave);
const now = fromSqrt(await pub.readContract({ address: dep.hook, abi: HOOK, functionName: "refSqrtPrice" }));
console.log(`price ${now.toFixed(2)} -> target ${target.toFixed(2)}`);
if (Math.abs(now / target - 1) > 0.001) {
  const up = target > now;
  // exact-in with a price limit: the swap stops exactly at the target
  await swap(!up, -parseEther(up ? "5000000" : "2000"), toSqrt(target), up ? "buy tETH to target" : "sell tETH to target");
}

// ---------------------------------------------------------------- 2. round trips for fee volume
const rounds = 2 + Math.floor(Math.random() * 3);
for (let i = 0; i < rounds; i++) {
  const eth = parseEther((5 + Math.random() * 20).toFixed(3));
  if (i % 2 === 0) {
    await swap(true, -eth, null, `sell ${Number(eth) / 1e18} tETH`);
    await swap(false, eth, null, "buy it back");
  } else {
    await swap(false, eth, null, `buy ${Number(eth) / 1e18} tETH`);
    await swap(true, -eth, null, "sell it back");
  }
}
console.log("done");
