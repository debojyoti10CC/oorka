// Measures Oorka Pulse's full loop on the live deployment:
//   origin swap on Unichain  ->  OorkaPulse.react() on Reactive Lasna (Triggered event)  ->  OorkaKeeper callback on Unichain
// For every Triggered event it prints the three transactions and the seconds between them, plus a summary.
//
//   node scripts/pulse-latency.mjs [--json out.json]
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, decodeEventLog, http, parseAbi, toHex } from "viem";

const dep = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "public/deployments.1301.json"), "utf8"));
if (!dep.pulse) throw new Error("no pulse deployment in deployments.1301.json");
const out = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;

const uni = createPublicClient({ transport: http(dep.rpcUrl, { retryCount: 4 }) });
const lasna = createPublicClient({ transport: http(dep.reactive?.rpcUrl ?? "https://lasna-rpc.rnk.dev/", { retryCount: 4 }) });
const BLOCKSCOUT = "https://unichain-sepolia.blockscout.com/api";

const PULSE = parseAbi([
  "event Triggered(uint8 indexed reason, uint256 indexed originBlock, uint256 originTx, uint256 request)",
]);
const KEEPER = parseAbi([
  "event Settled(uint256 indexed epoch)",
  "event SettleFailed(uint256 indexed epoch, bytes reason)",
  "event Compounded()",
  "event Idle(uint256 indexed epoch, uint256 secondsLeft)",
]);
const REASONS = ["epoch due", "vault move pending"];

// Lasna: Triggered logs, in chunks the RPC accepts
const lasnaHead = await lasna.getBlockNumber();
const deployRcpt = await lasna.getTransactionReceipt({ hash: dep.pulse.deployTx });
const triggers = [];
for (let from = deployRcpt.blockNumber; from <= lasnaHead; from += 5000n) {
  const to = from + 4999n > lasnaHead ? lasnaHead : from + 4999n;
  const logs = await lasna.getLogs({ address: dep.pulse.contract, event: PULSE[0], fromBlock: from, toBlock: to });
  triggers.push(...logs);
}

// Unichain: every callback the pulse keeper received (Blockscout serves the whole range in one call)
const url = `${BLOCKSCOUT}?module=logs&action=getLogs&address=${dep.pulse.keeper}&fromBlock=${dep.deployBlock}&toBlock=latest`;
const callbacks = (await (await fetch(url)).json()).result
  .map((l) => {
    const ev = decodeEventLog({ abi: KEEPER, data: l.data, topics: l.topics });
    return { event: ev.eventName, block: BigInt(l.blockNumber), time: Number(BigInt(l.timeStamp)), tx: l.transactionHash };
  })
  .sort((a, b) => Number(a.block - b.block));

const blockTime = new Map();
const tsOf = async (client, n) => {
  const k = `${client === uni ? "u" : "l"}${n}`;
  if (!blockTime.has(k)) blockTime.set(k, Number((await client.getBlock({ blockNumber: n })).timestamp));
  return blockTime.get(k);
};

const rows = [];
for (const t of triggers) {
  const originBlock = t.args.originBlock;
  const originTx = toHex(t.args.originTx, { size: 32 });
  const tOrigin = await tsOf(uni, originBlock);
  const tReact = await tsOf(lasna, t.blockNumber);
  const cb = callbacks.find((c) => c.block > originBlock && c.time >= tReact);
  rows.push({
    reason: REASONS[t.args.reason] ?? String(t.args.reason),
    originTx,
    reactiveTx: t.transactionHash,
    callbackTx: cb?.tx ?? null,
    callbackEvent: cb?.event ?? null,
    originToReactive: tReact - tOrigin,
    reactiveToCallback: cb ? cb.time - tReact : null,
    total: cb ? cb.time - tOrigin : null,
  });
}

for (const r of rows) {
  console.log(
    `${r.reason.padEnd(18)} total ${String(r.total ?? "?").padStart(3)}s  (origin->reactive ${r.originToReactive}s, reactive->callback ${r.reactiveToCallback ?? "?"}s)  ${r.callbackEvent ?? "pending"}`,
  );
  console.log(`  origin   ${r.originTx}\n  reactive ${r.reactiveTx}\n  callback ${r.callbackTx ?? "-"}`);
}
const done = rows.filter((r) => r.total != null).map((r) => r.total).sort((a, b) => a - b);
const summary = done.length
  ? {
      loops: done.length,
      min: done[0],
      median: done[Math.floor(done.length / 2)],
      max: done[done.length - 1],
      mean: Math.round((done.reduce((s, x) => s + x, 0) / done.length) * 10) / 10,
    }
  : { loops: 0 };
console.log("\nsummary (seconds, origin swap to callback):", summary);
if (out) fs.writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), summary, rows }, null, 2));
