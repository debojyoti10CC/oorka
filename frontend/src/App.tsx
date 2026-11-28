import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeEventLog, maxUint256, type Address, type Hex } from "viem";
import {
  ACTORS,
  ERC20_ABI,
  HOOK_ABI,
  IS_WALLET,
  MARKET_SLOT,
  REFRESH_MS,
  SWAP_ABI,
  WETH_ABI,
  addressOf,
  addressUrl,
  chain,
  loadDeployments,
  publicClient,
  readableError,
  send,
  testClient,
  type Deployments,
} from "./lib/chain";
import {
  MAX_SQRT_PRICE_LIMIT,
  MIN_SQRT_PRICE_LIMIT,
  baseIndex,
  baseSym,
  decOf,
  digitsFor,
  fmt,
  fmtPct,
  fmtRange,
  fromT1,
  fromUnits,
  fromWad,
  pair,
  quoteSym,
  rangePrices,
  rangeToTicks,
  sqrtPriceToPrice,
  symOf,
  t1InQuote,
  toUnits,
} from "./lib/math";
import { Lanes, colorOf, type CuratorRow } from "./Lanes";
import { useWallet } from "./lib/wallet";

export type View = "arena" | "vault" | "curate";
const TITLES: Record<View, [string, string]> = {
  arena: ["Arena", "Every range scored on real swaps. The vault follows the winner."],
  vault: ["Vault", "Deposit once. The seat holder manages it."],
  curate: ["Curate", "Declare a range, post a bond, earn the seat."],
};

type Config = {
  epochLength: number;
  winStreak: number;
  marginBps: number;
  switchCostBps: number;
  slashBps: number;
  minBond: bigint;
  perfFeeBps: number;
};

type Snapshot = {
  price: number;
  settlePrice: number;
  curators: CuratorRow[];
  vault: { lower: number; upper: number; liquidity: bigint; idle0: bigint; idle1: bigint; nav: bigint; supply: bigint };
  epoch: { current: number; start: number; end: number; now: number; fetchedAt: number };
  me: { shares: bigint; b0: bigint; b1: bigint };
  config: Config;
  // growth multipliers, 1 = flat
  bench: { vaultSince: number; vaultEpoch: number; benchSince: number; benchEpoch: number };
};

type LogItem = { key: string; block: bigint; text: string; tone?: "win" | "plain" };

