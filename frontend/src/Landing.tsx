import { useEffect, useState } from "react";
import { IS_WALLET, addressUrl, chain, loadDeployments, type Deployments } from "./lib/chain";
import { REPO_URL } from "./lib/site";
import Dither from "./bits/Dither";
import { Bolt, Coin, Crown, Pin, Ruler, Shield, Spark, Trophy } from "./Stickers";

function useDeployments() {
  const [dep, setDep] = useState<Deployments | null>(null);
  useEffect(() => {
    loadDeployments().then(setDep).catch(() => setDep(null));
  }, []);
  return dep;
}

function CopyBox({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy-box"
      aria-label={`Copy: ${text}`}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      <span>git clone …/oorka</span>
      <span aria-hidden>{done ? "✓" : "⧉"}</span>
      <span className="visually-hidden" role="status">{done ? "Copied" : ""}</span>
    </button>
  );
}

export default function Landing() {
  const dep = useDeployments();

  return (
    <main>
      {/* ---------------------------------------------------------------- hero */}
      <section className="hero hero-under-nav wrap">
        <div className="hero-bg" aria-hidden>
          <Dither
            waveColor="#7c3aed"
            backgroundColor="#ffffff"
            ditherMode="bayer"
            colorNum={4}
            pixelSize={3}
            waveSpeed={0.035}
            waveFrequency={3}
            waveAmplitude={0.16}
            mouseEffect="erase"
            mouseRadius={0.3}
            scale={0.3}
          />
          <div className="hero-veil" />
        </div>
        <h1 className="display">
          The curator seat <Crown size={64} className="inline-sticker" /> is <em>earned</em>, on-chain.
        </h1>
        <p className="lede">
          Curators compete on real fees. The winner runs the vault. No vote, no trust.
        </p>
        <div className="cta-row">
          <CopyBox text="git clone https://github.com/debojyoti10CC/oorka" />
          <a className="btn primary lg" href="#/arena">
            Enter the arena ↗
          </a>
        </div>
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
        <div className="bento">
          <div className="yellow">
            <h3>What's in the hook</h3>
            <ul className="checks">
              <li>Dust probe positions at every declared range</li>
              <li>Paper NAVs scored on real v4 fee growth</li>
              <li>Automatic takeover and vault migration</li>
              <li>A fee only above the benchmark</li>
            </ul>
            <Crown size={88} className="corner" />
          </div>
          <div className="coral">
            <h3>Earn the seat, earn the fee.</h3>
            <p>
              The seat holder is paid 10% of the value created above a passive benchmark and the high-water mark. There's
              nothing for losses and nothing for doing what doing nothing would do.
            </p>
            <div className="viz" style={{ marginTop: 24 }}>
              <div>vault growth&nbsp;&nbsp;&nbsp;&nbsp;+1.73%</div>
              <div>benchmark&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+0.70%</div>
              <div className="ok">fee to seat&nbsp;&nbsp;&nbsp;&nbsp;10% of the excess</div>
            </div>
            <Coin size={80} className="corner" />
          </div>
          <div className="green">
            <h3>Hard to game. Nobody runs it.</h3>
            <p>Settlement prices at the epoch's average. Donations revert. A Reactive CRON contract settles epochs.</p>
            <div className="tiles">
              <div className="tile">
                <span className="box"><Shield size={64} /></span>
                TWAP
              </div>
              <div className="tile">
                <span className="box"><Bolt size={64} /></span>
                Reactive
              </div>
              <div className="tile">
                <span className="box"><Ruler size={64} /></span>
                Benchmark
              </div>
            </div>
          </div>
          <div className="blue wide">
            <h3>Proof, not a pitch deck.</h3>
            <p>
              Every score comes from v4's own feeGrowthInside at the declared ticks. Nobody self-reports a backtest; the
              pool measures the forward test.
            </p>
            <div className="viz" style={{ marginTop: 24, maxWidth: 560 }}>
              <div className="viz-bars">
                {[
                  ["Tight", 8, 30, "#13897A", "+1.80%"],
                  ["Mid", 4, 48, "#7B4FC9", "+1.10%"],
                  ["Wide", 2, 84, "#C2780F", "+0.74%"],
                  ["Bench", 0, 96, "#8a8a93", "+0.70%"],
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
            <Pin size={84} className="corner" />
          </div>
          <div className="lilac">
            <h3>Takeover, on time.</h3>
            <p>Beat the seat holder for two epochs and the vault's liquidity moves to your range in one transaction.</p>
            <Trophy size={92} className="corner" />
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- numbers */}
      <section className="section wrap">
        <div className="eyebrow">By the numbers</div>
        <div className="stats">
          <div className="stat">
            <div className="big accent">46</div>
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
