// Deploy Oorka Pulse, the event-driven half of the automation, next to the existing CRON keeper:
//   1. OorkaPulse on Reactive Network (Lasna), subscribed to the pool's Swap events and the hook's
//      EpochSettled / VaultMoveDeferred / VaultMoved events on the hook's chain.
//   2. A second OorkaKeeper on the hook's chain that trusts OorkaPulse as its callback sender. compoundOnIdle is
//      on, so a callback that arrives mid-epoch finishes a deferred vault move.
//   3. OorkaPulse.setKeeper(keeper).
// The CRON keeper (deploy-reactive.mjs) keeps running untouched as the fallback for quiet pools.
//
//   node scripts/deploy-pulse.mjs <artifactsDir> [envFile]
//
// Optional env: PULSE_FUNDING (lREACT, default 0.4), KEEPER_FUNDING_ETH (default 0.003), COOLDOWN (seconds, default 30)
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  parseEther,
  parseGwei,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const artifactsDir = process.argv[2];
const envFile = process.argv[3] ?? path.resolve(process.cwd(), "../../.oorka-deployer.env");
if (!artifactsDir) throw new Error("usage: node scripts/deploy-pulse.mjs <artifactsDir> [envFile]");
const env = Object.fromEntries(
  fs
    .readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const depFile = path.resolve(process.cwd(), "public/deployments.1301.json");
const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));

const REACTIVE_RPC = dep.reactive?.rpcUrl ?? "https://lasna-rpc.rnk.dev/";
const PULSE_FUNDING = parseEther(process.env.PULSE_FUNDING ?? "0.4");
const KEEPER_FUNDING = parseEther(process.env.KEEPER_FUNDING_ETH ?? "0.003");
const COOLDOWN = BigInt(process.env.COOLDOWN ?? "30");

const art = (name) => JSON.parse(fs.readFileSync(path.join(artifactsDir, `${name}.sol`, `${name}.json`), "utf8"));
const Pulse = art("OorkaPulse");
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
const lasnaFees = { maxFeePerGas: parseGwei("110"), maxPriorityFeePerGas: parseGwei("2") };

const wait = async (c, hash, what) => {
  const r = await c.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${what} reverted: ${hash}`);
  console.log(`  ✓ ${what}  ${hash}`);
  return r;
};

// PoolId = keccak256(abi.encode(PoolKey))
const poolId = keccak256(
  encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [dep.token0, dep.token1, dep.fee, dep.tickSpacing, dep.hook],
  ),
);
const HOOK = parseAbi([
  "function epochInfo() view returns (uint256 current, uint256 start, uint256 end, uint256 nowTs)",
  "function config() view returns (uint64 epochLength, uint32, uint32, uint32, uint32, int24, uint256, uint32)",
]);
const [, , end] = await uni.pub.readContract({ address: dep.hook, abi: HOOK, functionName: "epochInfo" });
const [epochLength] = await uni.pub.readContract({ address: dep.hook, abi: HOOK, functionName: "config" });
console.log(`deployer ${account.address}\npoolId ${poolId}\nepoch ends ${new Date(Number(end) * 1000).toISOString()}, length ${epochLength}s`);

console.log("1. OorkaPulse on Reactive Network", lasna.id);
const pHash = await lasna.wallet.deployContract({
  abi: Pulse.abi,
  bytecode: Pulse.bytecode.object,
  args: [BigInt(uni.id), dep.poolManager, dep.hook, poolId, BigInt(epochLength), end, COOLDOWN],
  value: PULSE_FUNDING,
  ...lasnaFees,
});
const pulse = (await wait(lasna, pHash, "OorkaPulse")).contractAddress;

console.log("2. Pulse keeper on", uni.id);
const kHash = await uni.wallet.deployContract({
  abi: Keeper.abi,
  bytecode: Keeper.bytecode.object,
  args: [dep.callbackProxy, pulse, dep.hook, true],
  value: KEEPER_FUNDING,
});
const keeper = (await wait(uni, kHash, "OorkaKeeper (pulse)")).contractAddress;

console.log("3. point Pulse at its keeper");
await wait(
  lasna,
  await lasna.wallet.writeContract({ address: pulse, abi: Pulse.abi, functionName: "setKeeper", args: [keeper], ...lasnaFees }),
  "setKeeper",
);

dep.pulse = {
  chainId: lasna.id,
  contract: pulse,
  keeper,
  poolId,
  cooldown: Number(COOLDOWN),
  deployTx: pHash,
};
fs.writeFileSync(depFile, JSON.stringify(dep, null, 2));
console.log(`\nwrote ${depFile}\n  pulse  ${pulse}\n  keeper ${keeper}`);
