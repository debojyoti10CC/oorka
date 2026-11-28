// Market maker for the public testnet pool. One run moves the price toward a slowly drifting target and adds a
// few round-trip trades for fee volume, all with the bot's own USDC and WETH through the real pool. A scheduled
// GitHub Action runs it every 15 minutes. It never settles epochs: that stays with the Reactive keepers.
//
// The target is a deterministic function of time: a slow wave (about ±3.5% over 8 hours) plus a faster ripple.
// Near the middle of the wave tight ranges collect the most fees; at the swings the price leaves them and wider
// ranges catch up. That alternation is what decides who should hold the curator seat.
//
//   TRADER_KEY=0x... node scripts/market.mjs [deploymentsFile]
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  maxUint256,
  parseAbi,
  parseUnits,
} from "viem";
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
const me = account.address;

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
  "function deposit() payable",
]);
const HOOK = parseAbi(["function refSqrtPrice() view returns (uint160)"]);
const ROUTER = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }",
  "struct TestSettings { bool takeClaims; bool settleUsingBurn; }",
  "function swap(PoolKey key, SwapParams params, TestSettings testSettings, bytes hookData) payable returns (int256)",
]);
const poolKey = { currency0: dep.token0, currency1: dep.token1, fee: dep.fee, tickSpacing: dep.tickSpacing, hooks: dep.hook };
const MIN_LIMIT = 4295128740n;
const MAX_LIMIT = 1461446703485210103287273052203988822378723970341n;

// ---------------------------------------------------------------- the pair
const dec0 = Number(dep.token0Decimals ?? 18);
const dec1 = Number(dep.token1Decimals ?? 18);
const b = dep.base === 1 ? 1 : 0; // which currency is the base asset
const q = b === 0 ? 1 : 0;
const decOf = (i) => (i === 0 ? dec0 : dec1);
const tokenOf = (i) => (i === 0 ? dep.token0 : dep.token1);
const symOf = (i) => (i === 0 ? dep.token0Symbol ?? "tETH" : dep.token1Symbol ?? "tUSD");
const mintable = dep.mintable ?? !dep.token0Symbol;
const size = Number(dep.tradeBase ?? 20); // a typical trade, in the base asset

// display price (quote per base) <-> sqrtPriceX96
const priceOf = (sp) => {
  const r = Number(sp) / 2 ** 96;
  const ratio = r * r * 10 ** (dec0 - dec1); // token1 per token0
  return b === 0 ? ratio : 1 / ratio;
};
const sqrtOf = (price) => {
  const ratio = (b === 0 ? price : 1 / price) * 10 ** (dec1 - dec0);
  return BigInt(Math.floor(Math.sqrt(ratio) * 2 ** 48)) * 2n ** 48n;
};
const units = (x, i) => parseUnits(x.toFixed(Math.min(decOf(i), 8)), decOf(i));
const human = (v, i) => Number(formatUnits(v, decOf(i)));

const send = async (args, what) => {
  const hash = await wallet.writeContract({ ...args, gas: 900_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${r.status === "success" ? "✓" : "✗"} ${what}  ${hash}`);
  return r;
};
const balanceOf = (i) => pub.readContract({ address: tokenOf(i), abi: ERC20, functionName: "balanceOf", args: [me] });

// ---------------------------------------------------------------- funds
for (const i of [0, 1]) {
  const token = tokenOf(i);
  const bal = await balanceOf(i);
  const want = units(i === b ? size * 40 : size * 40 * 3000, i);
  if (bal < want) {
    if (mintable) {
      await send({ address: token, abi: ERC20, functionName: "mint", args: [me, want * 100n] }, `mint ${symOf(i)}`);
    } else if (dep.weth && token.toLowerCase() === dep.weth.toLowerCase()) {
      // keep some ETH for gas; wrap the rest up to the target
      const eth = await pub.getBalance({ address: me });
      const room = eth > 2_000_000_000_000_000n ? eth - 2_000_000_000_000_000n : 0n;
      const wrap = want - bal < room ? want - bal : room;
      if (wrap > 0n) await send({ address: token, abi: ERC20, functionName: "deposit", args: [], value: wrap }, `wrap ${formatUnits(wrap, 18)} ETH`);
    }
  }
  const allowance = await pub.readContract({ address: token, abi: ERC20, functionName: "allowance", args: [me, dep.swapRouter] });
  if (allowance < maxUint256 / 2n) await send({ address: token, abi: ERC20, functionName: "approve", args: [dep.swapRouter, maxUint256] }, `approve ${symOf(i)}`);
}
console.log(`balances: ${human(await balanceOf(0), 0)} ${symOf(0)}, ${human(await balanceOf(1), 1)} ${symOf(1)}`);

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
const ANCHOR = Number(process.env.ANCHOR_PRICE ?? 3000);
const wave = 0.035 * Math.sin((2 * Math.PI * t) / (8 * 3600)) + 0.012 * Math.sin((2 * Math.PI * t) / (77 * 60));
const target = ANCHOR * Math.exp(wave);
const now = priceOf(await pub.readContract({ address: dep.hook, abi: HOOK, functionName: "refSqrtPrice" }));
console.log(`price ${now.toFixed(2)} -> target ${target.toFixed(2)}`);
if (Math.abs(now / target - 1) > 0.001) {
  const up = target > now; // base gets more expensive: buy base with quote
  const spend = up ? q : b; // the currency paid in
  const bal = await balanceOf(spend);
  // exact-in with a price limit: the swap stops at the target, spending at most half the balance
  if (bal > 0n) await swap(spend === 0, -(bal / 2n), sqrtOf(target), up ? `buy ${symOf(b)} to target` : `sell ${symOf(b)} to target`);
}

// ---------------------------------------------------------------- 2. a round trip for fee volume
// Every swap is also a Reactive transaction for Oorka Pulse (billed in lREACT), so volume stays modest: one
// round trip on about half the runs, on top of the walk toward the target.
const rounds = Math.random() < 0.5 ? 1 : 0;
for (let i = 0; i < rounds; i++) {
  const amt = units(size * (1 + Math.random() * 2), b);
  const sellBase = b === 0; // zeroForOne sells token0
  if (i % 2 === 0) {
    await swap(sellBase, -amt, null, `sell ${human(amt, b)} ${symOf(b)}`);
    await swap(!sellBase, amt, null, "buy it back");
  } else {
    await swap(!sellBase, amt, null, `buy ${human(amt, b)} ${symOf(b)}`);
    await swap(sellBase, -amt, null, "sell it back");
  }
}
console.log("done");
