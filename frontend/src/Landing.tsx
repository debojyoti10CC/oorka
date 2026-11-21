import { useEffect, useState } from "react";
import { HOOK_ABI, IS_WALLET, addressUrl, chain, loadDeployments, publicClient, type Deployments } from "./lib/chain";
import { fmt, sqrtPriceToPrice } from "./lib/math";
import { REPO_URL } from "./lib/site";

type Live = { price: number; settle: number; seat: string; left: number; block: bigint; epoch: number };

function useLive() {
  const [dep, setDep] = useState<Deployments | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    loadDeployments().then(setDep).catch((e) => setErr(String(e.message ?? e)));
  }, []);
  useEffect(() => {
    if (!dep) return;
    let stop = false;
    const read = async () => {
      try {
        const [sp, ssp, cs, ei, block] = await Promise.all([
          publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "refSqrtPrice" }),
          publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "settleSqrtPrice" }),
          publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "getCurators" }),
          publicClient.readContract({ address: dep.hook, abi: HOOK_ABI, functionName: "epochInfo" }),
          publicClient.getBlockNumber(),
        ]);
        const e = ei as bigint[];
        const seat = (cs as any[]).find((c) => c.incumbent)?.name ?? "nobody";
        if (!stop)
          setLive({
            price: sqrtPriceToPrice(sp as bigint),
            settle: sqrtPriceToPrice(ssp as bigint),
            seat,
            left: Number(e[2] - e[3]),
            block,
            epoch: Number(e[0]),
          });
      } catch (x) {
        if (!stop) setErr("Live data unavailable right now.");
      }
    };
    read();
    const id = setInterval(read, IS_WALLET ? 8000 : 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [dep]);
  return { dep, live, err };
}

const mmss = (s: number) => (s <= 0 ? "settling" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);

