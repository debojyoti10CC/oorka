import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { maxUint256, type Address } from "viem";
import {
  ACTORS,
  ERC20_ABI,
  HOOK_ABI,
  MARKET_SLOT,
  SWAP_ABI,
  addressOf,
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
  fmt,
  fmtPct,
  fromWad,
  priceToTick,
  sqrtPriceToPrice,
  tickToPrice,
  toWad,
} from "./lib/math";
import { Lanes, colorOf, type CuratorRow } from "./Lanes";

type Config = {
  epochLength: number;
  winStreak: number;
  marginBps: number;
  switchCostBps: number;
  slashBps: number;
  minBond: bigint;
};

type Snapshot = {
  price: number;
  settlePrice: number;
  curators: CuratorRow[];
  vault: { lower: number; upper: number; liquidity: bigint; idle0: bigint; idle1: bigint; nav: bigint; supply: bigint };
  epoch: { current: number; start: number; end: number; now: number; fetchedAt: number };
  me: { shares: bigint; eth: bigint; usd: bigint };
  config: Config;
  // growth multipliers, 1 = flat
  bench: { vaultSince: number; vaultEpoch: number; benchSince: number; benchEpoch: number };
};

type LogItem = { key: string; block: bigint; text: string; tone?: "win" | "plain" };