export default function App({ view = "arena" }: { view?: View }) {
  const [dep, setDep] = useState<Deployments | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [actor, setActor] = useState<number>(ACTORS[0].slot);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [history, setHistory] = useState<Record<number, number[]>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const wallet = useWallet();
  const logCursor = useRef<bigint | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    loadDeployments().then(setDep).catch((e) => setLoadError(String(e.message ?? e)));
  }, []);

  const refresh = useCallback(async () => {
    if (!dep) return;
    try {
      const me = addressOf(actor);
      const [curators, vs, ei, sp, cfg, shares, eth, usd, br, ssp] = await Promise.all([
        publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "getCurators" }),
        publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "vaultState" }),
        publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "epochInfo" }),
        publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "refSqrtPrice" }),
        publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "config" }),
        publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "balanceOf", args: [me] }),
        publicClient.readContract({ address: dep.token0, abi: ERC20_ABI, functionName: "balanceOf", args: [me] }),
        publicClient.readContract({ address: dep.token1, abi: ERC20_ABI, functionName: "balanceOf", args: [me] }),
        publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "benchmarkReport" }),
        publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "settleSqrtPrice" }),
      ]);
      const b = br as bigint[];
      const v = vs as any[];
      const e = ei as any[];
      const c = cfg as any[];
      const rows: CuratorRow[] = (curators as any[]).map((r) => ({
        id: Number(r.id),
        owner: r.owner,
        name: r.name,
        lower: Number(r.lower),
        upper: Number(r.upper),
        nav: r.nav,
        epochStartNav: r.epochStartNav,
        epochGrowthWad: r.epochGrowthWad,
        bond: r.bond,
        streak: Number(r.streak),
        joinedEpoch: Number(r.joinedEpoch),
        active: r.active,
        incumbent: r.incumbent,
        benchmark: r.benchmark,
      }));
      setSnap({
        price: sqrtPriceToPrice(sp as bigint),
        settlePrice: sqrtPriceToPrice(ssp as bigint),
        curators: rows,
        vault: { lower: Number(v[0]), upper: Number(v[1]), liquidity: v[2], idle0: v[3], idle1: v[4], nav: v[5], supply: v[6] },
        epoch: { current: Number(e[0]), start: Number(e[1]), end: Number(e[2]), now: Number(e[3]), fetchedAt: Date.now() },
        me: { shares: shares as bigint, b0: eth as bigint, b1: usd as bigint },
        config: {
          epochLength: Number(c[0]),
          winStreak: Number(c[1]),
          marginBps: Number(c[2]),
          switchCostBps: Number(c[3]),
          slashBps: Number(c[4]),
          minBond: c[6],
          perfFeeBps: Number(c[7] ?? 0),
        },
        bench: { vaultSince: fromWad(b[0]), vaultEpoch: fromWad(b[1]), benchSince: fromWad(b[2]), benchEpoch: fromWad(b[3]) },
      });
      setHistory((h) => {
        const next = { ...h };
        for (const r of rows) {
          if (!r.active) continue;
          const val = fromT1(r.nav);
          const arr = next[r.id] ?? [];
          if (arr[arr.length - 1] !== val) next[r.id] = [...arr, val].slice(-60);
        }
        return next;
      });
      setLoadError(null);
    } catch (err) {
      setLoadError(readableError(err));
    }
  }, [dep, actor, wallet]);

  const logBusy = useRef(false);
  const refreshLog = useCallback(async () => {
    if (!dep || logBusy.current) return;
    logBusy.current = true;
    try {
      if (!IS_WALLET) {
        const events = await publicClient.getContractEvents({ address: dep.hook, abi: HOOK_ABI, fromBlock: 0n });
        setEvents(events);
        return;
      }
      // public RPCs cap getLogs at 1,000 blocks, so the first load reads the history from Blockscout's log API
      // (one request, no range cap), then each refresh only asks the RPC for the new blocks
      const head = await publicClient.getBlockNumber();
      const STEP = 900n;
      if (logCursor.current === null) {
        const history = await explorerLogs(dep.hook, BigInt(dep.deployBlock ?? 0), head);
        if (history) {
          setEvents(history.slice(-200));
          logCursor.current = head + 1n;
          return;
        }
      }
      let from = logCursor.current ?? (head > 3_000n ? head - 3_000n : 0n);
      const found: any[] = [];
      while (from <= head) {
        const to = from + STEP > head ? head : from + STEP;
        found.push(...(await publicClient.getContractEvents({ address: dep.hook, abi: HOOK_ABI, fromBlock: from, toBlock: to })));
        from = to + 1n;
      }
      logCursor.current = head + 1n;
      if (found.length) setEvents((prev) => [...prev, ...found].slice(-200));
    } catch {
      /* log is best-effort */
    } finally {
      logBusy.current = false;
    }
  }, [dep]);

  useEffect(() => {
    refresh();
    refreshLog();
    const id = setInterval(() => {
      refresh();
      refreshLog();
    }, REFRESH_MS);
    const clock = setInterval(() => tick((t) => t + 1), 1000);
    return () => {
      clearInterval(id);
      clearInterval(clock);
    };
  }, [refresh, refreshLog]);

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    setToast(null);
    try {
      const msg = await fn();
      if (msg) setToast({ text: msg, tone: "ok" });
    } catch (err) {
      setToast({ text: readableError(err), tone: "err" });
    } finally {
      setBusy(null);
      await refresh();
      await refreshLog();
    }
  };

  // ------------------------------------------------------------------ actions
  const poolKey = dep
    ? { currency0: dep.token0, currency1: dep.token1, fee: dep.fee, tickSpacing: dep.tickSpacing, hooks: dep.hook }
    : null;

  const simulateMarket = (mode: "range" | "up" | "down") =>
    run(mode === "range" ? "Trading in a range" : mode === "up" ? "Pumping" : "Dumping", async () => {
      if (!dep || !snap || !poolKey) return;
      let swaps = 0;
      const b = baseIndex();
      const q: 0 | 1 = b === 0 ? 1 : 0;
      const swapOnce = async (zeroForOne: boolean, amountSpecified: bigint) => {
        await send(MARKET_SLOT, {
          address: dep.swapRouter,
          abi: SWAP_ABI,
          functionName: "swap",
          args: [
            poolKey,
            {
              zeroForOne,
              amountSpecified,
              sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT,
            },
            { takeClaims: false, settleUsingBurn: false },
            "0x",
          ],
        });
        swaps++;
      };
      // trade sizes scale with the deployment's pool depth (tradeBase is in the base asset)
      const size = dep.tradeBase ?? 20;
      const baseAmt = (x: number) => toUnits(x.toFixed(decOf(b)), decOf(b));
      const quoteAmt = (x: number) => toUnits(x.toFixed(decOf(q)), decOf(q));
      // in wallet mode every swap is a wallet confirmation, so keep the bursts short
      const rounds = IS_WALLET ? 2 : 8;
      const pushes = IS_WALLET ? 3 : 10;
      const needBase = baseAmt(size * 2);
      const needQuote = quoteAmt(size * 2 * snap.price);
      await ensureFunds(MARKET_SLOT, b === 0 ? needBase : needQuote, b === 0 ? needQuote : needBase, dep.swapRouter);
      const sellBase = b === 0; // zeroForOne sells token0
      if (mode === "range") {
        // round trips: sell some of the base asset, then buy exactly that much back. Price wobbles, fees pile up.
        for (let i = 0; i < rounds; i++) {
          const amt = baseAmt(size * (0.5 + Math.random() * 0.5));
          if (i % 2 === 0) {
            await swapOnce(sellBase, -amt); // exact in: sell base
            await swapOnce(!sellBase, amt); // exact out: buy the same base back
          } else {
            await swapOnce(!sellBase, amt);
            await swapOnce(sellBase, -amt);
          }
          if (i % 2 === 1) await refresh();
        }
      } else {
        // trend: one-way flow, the price walks out of tight ranges
        for (let i = 0; i < pushes; i++) {
          const x = size * (0.2 + Math.random() * 0.2);
          if (mode === "down") await swapOnce(sellBase, -baseAmt(x)); // sell base
          else await swapOnce(!sellBase, -quoteAmt(x * snap.price)); // spend quote on base
          if (i % 3 === 2) await refresh();
        }
      }
      return `${swaps} swaps went through the pool.`;
    });

  const skipToEpochEnd = () =>
    run("Skipping time", async () => {
      if (!snap) return;
      const block = await publicClient.getBlock();
      const gap = Math.max(1, snap.epoch.end - Number(block.timestamp) + 1);
      await testClient.increaseTime({ seconds: gap });
      await testClient.mine({ blocks: 1 });
      return "Time moved to the end of the epoch. You can settle now.";
    });

  const settle = () =>
    run("Settling epoch", async () => {
      if (!dep) return;
      const before = snap?.curators.find((c) => c.incumbent)?.id;
      await send(actor, { address: dep.hook, abi: HOOK_ABI, functionName: "settleEpoch" });
      const inc = (await publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "incumbentId" })) as bigint;
      const after = snap?.curators.find((c) => c.id === Number(inc));
      if (before !== undefined && Number(inc) !== before)
        return `Takeover. ${after?.name} won the seat and the vault moved to their range.`;
      return "Epoch settled. Scores and streaks updated.";
    });

  /**
   * Make sure `slot` holds `need0`/`need1` of the pool's tokens and has approved `spender`. Test tokens are minted;
   * real tokens can't be, so WETH is wrapped from ETH and anything else points at its faucet.
   */
  const ensureFunds = async (slot: number, need0: bigint, need1: bigint, spender?: Address) => {
    if (!dep) return;
    const who = addressOf(slot);
    const to = spender ?? dep.hook;
    const legs: [0 | 1, Address, bigint][] = [
      [0, dep.token0, need0],
      [1, dep.token1, need1],
    ];
    for (const [i, token, need] of legs) {
      if (need === 0n) continue;
      const bal = (await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [who] })) as bigint;
      if (bal < need) {
        if (pair().mintable) {
          await send(slot, { address: token, abi: ERC20_ABI, functionName: "mint", args: [who, need * 10n] });
        } else if (dep.weth && token.toLowerCase() === dep.weth.toLowerCase()) {
          await send(slot, { address: token, abi: WETH_ABI as any, functionName: "deposit", args: [], value: need - bal });
        } else {
          const sym = symOf(i);
          const faucet = dep.faucets?.[sym];
          throw new Error(
            `You need ${fmt(fromUnits(need - bal, decOf(i)), digitsFor(sym))} more ${sym}.` +
              (faucet ? ` Get testnet ${sym} free at ${faucet}.` : ""),
          );
        }
      }
      const allowance = (await publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [who, to],
      })) as bigint;
      if (allowance < need) await send(slot, { address: token, abi: ERC20_ABI, functionName: "approve", args: [to, maxUint256] });
    }
  };

  // probe positions take a few wei of each token; this is a comfortable margin for that dust
  const dust = (i: 0 | 1) => 10n ** BigInt(Math.max(0, decOf(i) - 4));

  const register = (name: string, lowP: number, highP: number, bond: string) =>
    run("Entering the arena", async () => {
      if (!dep) return;
      const [lower, upper] = rangeToTicks(lowP, highP, dep.tickSpacing);
      const bondUnits = toUnits(bond, decOf(1));
      await ensureFunds(actor, dust(0), bondUnits + dust(1));
      await send(actor, { address: dep.hook, abi: HOOK_ABI, functionName: "register", args: [name, lower, upper, bondUnits] });
      return `${name} is in. Their paper portfolio starts at an index of 1,000 and is eligible from the next epoch.`;
    });

  const declare = (id: number, lowP: number, highP: number, isInc: boolean) =>
    run("Changing range", async () => {
      if (!dep) return;
      const [lower, upper] = rangeToTicks(lowP, highP, dep.tickSpacing);
      await ensureFunds(actor, dust(0), dust(1));
      await send(actor, { address: dep.hook, abi: HOOK_ABI, functionName: "declareRange", args: [BigInt(id), lower, upper] });
      return isInc ? "Range changed. The vault's liquidity moved with it." : "Range changed. Your paper portfolio paid the switch cost.";
    });

  const exit = (id: number) =>
    run("Exiting", async () => {
      if (!dep) return;
      await send(actor, { address: dep.hook, abi: HOOK_ABI, functionName: "exit", args: [BigInt(id)] });
      return "You left the arena. Bond returned.";
    });

  const deposit = (baseAmt: string, quoteAmt: string) =>
    run("Depositing", async () => {
      if (!dep) return;
      const b = baseIndex();
      const a0 = toUnits(b === 0 ? baseAmt : quoteAmt, decOf(0));
      const a1 = toUnits(b === 0 ? quoteAmt : baseAmt, decOf(1));
      await ensureFunds(actor, a0, a1);
      await send(actor, { address: dep.hook, abi: HOOK_ABI, functionName: "deposit", args: [a0, a1, 0n] });
      return "Deposited. Your liquidity is now managed by whoever holds the seat.";
    });

  const withdraw = (fraction: number) =>
    run("Withdrawing", async () => {
      if (!dep || !snap) return;
      const shares = (snap.me.shares * BigInt(Math.round(fraction * 1000))) / 1000n;
      if (shares === 0n) throw new Error("You have no vault shares to withdraw.");
      await send(actor, { address: dep.hook, abi: HOOK_ABI, functionName: "withdraw", args: [shares, 0n, 0n] });
      return "Withdrawn to your wallet.";
    });

  // ------------------------------------------------------------------ render
  if (!dep || !snap) {
    return (
      <main className="boot">
        <h1 className="wordmark">Oorka</h1>
        <p>{loadError ?? (IS_WALLET ? `Connecting to ${chain.name}…` : "Connecting to the local chain…")}</p>
        {loadError && !IS_WALLET && (
          <p className="muted">Start everything with <code>./demo.sh</code> from the repo root, then reload.</p>
        )}
      </main>
    );
  }

  const incumbent = snap.curators.find((c) => c.incumbent);
  const benchmark = snap.curators.find((c) => c.benchmark && c.active);
  const noSigner = IS_WALLET && !wallet;
  const log = events.map(describe).filter(Boolean).reverse().slice(0, 14) as LogItem[];
  const chainNow = snap.epoch.now + Math.floor((Date.now() - snap.epoch.fetchedAt) / 1000);
  const remaining = snap.epoch.end - chainNow;
  // the benchmark's owner is the zero address, which is also what a disconnected wallet reads as
  const mine = noSigner
    ? []
    : snap.curators.filter((c) => c.active && !c.benchmark && c.owner.toLowerCase() === addressOf(actor).toLowerCase());
  // the hook books value in token1; show it in the quote asset so every figure reads in one unit
  const navNum = t1InQuote(fromT1(snap.vault.nav), snap.price);
  const sharePrice = snap.vault.supply > 0n ? navNum / fromWad(snap.vault.supply) : 1;
  const myValue = fromWad(snap.me.shares) * sharePrice;
  const Q = quoteSym();
  const S1 = symOf(1);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <h1 className="wordmark">{TITLES[view][0]}</h1>
          <p className="tagline">{TITLES[view][1]}</p>
        </div>
        <dl className="vitals">
          <div title={`Epochs settle at the time-weighted average price, now ${fmt(snap.settlePrice, 2)}.`}>
            <dt>{baseSym()} price</dt>
            <dd>{fmt(snap.price, 2)}</dd>
          </div>
          <div>
            <dt>Epoch {snap.epoch.current}</dt>
            <dd className={remaining <= 0 ? "ready" : ""}>{remaining <= 0 ? "ready to settle" : `${mmss(remaining)} left`}</dd>
          </div>
          <div>
            <dt>Seat holder</dt>
            <dd style={{ color: incumbent ? colorOf(incumbent) : undefined }}>{incumbent?.name ?? "nobody"}</dd>
          </div>
        </dl>
        {!IS_WALLET && (
          <label className="actor">
            <span>Acting as</span>
            <select value={actor} onChange={(e) => setActor(Number(e.target.value))}>
              {ACTORS.map((a) => (
                <option key={a.slot} value={a.slot}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {view !== "arena" && <Status busy={busy} toast={toast} />}
      {view === "arena" && (
      <section className="panel arena-card">
        <Lanes curators={snap.curators} price={snap.price} vault={snap.vault} />
        <div className="controls">
          <div className="control-group">
            <span className="group-label">Market</span>
            <button aria-busy={busy === "Trading in a range"} disabled={!!busy || noSigner} onClick={() => simulateMarket("range")}>Trade in a range</button>
            <button aria-busy={busy === "Pumping"} disabled={!!busy || noSigner} onClick={() => simulateMarket("up")}>Pump</button>
            <button aria-busy={busy === "Dumping"} disabled={!!busy || noSigner} onClick={() => simulateMarket("down")}>Dump</button>
          </div>
          <div className="control-group">
            {!IS_WALLET && (
              <button aria-busy={busy === "Skipping time"} disabled={!!busy} onClick={skipToEpochEnd}>Skip to epoch end</button>
            )}
            <button className="primary" aria-busy={busy === "Settling epoch"} disabled={!!busy || remaining > 0 || noSigner} onClick={settle}>
              Settle epoch {snap.epoch.current}
            </button>
          </div>
        </div>
        {IS_WALLET && (dep.pulse || dep.reactive) && (
          <p className="muted small keeper-note">
            Settled automatically by{" "}
            <a href={addressUrl(dep.pulse?.keeper ?? dep.keeper ?? "")} target="_blank" rel="noreferrer">
              Oorka Pulse on Reactive Network
            </a>
            , seconds after each epoch ends. Real {symOf(0)} and {symOf(1)}, no mock tokens.
          </p>
        )}
        <Status busy={busy} toast={toast} />
      </section>
      )}

      <div className={view === "arena" ? "grid arena" : "grid flip"}>
        <div className="col">
        {view !== "vault" && (
        <section className="panel standings">
          <div className="panel-head">
            <h2>Standings</h2>
            <span className="muted small">
              Beat the seat by {snap.config.marginBps / 100}% for {snap.config.winStreak} epochs to take it
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Curator</th>
                <th>Range</th>
                <th className="num">Paper NAV</th>
                <th className="num">This epoch</th>
                <th>Streak</th>
                <th className="num">Bond</th>
              </tr>
            </thead>
            <tbody>
              {snap.curators
                .filter((c) => c.active)
                .sort((a, b) => Number(b.nav - a.nav))
                .map((c) => (
                  <tr key={c.id} className={c.incumbent ? "is-seat" : ""}>
                    <td>
                      <span className="dot" style={{ background: colorOf(c) }} />
                      {c.name}
                      {c.incumbent && <span className="badge">seat</span>}
                      {c.benchmark && <span className="badge soft">benchmark</span>}
                      {!c.incumbent && !c.benchmark && c.joinedEpoch >= snap.epoch.current && (
                        <span className="badge soft">qualifying</span>
                      )}
                    </td>
                    <td className="range">
                      {fmtRange(c.lower, c.upper)}
                    </td>
                    <td className="num">
                      <Spark values={history[c.id] ?? []} color={colorOf(c)} />
                      {fmt(fromT1(c.nav), 2)}
                    </td>
                    <td className="num">{fmtPct(fromWad(c.epochGrowthWad) - 1, 3)}</td>
                    <td>
                      {c.incumbent ? (
                        <span className="muted">defending</span>
                      ) : c.benchmark ? (
                        <span className="muted">passive</span>
                      ) : (
                        <Pips filled={c.streak} total={snap.config.winStreak} color={colorOf(c)} />
                      )}
                    </td>
                    <td className="num">{c.benchmark ? "–" : `${fmt(fromT1(c.bond), digitsFor(S1))} ${S1}`}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
        )}

        {view !== "curate" && (
        <section className="panel log">
          <h2>On-chain record</h2>
          {log.length === 0 && <p className="muted small">Nothing yet.</p>}
          <ol>
            {log.map((l) => (
              <li key={l.key} className={l.tone === "win" ? "win" : ""}>
                <span className="blk">#{l.block.toString()}</span>
                {l.text}
              </li>
            ))}
          </ol>
        </section>
        )}
        </div>
        {view !== "arena" && (
        <div className="col">
        {view === "vault" && (
        <section className="panel">
          <h2>Vault</h2>
          <div className="figures">
            <Figure label="Total value" value={`${fmt(navNum, 2)} ${Q}`} />
            <Figure label="Share price" value={`${fmt(sharePrice, 4)} ${Q}`} />
            <Figure label="Your position" value={`${fmt(myValue, 2)} ${Q}`} />
          </div>
          <p className="muted small">
            Managed by {incumbent?.name ?? "nobody"} at {fmtRange(snap.vault.lower, snap.vault.upper)} {Q} per {baseSym()}.
            {!noSigner && (
              <>
                {" "}Wallet: {fmt(fromUnits(snap.me.b0, decOf(0)), digitsFor(symOf(0)))} {symOf(0)},{" "}
                {fmt(fromUnits(snap.me.b1, decOf(1)), digitsFor(S1))} {S1}.
              </>
            )}
          </p>
          {benchmark && <BenchCompare bench={snap.bench} name={benchmark.name} />}
          <DepositForm busy={!!busy} onDeposit={deposit} tradeBase={dep.tradeBase ?? 1} price={snap.price} />
          <div className="row">
            <span className="muted small">Withdraw</span>
            {[0.25, 0.5, 1].map((f) => (
              <button key={f} className="ghost" disabled={!!busy || snap.me.shares === 0n} onClick={() => withdraw(f)}>
                {f * 100}%
              </button>
            ))}
          </div>
        </section>
        )}

        {view === "curate" && (
        <section className="panel">
          <h2>{mine.length ? "Your seat in the arena" : "Enter the arena"}</h2>
          {mine.length ? (
            mine.map((c) => (
              <RangeEditor key={c.id} c={c} price={snap.price} busy={!!busy} onDeclare={declare} onExit={exit} />
            ))
          ) : (
            <RegisterForm price={snap.price} busy={!!busy} minBond={fromT1(snap.config.minBond)} onRegister={register} />
          )}
          {noSigner && <p className="muted small">Connect a wallet (top right) to enter or manage a range.</p>}
        </section>
        )}
        </div>
        )}
      </div>

      <footer className="foot muted small">
        {IS_WALLET ? "Live on " + chain.name + " · " : "Local chain · "}
        <a href={addressUrl(dep.hook) || undefined} target="_blank" rel="noreferrer">
          hook <code>{dep.hook.slice(0, 6)}…{dep.hook.slice(-4)}</code>
        </a>
      </footer>
    </div>
  );

  function describe(ev: any): LogItem | null {
    const a = ev.args ?? {};
    const name = (id: bigint) => snap?.curators.find((c) => c.id === Number(id))?.name ?? `Curator ${id}`;
    const key = `${ev.transactionHash}-${ev.logIndex}`;
    const block = ev.blockNumber as bigint;
    switch (ev.eventName) {
      case "Takeover":
        return { key, block, tone: "win", text: `${name(a.newId)} took the seat from ${name(a.oldId)}. ${fmt(fromT1(a.slashed), digitsFor(symOf(1)))} ${symOf(1)} of bond went to depositors.` };
      case "EpochSettled":
        return { key, block, text: `Epoch ${a.epoch} settled. Seat holder returned ${fmtPct(fromWad(a.incumbentGrowthWad) - 1, 3)}.` };
      case "CuratorRegistered":
        return { key, block, text: `${a.name} entered at ${fmtRange(Number(a.lower), Number(a.upper))}.` };
      case "RangeDeclared":
        return { key, block, text: `${name(a.id)} moved to ${fmtRange(Number(a.lower), Number(a.upper))}.` };
      case "BenchmarkRegistered":
        return { key, block, text: `Benchmark set at ${fmtRange(Number(a.lower), Number(a.upper))}. It never moves.` };
      case "PerformanceFee":
        return {
          key,
          block,
          tone: "win",
          text: `${name(a.curatorId)} earned a ${fmt(t1InQuote(fromT1(a.value), snap?.price ?? 0), 4)} ${quoteSym()} performance fee for beating the benchmark.`,
        };
      case "BenchmarkScored": {
        const v = fromWad(a.vaultGrowthWad) - 1;
        const bm = fromWad(a.benchmarkGrowthWad) - 1;
        return {
          key,
          block,
          tone: v > bm ? "win" : "plain",
          text: `Epoch ${a.epoch} report: vault ${fmtPct(v, 3)} vs benchmark ${fmtPct(bm, 3)}.`,
        };
      }
      case "VaultMoveDeferred":
        return { key, block, text: `Price was being pushed at settlement, so the vault waits a block before following ${name(a.incumbentId)}.` };
      case "CuratorExited":
        return { key, block, text: `${name(a.id)} left the arena.` };
      case "Deposited":
        return { key, block, text: `Deposit of ${amounts(a.amount0, a.amount1)}.` };
      case "Withdrawn":
        return { key, block, text: `Withdrawal of ${amounts(a.amount0, a.amount1)}.` };
      default:
        return null;
    }
  }
}

// ---------------------------------------------------------------------- pieces
const amounts = (a0: bigint, a1: bigint) =>
  `${fmt(fromUnits(a0, decOf(0)), digitsFor(symOf(0)))} ${symOf(0)} and ${fmt(fromUnits(a1, decOf(1)), digitsFor(symOf(1)))} ${symOf(1)}`;
const LOG_API: Record<number, string> = { 1301: "https://unichain-sepolia.blockscout.com/api" };

/** The hook's events from an explorer log API, decoded like viem's getContractEvents. Null if unavailable. */
async function explorerLogs(address: Address, deployBlock: bigint, head: bigint): Promise<any[] | null> {
  const api = LOG_API[chain.id];
  if (!api) return null;
  // the last ~2 days is plenty for the record panel, and keeps the response under the API's 1,000-log page
  const from = head > 150_000n && head - 150_000n > deployBlock ? head - 150_000n : deployBlock;
  try {
    const res = await fetch(`${api}?module=logs&action=getLogs&address=${address}&fromBlock=${from}&toBlock=${head}`);
    const body = await res.json();
    if (!Array.isArray(body.result)) return body.message === "No logs found" ? [] : null;
    const out: any[] = [];
    for (const l of body.result) {
      try {
        const topics = (l.topics as (string | null)[]).filter(Boolean) as [Hex, ...Hex[]];
        const ev = decodeEventLog({ abi: HOOK_ABI, data: l.data as Hex, topics });
        out.push({ ...ev, blockNumber: BigInt(l.blockNumber), transactionHash: l.transactionHash, logIndex: Number(l.logIndex) });
      } catch {
        /* not one of ours (e.g. ERC-20 Transfer of vault shares) */
      }
    }
    return out;
  } catch {
    return null;
  }
}

function mmss(s: number) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function Status({ busy, toast }: { busy: string | null; toast: { text: string; tone: "ok" | "err" } | null }) {
  if (busy) return <p className="status busy" role="status">{busy}…</p>;
  if (toast) return <p className={`status ${toast.tone}`} role="status">{toast.text}</p>;
  return <p className="status idle" aria-hidden />;
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="figure">
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function BenchCompare({ bench, name }: { bench: Snapshot["bench"]; name: string }) {
  const rows = [
    { label: "Since start", v: bench.vaultSince - 1, b: bench.benchSince - 1 },
    { label: "This epoch", v: bench.vaultEpoch - 1, b: bench.benchEpoch - 1 },
  ];
  return (
    <div className="bench">
      <table>
        <thead>
          <tr>
            <th />
            <th className="num">Vault</th>
            <th className="num">Benchmark</th>
            <th className="num">Edge</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const edge = r.v - r.b;
            return (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className="num">{fmtPct(r.v, 3)}</td>
                <td className="num">{fmtPct(r.b, 3)}</td>
                <td className={`num edge ${edge > 0.000005 ? "pos" : edge < -0.000005 ? "neg" : ""}`}>{fmtPct(edge, 3)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">{name}: a passive wide range that never moves.</p>
    </div>
  );
}

function Pips({ filled, total, color }: { filled: number; total: number; color: string }) {
  return (
    <span className="pips" aria-label={`${filled} of ${total} wins`}>
      {Array.from({ length: total }).map((_, i) => (
        <span key={i} className="pip" style={{ background: i < filled ? color : undefined, borderColor: color }} />
      ))}
    </span>
  );
}

function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <span className="spark" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const w = 56;
  const h = 16;
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${max === min ? h / 2 : h - ((v - min) / (max - min)) * h}`)
    .join(" ");
  return (
    <svg className="spark" width={w} height={h} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} />
    </svg>
  );
}

function DepositForm({
  busy,
  onDeposit,
  tradeBase,
  price,
}: {
  busy: boolean;
  onDeposit: (baseAmt: string, quoteAmt: string) => void;
  tradeBase: number;
  price: number;
}) {
  const [baseAmt, setBase] = useState(String(tradeBase));
  const [quoteAmt, setQuote] = useState((tradeBase * (price || 1)).toFixed(2));
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onDeposit(baseAmt, quoteAmt);
      }}
    >
      <label>
        {baseSym()}
        <input inputMode="decimal" value={baseAmt} onChange={(e) => setBase(e.target.value)} />
      </label>
      <label>
        {quoteSym()}
        <input inputMode="decimal" value={quoteAmt} onChange={(e) => setQuote(e.target.value)} />
      </label>
      <button className="primary" disabled={busy}>Deposit</button>
    </form>
  );
}

function RegisterForm({
  price,
  busy,
  minBond,
  onRegister,
}: {
  price: number;
  busy: boolean;
  minBond: number;
  onRegister: (name: string, lo: number, hi: number, bond: string) => void;
}) {
  const [name, setName] = useState("Narrow Nina");
  const [width, setWidth] = useState(5);
  const [bond, setBond] = useState(String(pair().mintable ? Math.max(100, minBond) : minBond));
  const lo = price * (1 - width / 100);
  const hi = price * (1 + width / 100);
  return (
    <form
      className="form stack"
      onSubmit={(e) => {
        e.preventDefault();
        onRegister(name, lo, hi, bond);
      }}
    >
      <p className="muted small">Scored as a paper portfolio that starts at an index of 1,000. Only the bond is at risk.</p>
      <label>
        Curator name
        <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Range width: ±{width}%
        <input type="range" min={1} max={40} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
      </label>
      <p className="small">
        {fmt(lo, 0)} to {fmt(hi, 0)} {quoteSym()} per {baseSym()}
      </p>
      <label>
        Bond ({symOf(1)})
        <input inputMode="decimal" value={bond} onChange={(e) => setBond(e.target.value)} />
      </label>
      <button className="primary" disabled={busy || !name.trim()}>Enter the arena</button>
    </form>
  );
}

function RangeEditor({
  c,
  price,
  busy,
  onDeclare,
  onExit,
}: {
  c: CuratorRow;
  price: number;
  busy: boolean;
  onDeclare: (id: number, lo: number, hi: number, isInc: boolean) => void;
  onExit: (id: number) => void;
}) {
  const current = useMemo(() => {
    const [lo, hi] = rangePrices(c.lower, c.upper);
    return Math.round(((hi - lo) / 2 / price) * 100) || 5;
  }, [c, price]);
  const [width, setWidth] = useState(current);
  const ref = useRef(c.id);
  useEffect(() => {
    if (ref.current !== c.id) {
      ref.current = c.id;
      setWidth(current);
    }
  }, [c.id, current]);
  const lo = price * (1 - width / 100);
  const hi = price * (1 + width / 100);
  return (
    <div className="stack">
      <p>
        <span className="dot" style={{ background: colorOf(c) }} />
        <strong>{c.name}</strong> {c.incumbent ? "holds the seat. Moving your range moves the vault." : "is challenging."}
      </p>
      <p className="muted small">
        Now at {fmtRange(c.lower, c.upper)}. Moving costs the switch fee.
      </p>
      <label>
        New width: ±{width}% around {fmt(price, 0)}
        <input type="range" min={1} max={40} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
      </label>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => onDeclare(c.id, lo, hi, c.incumbent)}>
          Recenter range
        </button>
        {!c.incumbent && (
          <button className="ghost" disabled={busy} onClick={() => onExit(c.id)}>
            Exit and reclaim bond
          </button>
        )}
      </div>
    </div>
  );
}
