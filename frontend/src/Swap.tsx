import { useEffect, useMemo, useRef, useState } from "react";
import { maxUint256, type Address } from "viem";
import {
  ERC20_ABI,
  HOOK_ABI,
  IS_WALLET,
  MARKET_SLOT,
  SWAP_ABI,
  addressOf,
  loadDeployments,
  publicClient,
  readableError,
  send,
  txUrl,
  type Deployments,
} from "./lib/chain";
import { MAX_SQRT_PRICE_LIMIT, MIN_SQRT_PRICE_LIMIT, fmt, fromWad, sqrtPriceToPrice, tickToPrice, toWad } from "./lib/math";
import { colorOf, type CuratorRow } from "./Lanes";
import { useWallet } from "./lib/wallet";

type Side = "eth" | "usd"; // what you sell

/** PoolSwapTest returns a packed BalanceDelta: amount0 in the high 128 bits, amount1 in the low 128 bits. */
const unpack = (d: bigint) => ({ a0: BigInt.asIntN(128, d >> 128n), a1: BigInt.asIntN(128, d) });

export default function Swap() {
  const wallet = useWallet();
  const [dep, setDep] = useState<Deployments | null>(null);
  const [price, setPrice] = useState(0);
  const [curators, setCurators] = useState<CuratorRow[]>([]);
  const [vault, setVault] = useState<{ lower: number; upper: number } | null>(null);
  const [bal, setBal] = useState<{ eth: bigint; usd: bigint } | null>(null);
  const [sell, setSell] = useState<Side>("eth");
  const [amount, setAmount] = useState("1");
  const [quote, setQuote] = useState<{ out: bigint; forIn: string; side: Side } | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "err"; tx?: string } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const quoteSeq = useRef(0);

  const me: Address | null = IS_WALLET ? wallet : addressOf(MARKET_SLOT);
  // quotes are eth_calls from an account that already holds tokens and approvals, so anyone can see a real quote
  const quoter: Address | null = dep ? ((dep as any).deployer ?? addressOf(MARKET_SLOT)) : null;
  const key = dep ? { currency0: dep.token0, currency1: dep.token1, fee: dep.fee, tickSpacing: dep.tickSpacing, hooks: dep.hook } : null;

  useEffect(() => {
    loadDeployments().then(setDep).catch((e) => setLoadErr(String(e.message ?? e)));
  }, []);

  // pool state
  useEffect(() => {
    if (!dep) return;
    let stop = false;
    const read = async () => {
      try {
        const [sp, cs, vs] = await Promise.all([
          publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "refSqrtPrice" }),
          publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "getCurators" }),
          publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "vaultState" }),
        ]);
        if (stop) return;
        setPrice(sqrtPriceToPrice(sp as bigint));
        setCurators(
          (cs as any[]).map((r) => ({
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
          })),
        );
        const v = vs as any[];
        setVault({ lower: Number(v[0]), upper: Number(v[1]) });
      } catch {
        /* keep last values */
      }
    };
    read();
    const id = setInterval(read, IS_WALLET ? 8000 : 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [dep]);

  // balances
  const readBalances = async () => {
    if (!dep || !me) return setBal(null);
    const [eth, usd] = await Promise.all([
      publicClient.readContract({ address: dep.token0, abi: ERC20_ABI, functionName: "balanceOf", args: [me] }),
      publicClient.readContract({ address: dep.token1, abi: ERC20_ABI, functionName: "balanceOf", args: [me] }),
    ]);
    setBal({ eth: eth as bigint, usd: usd as bigint });
  };
  useEffect(() => {
    readBalances().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep, me]);

  // exact quote, debounced
  const amountWad = useMemo(() => {
    try {
      return toWad(amount);
    } catch {
      return null;
    }
  }, [amount]);
  useEffect(() => {
    setQuote(null);
    setQuoteErr(null);
    if (!dep || !key || !quoter || !amountWad || amountWad === 0n) return;
    const seq = ++quoteSeq.current;
    setQuoting(true);
    const t = setTimeout(async () => {
      try {
        const zeroForOne = sell === "eth";
        const { result } = await publicClient.simulateContract({
          account: quoter,
          address: dep.swapRouter,
          abi: SWAP_ABI,
          functionName: "swap",
          args: [
            key,
            { zeroForOne, amountSpecified: -amountWad, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT },
            { takeClaims: false, settleUsingBurn: false },
            "0x",
          ],
        } as any);
        if (seq !== quoteSeq.current) return;
        const { a0, a1 } = unpack(result as bigint);
        const out = zeroForOne ? a1 : a0;
        setQuote({ out: out > 0n ? out : -out, forIn: amount, side: sell });
      } catch (e) {
        if (seq === quoteSeq.current) setQuoteErr("No quote for that size. The pool may not have enough depth.");
      } finally {
        if (seq === quoteSeq.current) setQuoting(false);
      }
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep, amountWad, sell, quoter]);

  const inSym = sell === "eth" ? "tETH" : "tUSD";
  const outSym = sell === "eth" ? "tUSD" : "tETH";
  const inBal = bal ? (sell === "eth" ? bal.eth : bal.usd) : null;
  const outNum = quote ? fromWad(quote.out) : 0;
  const inNum = Number(amount) || 0;
  const execPrice = quote && inNum > 0 ? (sell === "eth" ? outNum / inNum : inNum / outNum) : 0;
  const impact = execPrice && price ? (sell === "eth" ? (price - execPrice) / price : (execPrice - price) / price) : 0;
  const insufficient = inBal !== null && amountWad !== null && amountWad > inBal;

  const inRange = curators.filter((c) => c.active && price >= tickToPrice(c.lower) && price <= tickToPrice(c.upper));
  const outRange = curators.filter((c) => c.active && !(price >= tickToPrice(c.lower) && price <= tickToPrice(c.upper)));

  const run = async (label: string, fn: () => Promise<{ text: string; tx?: string }>) => {
    setBusy(label);
    setToast(null);
    try {
      const r = await fn();
      setToast({ tone: "ok", ...r });
    } catch (e) {
      setToast({ text: readableError(e), tone: "err" });
    } finally {
      setBusy(null);
      readBalances().catch(() => {});
    }
  };

  const faucet = () =>
    run("Minting test tokens", async () => {
      if (!dep || !me) throw new Error("Connect a wallet first.");
      await send(MARKET_SLOT, { address: dep.token0, abi: ERC20_ABI, functionName: "mint", args: [me, toWad("100")] });
      const r = await send(MARKET_SLOT, { address: dep.token1, abi: ERC20_ABI, functionName: "mint", args: [me, toWad("300000")] });
      return { text: "Minted 100 tETH and 300,000 tUSD to your wallet.", tx: r.transactionHash };
    });

  const doSwap = () =>
    run("Swapping", async () => {
      if (!dep || !key || !me || !amountWad) throw new Error("Connect a wallet first.");
      const token = sell === "eth" ? dep.token0 : dep.token1;
      const allowance = (await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [me, dep.swapRouter] })) as bigint;
      if (allowance < amountWad) await send(MARKET_SLOT, { address: token, abi: ERC20_ABI, functionName: "approve", args: [dep.swapRouter, maxUint256] });
      const zeroForOne = sell === "eth";
      const r = await send(MARKET_SLOT, {
        address: dep.swapRouter,
        abi: SWAP_ABI,
        functionName: "swap",
        args: [
          key,
          { zeroForOne, amountSpecified: -amountWad, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT },
          { takeClaims: false, settleUsingBurn: false },
          "0x",
        ],
      });
      return { text: `Swapped ${amount} ${inSym} for about ${fmt(outNum, sell === "eth" ? 2 : 4)} ${outSym}. Every in-range curator just earned fees on it.`, tx: r.transactionHash };
    });

  if (!dep)
    return (
      <main className="boot">
        <h1 className="wordmark">Swap</h1>
        <p>{loadErr ?? "Connecting…"}</p>
      </main>
    );

  const noSigner = IS_WALLET && !wallet;
  const action = noSigner
    ? { label: "Connect a wallet to swap (top right)", disabled: true }
    : insufficient
      ? { label: `Not enough ${inSym}`, disabled: true }
      : !amountWad || amountWad === 0n
        ? { label: "Enter an amount", disabled: true }
        : { label: `Swap ${inSym} for ${outSym}`, disabled: !quote || !!busy };

  return (
    <main className="app swap-page">
      <header className="swap-head">
        <h1 className="wordmark">Swap</h1>
        <p className="tagline">Trade tETH and tUSD through the Oorka pool. Every swap is fee growth the hook uses to score curators.</p>
      </header>

      <div className="swap-grid">
        <section className="swap-card" aria-label="Swap">
          <div className="swap-box">
            <div className="swap-row-top">
              <label htmlFor="swap-in">You sell</label>
              {inBal !== null && (
                <button className="link-btn" onClick={() => setAmount(fromWad(inBal).toString())} disabled={inBal === 0n}>
                  Balance {fmt(fromWad(inBal), sell === "eth" ? 4 : 2)} · Max
                </button>
              )}
            </div>
            <div className="swap-row">
              <input
                id="swap-in"
                className="swap-amount"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                aria-invalid={amountWad === null || insufficient}
                onChange={(e) => setAmount(e.target.value)}
              />
              <span className="token">{inSym}</span>
            </div>
          </div>

          <button
            className="swap-flip"
            aria-label={`Switch to selling ${outSym}`}
            onClick={() => {
              setSell(sell === "eth" ? "usd" : "eth");
              if (quote) setAmount(fromWad(quote.out).toFixed(sell === "eth" ? 2 : 4));
            }}
          >
            ↓↑
          </button>

          <div className="swap-box">
            <div className="swap-row-top">
              <span>You receive</span>
              {quoting && <span className="muted small">Quoting…</span>}
            </div>
            <div className="swap-row">
              <output className="swap-amount out" aria-live="polite">
                {quote ? fmt(outNum, sell === "eth" ? 2 : 4) : "–"}
              </output>
              <span className="token">{outSym}</span>
            </div>
          </div>

          <dl className="swap-facts">
            <div>
              <dt>Rate</dt>
              <dd>{execPrice ? `1 tETH = ${fmt(execPrice, 2)} tUSD` : "–"}</dd>
            </div>
            <div>
              <dt>Price impact (incl. fee)</dt>
              <dd className={impact > 0.01 ? "warn" : ""}>{quote ? `${(Math.max(0, impact) * 100).toFixed(2)}%` : "–"}</dd>
            </div>
            <div>
              <dt>LP fee</dt>
              <dd>{(dep.fee / 10_000).toFixed(2)}%, paid to in-range liquidity</dd>
            </div>
            <div>
              <dt>Quote</dt>
              <dd>Exact, simulated against the live pool</dd>
            </div>
          </dl>
          {quoteErr && <p className="status err">{quoteErr}</p>}

          <button className="primary swap-cta" aria-busy={busy === "Swapping"} disabled={action.disabled || !!busy} onClick={doSwap}>
            {action.label}
          </button>
          {!noSigner && (
            <button className="ghost swap-faucet" aria-busy={busy === "Minting test tokens"} disabled={!!busy} onClick={faucet}>
              Get test tokens
            </button>
          )}
          <p className={`status ${toast?.tone ?? "idle"}`} role="status">
            {busy ? `${busy}…` : toast?.text}
            {toast?.tx && txUrl(toast.tx) && (
              <>
                {" "}
                <a href={txUrl(toast.tx)} target="_blank" rel="noreferrer">
                  View transaction
                </a>
              </>
            )}
          </p>
        </section>

        <aside className="panel swap-side">
          <h2>Where your swap goes</h2>
          <div className="figures">
            <div className="figure">
              <span className="muted small">Pool price</span>
              <strong>{fmt(price, 2)}</strong>
            </div>
            <div className="figure">
              <span className="muted small">Vault range</span>
              <strong>{vault ? `${fmt(tickToPrice(vault.lower), 0)}–${fmt(tickToPrice(vault.upper), 0)}` : "–"}</strong>
            </div>
          </div>
          <p className="muted small">
            Fees go to liquidity whose range contains the price. Each curator's probe sits there too, so this swap is
            scored into every in-range curator's paper portfolio.
          </p>
          <h3 className="side-h">Earning on this swap</h3>
          <ul className="range-list">
            {inRange.map((c) => (
              <li key={c.id}>
                <span className="dot" style={{ background: colorOf(c) }} />
                {c.name}
                {c.incumbent && <span className="badge">seat</span>}
                {c.benchmark && <span className="badge soft">benchmark</span>}
                <span className="muted range">
                  {fmt(tickToPrice(c.lower), 0)}–{fmt(tickToPrice(c.upper), 0)}
                </span>
              </li>
            ))}
            {inRange.length === 0 && <li className="muted">No curator is in range right now.</li>}
          </ul>
          {outRange.length > 0 && (
            <>
              <h3 className="side-h">Out of range, earning nothing</h3>
              <ul className="range-list dim">
                {outRange.map((c) => (
                  <li key={c.id}>
                    <span className="dot" style={{ background: colorOf(c) }} />
                    {c.name}
                    <span className="muted range">
                      {fmt(tickToPrice(c.lower), 0)}–{fmt(tickToPrice(c.upper), 0)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <a className="btn" href="#/arena">
            See the arena →
          </a>
        </aside>
      </div>
    </main>
  );
}
