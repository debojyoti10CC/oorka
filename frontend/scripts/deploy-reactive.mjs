// Deploy Oorka's keeper-free automation on top of an existing testnet deployment:
//   1. OorkaReactive on Reactive Network (Lasna), subscribed to Cron100.
//   2. OorkaKeeper on the hook's chain, authenticating that OorkaReactive address through the callback proxy.
//   3. OorkaReactive.setKeeper(keeper), so the CRON ticks start reaching the keeper.
// The keeper needs the reactive contract's address at construction, and the reactive contract needs the keeper's
// address before it can name a recipient, so the cycle breaks on the reactive side with a one-shot setter.
//
//   node scripts/deploy-reactive.mjs <artifactsDir> [envFile]
//
// artifactsDir: the unpacked "contracts-out" CI artifact. envFile: PRIVATE_KEY=0x... (default ../../.oorka-deployer.env)
// Optional env overrides: REACTIVE_RPC_URL, REACTIVE_FUNDING, KEEPER_FUNDING_ETH, TICKS_PER_POKE
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const artifactsDir = process.argv[2];
const envFile = process.argv[3] ?? path.resolve(process.cwd(), "../../.oorka-deployer.env");
if (!artifactsDir) throw new Error("usage: node scripts/deploy-reactive.mjs <artifactsDir> [envFile]");
const env = Object.fromEntries(
  fs
    .readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const depFile = path.resolve(process.cwd(), "public/deployments.1301.json");
const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));

const CRON100 = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70n;
const REACTIVE_RPC = process.env.REACTIVE_RPC_URL ?? "https://lasna-rpc.rnk.dev/";
const REACTIVE_FUNDING = parseEther(process.env.REACTIVE_FUNDING ?? "1");
const KEEPER_FUNDING = parseEther(process.env.KEEPER_FUNDING_ETH ?? "0.003");
const TICKS_PER_POKE = BigInt(process.env.TICKS_PER_POKE ?? "1");

const art = (name) => JSON.parse(fs.readFileSync(path.join(artifactsDir, `${name}.sol`, `${name}.json`), "utf8"));
const Reactive = art("OorkaReactive");
const Keeper = art("OorkaKeeper");
const account = privateKeyToAccount(env.PRIVATE_KEY);

const client = async (rpc) => {
  const transport = http(rpc);
  const id = await createPublicClient({ transport }).getChainId();
  const chain = defineChain({
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: "Native", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  return { id, pub: createPublicClient({ chain, transport }), wallet: createWalletClient({ account, chain, transport }) };
};
const lasna = await client(REACTIVE_RPC);
const uni = await client(dep.rpcUrl);
// Lasna rejects a zero priority fee, which viem's estimate can produce there
const lasnaFees = { maxFeePerGas: parseGwei("200"), maxPriorityFeePerGas: parseGwei("2") };

const wait = async (c, hash, what) => {
  const r = await c.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${what} reverted: ${hash}`);
  console.log(`  ✓ ${what}  ${hash}`);
  return r;
};

console.log(`deployer ${account.address}`);
console.log("1. OorkaReactive on Reactive Network", lasna.id);
const rHash = await lasna.wallet.deployContract({
  abi: Reactive.abi,
  bytecode: Reactive.bytecode.object,
  args: [CRON100, BigInt(uni.id), TICKS_PER_POKE],
  value: REACTIVE_FUNDING,
  ...lasnaFees,
});
const reactive = (await wait(lasna, rHash, "OorkaReactive")).contractAddress;

console.log("2. OorkaKeeper on", uni.id);
const kHash = await uni.wallet.deployContract({
  abi: Keeper.abi,
  bytecode: Keeper.bytecode.object,
  args: [dep.callbackProxy, reactive, dep.hook, false],
  value: KEEPER_FUNDING,
});
const keeper = (await wait(uni, kHash, "OorkaKeeper")).contractAddress;

console.log("3. point the reactive contract at the keeper");
await wait(
  lasna,
  await lasna.wallet.writeContract({ address: reactive, abi: Reactive.abi, functionName: "setKeeper", args: [keeper], ...lasnaFees }),
  "setKeeper",
);

dep.keeper = keeper;
dep.reactive = {
  chainId: lasna.id,
  rpcUrl: REACTIVE_RPC,
  contract: reactive,
  cronTopic: "Cron100",
  ticksPerPoke: Number(TICKS_PER_POKE),
  deployTx: rHash,
};
fs.writeFileSync(depFile, JSON.stringify(dep, null, 2));
console.log(`\nwrote ${depFile}\n  reactive ${reactive}\n  keeper   ${keeper}`);