export default function Landing() {
  const { dep, live, err } = useLive();
  const network = IS_WALLET ? chain.name : "local anvil";

  return (
    <main>
      {/* ---------------------------------------------------------------- hero */}
      <section className="hero wrap">
        <a className="pill" href="#/arena">
          <span className="tag">Live</span> Uniswap v4 hook on {IS_WALLET ? chain.name : "your local chain"} →
        </a>
        <h1 className="display">
          The curator seat, <em>earned</em> on-chain.
        </h1>
        <p className="lede">
          Challengers prove their LP ranges with dust probe positions that Uniswap itself scores on real fee growth. The
          vault's liquidity follows whoever measurably wins. No keeper bot. No vote. No trust.
        </p>
        <div className="cta-row">
          <a className="btn primary lg" href="#/arena">
            Enter the arena →
          </a>
          <a className="btn lg" href="#/docs">
            How it works
          </a>
        </div>

        <div className="live" aria-live="polite">
          <div className="live-cell">
            <div className="k">
              <span className="pulse" aria-hidden /> tETH price
            </div>
            <div className="v accent">{live ? fmt(live.price, 2) : "…"}</div>
          </div>
          <div className="live-cell">
            <div className="k">Settles at (epoch avg)</div>
            <div className="v">{live ? fmt(live.settle, 2) : "…"}</div>
          </div>
          <div className="live-cell">
            <div className="k">Seat holder</div>
            <div className="v">{live?.seat ?? "…"}</div>
          </div>
          <div className="live-cell">
            <div className="k">Epoch {live?.epoch ?? ""}</div>
            <div className="v">{live ? mmss(live.left) : "…"}</div>
          </div>
          <div className="live-cell">
            <div className="k">Block</div>
            <div className="v">{live ? `#${live.block.toLocaleString("en-US")}` : "…"}</div>
          </div>
        </div>
        <p className="live-caption">
          {err ??
            (dep ? (
              <>
                Read live from the hook on {network}
                {addressUrl(dep.hook) && (
                  <>
                    {" · "}
                    <a href={addressUrl(dep.hook)} target="_blank" rel="noreferrer" className="mono">
                      {dep.hook.slice(0, 10)}…
                    </a>
                  </>
                )}
              </>
            ) : (
              "Connecting…"
            ))}
        </p>
      </section>

      {/* ---------------------------------------------------------------- how */}
      <section className="section wrap" id="how">
        <div className="eyebrow">How it works</div>
        <h2 className="h2">Managers prove it before they touch your money.</h2>
        <div className="steps">
          <div className="step">
            <span className="n">01 · Declare</span>
            <h3 className="h3">Post a bond, name a range.</h3>
            <p>
              The hook drops a 1e9-liquidity probe at your ticks. v4 now tracks fee growth there, so your strategy is
              measured on the same swaps as everyone else's.
            </p>
          </div>
          <div className="step">
            <span className="n">02 · Score</span>
            <h3 className="h3">A paper portfolio, marked honestly.</h3>
            <p>
              Each curator runs 1,000 tUSD of virtual liquidity: real fees plus real price exposure. It's marked at the
              epoch's time-weighted price and compared against a passive benchmark.
            </p>
          </div>
          <div className="step">
            <span className="n">03 · Take over</span>
            <h3 className="h3">The vault follows the winner.</h3>
            <p>
              Beat the seat holder for enough epochs in a row and the vault's real liquidity migrates to your range in
              the same transaction. The loser's bond is slashed to depositors.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- built on */}
      <div className="marquee" aria-label="Built on">
        <div className="marquee-label">Built on</div>
        <div className="marquee-track">
          {[0, 1].map((k) => (
            <div key={k} style={{ display: "flex", gap: 56 }} aria-hidden={k === 1}>
              {["Uniswap v4", "Unichain", "Reactive Network", "Foundry", "viem", "solmate", "React", "Lasna CRON"].map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ---------------------------------------------------------------- why */}
      <section className="section wrap" id="why">
        <div className="eyebrow">Why Oorka</div>
        <h2 className="h2">Curation as a competition that settles itself.</h2>
        <div className="features">
          <div className="feature">
            <div className="viz">
              <div className="viz-bars">
                {[
                  ["Tight", 8, 30, "#3FC1A5", "+1.80%"],
                  ["Mid", 4, 48, "#A98BF0", "+1.10%"],
                  ["Wide", 2, 84, "#E8A84E", "+0.74%"],
                  ["Bench", 0, 96, "#7d7d86", "+0.70%"],
                ].map(([n, l, w, c, g]) => (
                  <div className="viz-bar" key={n as string}>
                    <span>{n}</span>
                    <span className="track">
                      <span className="fill" style={{ left: `${l}%`, width: `${w}%`, background: c as string }} />
                    </span>
                    <span className="ok" style={{ textAlign: "right" }}>
                      {g}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <h3 className="h3">Proof, not a pitch deck.</h3>
            <p>
              Every score comes from v4's own feeGrowthInside at the declared ticks. Nobody self-reports a backtest; the
              pool measures the forward test.
            </p>
          </div>
          <div className="feature">
            <div className="viz">
              <div>vault growth&nbsp;&nbsp;&nbsp;&nbsp;<span className="hl">+1.73%</span></div>
              <div>hurdle = max(flat, benchmark, high-water)</div>
              <div>benchmark&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+0.70%</div>
              <div>excess&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+1.03%</div>
              <div className="ok">fee to seat&nbsp;&nbsp;&nbsp;&nbsp;10% of excess, in vault shares</div>
            </div>
            <h3 className="h3">Earn the seat, earn the fee.</h3>
            <p>
              The seat holder is paid only on value created above a passive benchmark and the high-water mark. There's
              nothing for losses, for doing what doing nothing would do, or for winning back a drawdown.
            </p>
          </div>
          <div className="feature">
            <div className="viz">
              <div>last-second push&nbsp;&nbsp;&nbsp;tick −8,090</div>
              <div>held for&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;12s of 600s</div>
              <div className="ok">settle tick&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0 (unmoved)</div>
              <div>donate()&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="hl">reverts</span></div>
              <div>vault actions&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;deviation-guarded</div>
            </div>
            <h3 className="h3">Built to resist gaming.</h3>
            <p>
              Settlement uses the epoch's time-weighted price, donations that would inflate fee growth are rejected, and
              every range change pays a switch cost.
            </p>
          </div>
          <div className="feature">
            <div className="viz">
              <div className="viz-chips">
                {["owner", "keeper bot", "oracle", "admin key", "governance vote"].map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
              <div style={{ marginTop: 16 }}>
                Reactive CRON <span className="hl">→</span> OorkaKeeper <span className="hl">→</span> settleEpoch()
              </div>
            </div>
            <h3 className="h3">Nobody runs it.</h3>
            <p>
              Settlement is permissionless and automated by a Reactive Network CRON contract. The keeper has no special
              rights; it only adds liveness.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- numbers */}
      <section className="section wrap">
        <div className="eyebrow">By the numbers</div>
        <div className="stats">
          <div className="stat">
            <div className="big accent">36</div>
            <p>Foundry tests passing in CI, from probe accounting to takeover via the Reactive keeper.</p>
          </div>
          <div className="stat">
            <div className="big">0</div>
            <p>Oracles, owners, admin keys or off-chain services. Pure v4 primitives.</p>
          </div>
          <div className="stat">
            <div className="big">1e9</div>
            <p>Liquidity per probe. That's dust, but enough to make v4 track fees at those ticks.</p>
          </div>
          <div className="stat">
            <div className="big">10%</div>
            <p>Seat holder's cut, paid only on gains above the benchmark and high-water mark.</p>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- compare */}
      <section className="section wrap">
        <div className="eyebrow">Compared</div>
        <h2 className="h2">Auctions sell the seat. Oorka makes you earn it.</h2>
        <div className="compare">
          <table>
            <thead>
              <tr>
                <th />
                <th>Typical vault manager</th>
                <th>Auction-managed AMM</th>
                <th className="us">Oorka</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Who gets the seat</td>
                <td>Whoever launched the vault</td>
                <td>Highest rent bidder</td>
                <td className="us">Best measured LP performance</td>
              </tr>
              <tr>
                <td>Evidence</td>
                <td>Self-reported backtest</td>
                <td>Willingness to pay</td>
                <td className="us">v4 fee growth at the declared ticks</td>
              </tr>
              <tr>
                <td>Replacing a bad manager</td>
                <td>Governance or withdraw</td>
                <td>Outbid them</td>
                <td className="us">Automatic after a win streak</td>
              </tr>
              <tr>
                <td>Manager pay</td>
                <td>Flat fee</td>
                <td>Keeps arbitrage</td>
                <td className="us">10% above benchmark + high-water</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------------------------------------------------------------- explore */}
      <section className="section wrap">
        <div className="eyebrow">Explore</div>
        <h2 className="h2">See it for yourself.</h2>
        <div className="explore">
          <a href="#/arena">
            <span className="n">01</span>
            <div className="t">
              Arena <span className="arrow">→</span>
            </div>
            <p>Live lanes, standings, the vault vs the benchmark, and the on-chain record.</p>
          </a>
          <a href="#/docs">
            <span className="n">02</span>
            <div className="t">
              Docs <span className="arrow">→</span>
            </div>
            <p>The mechanism, the math, every defence and how to run it.</p>
          </a>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            <span className="n">03</span>
            <div className="t">
              Source <span className="arrow">→</span>
            </div>
            <p>Hook, keeper, tests and this site, all open source.</p>
          </a>
          <a href={dep && addressUrl(dep.hook) ? addressUrl(dep.hook) : REPO_URL} target="_blank" rel="noreferrer">
            <span className="n">04</span>
            <div className="t">
              Contracts <span className="arrow">→</span>
            </div>
            <p>The live hook on {IS_WALLET ? chain.name : "the explorer"}, with every settlement on the record.</p>
          </a>
        </div>
      </section>
    </main>
  );
}