export default function App() {
  const [dep, setDep] = useState<Deployments | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [actor, setActor] = useState<number>(ACTORS[0].slot);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [history, setHistory] = useState<Record<number, number[]>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
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
        me: { shares: shares as bigint, eth: eth as bigint, usd: usd as bigint },
        config: {
          epochLength: Number(c[0]),
          winStreak: Number(c[1]),
          marginBps: Number(c[2]),
          switchCostBps: Number(c[3]),
          slashBps: Number(c[4]),
          minBond: c[6],
        },
        bench: { vaultSince: fromWad(b[0]), vaultEpoch: fromWad(b[1]), benchSince: fromWad(b[2]), benchEpoch: fromWad(b[3]) },
      });
      setHistory((h) => {
        const next = { ...h };
        for (const r of rows) {
          if (!r.active) continue;
          const val = fromWad(r.nav);
          const arr = next[r.id] ?? [];
          if (arr[arr.length - 1] !== val) next[r.id] = [...arr, val].slice(-60);
        }
        return next;
      });
      setLoadError(null);
    } catch (err) {
      setLoadError(readableError(err));
    }
  }, [dep, actor]);

  const refreshLog = useCallback(async () => {
    if (!dep) return;
    try {
      const events = await publicClient.getContractEvents({ address: dep.hook, abi: HOOK_ABI, fromBlock: 0n });
      setEvents(events);
    } catch {
      /* log is best-effort */
    }
  }, [dep]);

  useEffect(() => {
    refresh();
    refreshLog();
    const id = setInterval(() => {
      refresh();
      refreshLog();
    }, 2500);
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
      if (mode === "range") {
        // round trips: sell some tETH, then buy exactly that much back. Price wobbles and returns, fees pile up.
        for (let i = 0; i < 8; i++) {
          const eth = toWad((15 + Math.random() * 25).toFixed(4));
          const sellFirst = i % 2 === 0;
          if (sellFirst) {
            await swapOnce(true, -eth); // exact in: sell tETH
            await swapOnce(false, eth); // exact out: buy the same tETH back
          } else {
            await swapOnce(false, eth);
            await swapOnce(true, -eth);
          }
          if (i % 2 === 1) await refresh();
        }
      } else {
        // trend: one-way flow, the price walks out of tight ranges
        for (let i = 0; i < 10; i++) {
          const eth = 4 + Math.random() * 4;
          const zeroForOne = mode === "down";
          const amount = zeroForOne ? toWad(eth.toFixed(4)) : toWad((eth * snap.price).toFixed(2));
          await swapOnce(zeroForOne, -amount);
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

  const ensureFunds = async (slot: number, needEth: bigint, needUsd: bigint) => {
    if (!dep) return;
    const who = addressOf(slot);
    for (const [token, need] of [
      [dep.token0, needEth],
      [dep.token1, needUsd],
    ] as [Address, bigint][]) {
      const bal = (await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [who] })) as bigint;
      if (bal < need) await send(slot, { address: token, abi: ERC20_ABI, functionName: "mint", args: [who, need * 10n] });
      const allowance = (await publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [who, dep.hook],
      })) as bigint;
      if (allowance < need) await send(slot, { address: token, abi: ERC20_ABI, functionName: "approve", args: [dep.hook, maxUint256] });
    }
  };

  const register = (name: string, lowP: number, highP: number, bond: string) =>
    run("Entering the arena", async () => {
      if (!dep) return;
      const lower = priceToTick(lowP, dep.tickSpacing, "floor");
      const upper = priceToTick(highP, dep.tickSpacing, "ceil");
      const bondWad = toWad(bond);
      await ensureFunds(actor, 10n ** 18n, bondWad + 10n ** 21n);
      await send(actor, { address: dep.hook, abi: HOOK_ABI, functionName: "register", args: [name, lower, upper, bondWad] });
      return `${name} is in. Their paper portfolio starts at 1,000 tUSD and is eligible from the next epoch.`;
    });

  const declare = (id: number, lowP: number, highP: number, isInc: boolean) =>
    run("Changing range", async () => {
      if (!dep) return;
      const lower = priceToTick(lowP, dep.tickSpacing, "floor");
      const upper = priceToTick(highP, dep.tickSpacing, "ceil");
      await ensureFunds(actor, 10n ** 18n, 10n ** 18n);
      await send(actor, { address: dep.hook, abi: HOOK_ABI, functionName: "declareRange", args: [BigInt(id), lower, upper] });
      return isInc ? "Range changed. The vault's liquidity moved with it." : "Range changed. Your paper portfolio paid the switch cost.";
    });

  const exit = (id: number) =>
    run("Exiting", async () => {
      if (!dep) return;
      await send(actor, { address: dep.hook, abi: HOOK_ABI, functionName: "exit", args: [BigInt(id)] });
      return "You left the arena. Bond returned.";
    });

  const deposit = (eth: string, usd: string) =>
    run("Depositing", async () => {
      if (!dep) return;
      const a0 = toWad(eth);
      const a1 = toWad(usd);
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
        <p>{loadError ?? "Connecting to the local chain…"}</p>
        {loadError && <p className="muted">Start everything with <code>./demo.sh</code> from the repo root, then reload.</p>}
      </main>
    );
  }

  const incumbent = snap.curators.find((c) => c.incumbent);
  const benchmark = snap.curators.find((c) => c.benchmark && c.active);
  const log = events.map(describe).filter(Boolean).reverse().slice(0, 14) as LogItem[];
  const chainNow = snap.epoch.now + Math.floor((Date.now() - snap.epoch.fetchedAt) / 1000);
  const remaining = snap.epoch.end - chainNow;
  const mine = snap.curators.filter((c) => c.active && c.owner.toLowerCase() === addressOf(actor).toLowerCase());
  const navNum = fromWad(snap.vault.nav);
  const sharePrice = snap.vault.supply > 0n ? navNum / fromWad(snap.vault.supply) : 1;
  const myValue = fromWad(snap.me.shares) * sharePrice;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <h1 className="wordmark">Oorka</h1>
          <p className="tagline">The vault's curator seat, contested on-chain.</p>
        </div>
        <dl className="vitals">
          <div>
            <dt>tETH price</dt>
            <dd>{fmt(snap.price, 2)}</dd>
          </div>
          <div title="Settlement scores at the epoch's time-weighted average of block-open prices, so a last-second push barely moves it.">
            <dt>Settles at (epoch avg)</dt>
            <dd>{fmt(snap.settlePrice, 2)}</dd>
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
      </header>

      <section className="stage">
        <div className="stage-head">
          <h2>The lanes</h2>
          <p className="muted">
            Every curator's declared range against the live price. A hatched bar is out of range and earning nothing. The
            outlined bar holds the seat, and the vault's real liquidity sits on the top lane.
          </p>
        </div>
        <Lanes curators={snap.curators} price={snap.price} vault={snap.vault} />
        <div className="controls">
          <div className="control-group">
            <span className="group-label">1. Move the market</span>
            <button disabled={!!busy} onClick={() => simulateMarket("range")}>Trade in a range</button>
            <button disabled={!!busy} onClick={() => simulateMarket("up")}>Pump tETH</button>
            <button disabled={!!busy} onClick={() => simulateMarket("down")}>Dump tETH</button>
          </div>
          <div className="control-group">
            <span className="group-label">2. Close the epoch</span>
            <button disabled={!!busy} onClick={skipToEpochEnd}>Skip to epoch end</button>
            <button className="primary" disabled={!!busy || remaining > 0} onClick={settle}>
              Settle epoch {snap.epoch.current}
            </button>
          </div>
        </div>
        <Status busy={busy} toast={toast} />
      </section>

      <div className="grid">
        <div className="col">
        <section className="panel standings">
          <h2>Standings</h2>
          <p className="muted small">
            Paper portfolios start at 1,000 tUSD. A challenger needs to beat the seat holder by {snap.config.marginBps / 100}% for{" "}
            {snap.config.winStreak} epochs in a row. Changing range costs {snap.config.switchCostBps / 100}%.
          </p>
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
                      {fmt(tickToPrice(c.lower), 0)} to {fmt(tickToPrice(c.upper), 0)}
                    </td>
                    <td className="num">
                      <Spark values={history[c.id] ?? []} color={colorOf(c)} />
                      {fmt(fromWad(c.nav), 2)}
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
                    <td className="num">{c.benchmark ? "–" : fmt(fromWad(c.bond), 0)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>

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
        </div>
        <div className="col">
        <section className="panel">
          <h2>Vault</h2>
          <div className="figures">
            <Figure label="Total value" value={`${fmt(navNum, 0)} tUSD`} />
            <Figure label="Share price" value={fmt(sharePrice, 4)} />
            <Figure label="Your position" value={`${fmt(myValue, 0)} tUSD`} />
          </div>
          <p className="muted small">
            Managed by {incumbent?.name ?? "nobody"} at {fmt(tickToPrice(snap.vault.lower), 0)} to{" "}
            {fmt(tickToPrice(snap.vault.upper), 0)}. Wallet: {fmt(fromWad(snap.me.eth), 2)} tETH, {fmt(fromWad(snap.me.usd), 0)} tUSD.
          </p>
          {benchmark && <BenchCompare bench={snap.bench} name={benchmark.name} />}
          <DepositForm busy={!!busy} onDeposit={deposit} />
          <div className="row">
            <span className="muted small">Withdraw</span>
            {[0.25, 0.5, 1].map((f) => (
              <button key={f} className="ghost" disabled={!!busy || snap.me.shares === 0n} onClick={() => withdraw(f)}>
                {f * 100}%
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>{mine.length ? "Your seat in the arena" : "Enter the arena"}</h2>
          {mine.length ? (
            mine.map((c) => (
              <RangeEditor key={c.id} c={c} price={snap.price} busy={!!busy} onDeclare={declare} onExit={exit} />
            ))
          ) : (
            <RegisterForm price={snap.price} busy={!!busy} minBond={fromWad(snap.config.minBond)} onRegister={register} />
          )}
        </section>
        </div>
      </div>

      <footer className="foot muted small">
        Local demo on anvil. Hook at <code>{dep.hook}</code>. Each curator's range carries a dust probe position so the
        PoolManager tracks fee growth at those exact ticks.
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
        return { key, block, tone: "win", text: `${name(a.newId)} took the seat from ${name(a.oldId)}. ${fmt(fromWad(a.slashed), 0)} tUSD of bond went to depositors.` };
      case "EpochSettled":
        return { key, block, text: `Epoch ${a.epoch} settled. Seat holder returned ${fmtPct(fromWad(a.incumbentGrowthWad) - 1, 3)}.` };
      case "CuratorRegistered":
        return { key, block, text: `${a.name} entered at ${fmt(tickToPrice(Number(a.lower)), 0)} to ${fmt(tickToPrice(Number(a.upper)), 0)}.` };
      case "RangeDeclared":
        return { key, block, text: `${name(a.id)} moved to ${fmt(tickToPrice(Number(a.lower)), 0)} to ${fmt(tickToPrice(Number(a.upper)), 0)}.` };
      case "BenchmarkRegistered":
        return { key, block, text: `Benchmark set at ${fmt(tickToPrice(Number(a.lower)), 0)} to ${fmt(tickToPrice(Number(a.upper)), 0)}. It never moves.` };
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
      case "CuratorExited":
        return { key, block, text: `${name(a.id)} left the arena.` };
      case "Deposited":
        return { key, block, text: `Deposit of ${fmt(fromWad(a.amount0), 2)} tETH and ${fmt(fromWad(a.amount1), 0)} tUSD.` };
      case "Withdrawn":
        return { key, block, text: `Withdrawal of ${fmt(fromWad(a.amount0), 2)} tETH and ${fmt(fromWad(a.amount1), 0)} tUSD.` };
      default:
        return null;
    }
  }
}

// ---------------------------------------------------------------------- pieces
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
      <p className="muted small">
        {name}: the same 1,000 tUSD paper portfolio as the curators, parked on a fixed wide range. If the contested seat
        isn't beating it, depositors would be better off passive.
      </p>
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

function DepositForm({ busy, onDeposit }: { busy: boolean; onDeposit: (eth: string, usd: string) => void }) {
  const [eth, setEth] = useState("5");
  const [usd, setUsd] = useState("15000");
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onDeposit(eth, usd);
      }}
    >
      <label>
        tETH
        <input inputMode="decimal" value={eth} onChange={(e) => setEth(e.target.value)} />
      </label>
      <label>
        tUSD
        <input inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} />
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
  const [bond, setBond] = useState(String(Math.max(100, minBond)));
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
      <p className="muted small">
        Pick a range. A dust-sized probe position goes there so the pool tracks fees for those exact ticks. Your score is
        what that range would have earned on 1,000 tUSD, with no capital at risk beyond the bond.
      </p>
      <label>
        Curator name
        <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Range width: ±{width}%
        <input type="range" min={1} max={40} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
      </label>
      <p className="small">
        {fmt(lo, 0)} to {fmt(hi, 0)} tUSD per tETH
      </p>
      <label>
        Bond (tUSD)
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
  const current = useMemo(() => Math.round(((tickToPrice(c.upper) - tickToPrice(c.lower)) / 2 / price) * 100) || 5, [c, price]);
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
        Now at {fmt(tickToPrice(c.lower), 0)} to {fmt(tickToPrice(c.upper), 0)}. Recentering around the current price costs
        the switch fee on your paper portfolio.
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
