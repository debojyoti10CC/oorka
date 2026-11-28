// Tops up OorkaPulse with Lasna lREACT:
//   1. wait for the deployer's Sepolia ETH (e.g. a faucet drip) to land
//   2. send it to Reactive's Sepolia faucet contract (1 ETH = 100 lREACT, credited to the sender on Lasna)
//   3. wait for the lREACT, forward it to OorkaPulse and settle any debt (coverDebt)
//
//   node scripts/fund-pulse.mjs [envFile]          SEPOLIA_KEEP (ETH left for gas, default 0.0015)
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseAbi, parseEther, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const envFile = process.argv[2] ?? path.resolve(process.cwd(), "../../.oorka-deployer.env");
const env = Object.fromEntries(
  fs
    .readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const dep = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "public/deployments.1301.json"), "utf8"));
const account = privateKeyToAccount(env.PRIVATE_KEY);
const FAUCET = "0x9b9BB25f1A81078C544C829c5EB7822d747Cf434";
const KEEP = parseEther(process.env.SEPOLIA_KEEP ?? "0.0015");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mk = (id, rpc) => {
  const chain = defineChain({ id, name: `c${id}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const transport = http(rpc, { retryCount: 4 });
  return { pub: createPublicClient({ chain, transport }), wallet: createWalletClient({ account, chain, transport }) };
};
const sep = mk(11155111, "https://ethereum-sepolia-rpc.publicnode.com");
const lasna = mk(5318007, dep.reactive?.rpcUrl ?? "https://lasna-rpc.rnk.dev/");
const lasnaFees = { maxFeePerGas: parseGwei("110"), maxPriorityFeePerGas: parseGwei("2") };

// 1. Sepolia ETH
let bal;
for (let i = 0; ; i++) {
  bal = await sep.pub.getBalance({ address: account.address });
  if (bal >= parseEther("0.02")) break;
  if (i > 120) throw new Error(`no Sepolia ETH arrived (balance ${formatEther(bal)})`);
  await sleep(10_000);
}
console.log(`Sepolia balance ${formatEther(bal)} ETH`);

// 2. to the Reactive faucet
const value = bal - KEEP;
const lasnaBefore = await lasna.pub.getBalance({ address: account.address });
const h = await sep.wallet.sendTransaction({ to: FAUCET, value });
const r = await sep.pub.waitForTransactionReceipt({ hash: h });
if (r.status !== "success") throw new Error(`faucet transfer reverted ${h}`);
console.log(`sent ${formatEther(value)} ETH to the Reactive faucet  ${h}`);

// 3. wait for lREACT, forward to Pulse
let lb;
for (let i = 0; ; i++) {
  lb = await lasna.pub.getBalance({ address: account.address });
  if (lb > lasnaBefore + parseEther("1")) break;
  if (i > 90) throw new Error(`lREACT did not arrive (balance ${formatEther(lb)})`);
  await sleep(10_000);
}
console.log(`Lasna balance ${formatEther(lb)} lREACT`);
const forward = lb - parseEther("0.1");
const t = await lasna.wallet.sendTransaction({ to: dep.pulse.contract, value: forward, ...lasnaFees });
await lasna.pub.waitForTransactionReceipt({ hash: t });
console.log(`forwarded ${formatEther(forward)} lREACT to OorkaPulse  ${t}`);
const c = await lasna.wallet.writeContract({
  address: dep.pulse.contract,
  abi: parseAbi(["function coverDebt()"]),
  functionName: "coverDebt",
  ...lasnaFees,
});
await lasna.pub.waitForTransactionReceipt({ hash: c });
const debt = await lasna.pub.readContract({
  address: "0x8888888888888888888888888888888888888888",
  abi: parseAbi(["function debts(address) view returns (uint256)"]),
  functionName: "debts",
  args: [dep.pulse.contract],
});
console.log(`coverDebt ${c}\nPulse balance ${formatEther(await lasna.pub.getBalance({ address: dep.pulse.contract }))} lREACT, debt ${formatEther(debt)}`);
