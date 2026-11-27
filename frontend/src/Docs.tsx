import { useEffect } from "react";
import { REPO_URL } from "./lib/site";
import { ArchitectureFig, ReactiveSeqFig, SettleFlowFig, TwapChart, VaultVsBenchChart } from "./Figures";

const SECTIONS: [string, string][] = [
  ["overview", "Overview"],
  ["probes", "Probe positions"],
  ["scoring", "Scoring"],
  ["takeover", "Takeover"],
  ["fee", "Performance fee"],
  ["defences", "Defences"],
  ["keeper", "Keeper-free settlement"],
  ["contracts", "Contracts"],
  ["run", "Run it"],
  ["limits", "Known limits"],
];

export default function Docs() {
  // support deep links like #/docs#fee
  useEffect(() => {
    const go = () => {
      const anchor = window.location.hash.split("#")[2];
      if (anchor) document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth" });
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, []);

  return (
    <main className="wrap docs">
      <nav className="toc" aria-label="On this page">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#/docs#${id}`}>
            {label}
          </a>
        ))}
      </nav>

      <article className="doc">
        <div className="eyebrow">Docs</div>
        <h1>How Oorka works</h1>
        <p>
          Oorka is one Uniswap v4 hook that is also an ERC-20 LP vault and a curator registry. The right to manage the
          vault's liquidity, the <em>seat</em>, is contested on-chain and handed to whoever measurably performs best.
        </p>

        <h2 id="overview">Overview</h2>
        <ul>
          <li>
            <strong>Depositors</strong> put tETH/tUSD into the vault and get oLP shares. Their liquidity sits at the seat
            holder's range.
          </li>
          <li>
            <strong>Curators</strong> post a bond and declare a range. The first curator holds the seat. Everyone else
            challenges.
          </li>
          <li>
            <strong>Epochs</strong> end on a timer. <code>settleEpoch()</code> is permissionless: it scores everyone,
            updates win streaks, pays the seat holder's fee and hands over the seat if earned.
          </li>
          <li>
            <strong>A benchmark</strong> is a passive range that never moves and can never win. Every epoch reports the
            vault against it.
          </li>
        </ul>
        <ArchitectureFig />

        <h2 id="probes">Probe positions</h2>
        <p>
          v4 only tracks <code>feeGrowthInside</code> for ticks that hold liquidity. When a curator declares a range, the
          hook adds <code>1e9</code> units of liquidity there, under its own address with salt <code>bytes32(id)</code>.
          Now <code>StateLibrary.getFeeGrowthInside</code> returns real fee growth for that exact range, from the same
          swaps everyone else saw.
        </p>
        <div className="callout">
          A challenger risks only the bond and a few wei of dust. They never need the capital they'd manage.
        </div>

        <h2 id="scoring">Scoring</h2>
        <p>
          Each curator has a paper portfolio worth 1,000 tUSD when the range is declared. Its virtual liquidity
          <code>vL</code> is chosen so the position is worth exactly that NAV.
        </p>
        <pre>
          <code>{`fees     = (feeGrowthInside_now - feeGrowthInside_last) * vL / 2^128
position = amounts(vL, range, price)
NAV      = value(position + fees + cash, price)            // in tUSD
growth   = NAV_end / NAV_epochStart`}</code>
        </pre>
        <p>
          At settlement, <code>price</code> is the epoch's time-weighted average of block-open ticks
          (<code>settleSqrtPrice()</code>). The hook accumulates it in <code>beforeSwap</code>. A range change re-derives
          <code>vL</code> from the current NAV minus <code>switchCostBps</code>.
        </p>
        <TwapChart />

        <h2 id="takeover">Takeover</h2>
        <ol>
          <li>A challenger must be present for the whole epoch.</li>
          <li>A win means beating the seat holder's growth by more than <code>marginBps</code>.</li>
          <li>
            After <code>winStreak</code> wins in a row, the best qualifying challenger takes the seat. In the same
            transaction the hook pulls the vault's liquidity and redeploys it at the winner's range.
          </li>
          <li>
            The old seat holder loses <code>slashBps</code> of their bond, paid to depositors. Every streak resets.
          </li>
        </ol>
        <SettleFlowFig />

        <h2 id="fee">Performance fee</h2>
        <p>
          At each settlement, before any takeover, the seat holder is minted vault shares worth <code>perfFeeBps</code> of
          the value created above a hurdle:
        </p>
        <pre>
          <code>{`hurdle = max(1, benchmarkGrowth, highWaterSharePrice / epochStartSharePrice)
excess = (sharePrice - epochStartSharePrice * hurdle) * supply
fee    = excess * perfFeeBps / 10_000          // minted as oLP, no tokens leave the pool`}</code>
        </pre>
        <p>
          There's no fee on losses, none for matching the passive benchmark, and none for recovering an earlier drawdown.
          Depositors keep 90% of the outperformance at the deployed 10% rate. The tests check this.
        </p>
        <VaultVsBenchChart />

        <h2 id="defences">Defences</h2>
        <table>
          <thead>
            <tr>
              <th>Attack</th>
              <th>Defence</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Flash-push the price to inflate a NAV</td>
              <td>Live accounting uses the block-open price, snapshotted on each block's first swap</td>
            </tr>
            <tr>
              <td>Push the price across a block boundary, then settle</td>
              <td>Settlement uses the epoch's time-weighted average of block-open ticks</td>
            </tr>
            <tr>
              <td>Pump a range's fee growth with <code>donate()</code></td>
              <td>
                The hook claims <code>beforeDonate</code> and reverts with <code>DonationsDisabled</code>
              </td>
            </tr>
            <tr>
              <td>Deposit, withdraw or rebalance at a pushed price</td>
              <td>
                Vault actions revert if spot is more than <code>maxTickDeviation</code> ticks from the block-open price
              </td>
            </tr>
            <tr>
              <td>Flip ranges to chase fees</td>
              <td>
                Every change charges <code>switchCostBps</code> on the paper portfolio
              </td>
            </tr>
            <tr>
              <td>Join late on a lucky streak</td>
              <td>Only full-epoch participants are eligible</td>
            </tr>
            <tr>
              <td>Spam the leaderboard</td>
              <td>A bond is required, and there are at most 8 curators</td>
            </tr>
            <tr>
              <td>Push the price, then call the permissionless settle so a takeover rebalances into your sandwich</td>
              <td>The seat changes, but the vault only moves at an honest price. Otherwise the move waits for the next settle or <code>compound()</code></td>
            </tr>
            <tr>
              <td>Register and exit until settling runs out of gas</td>
              <td>Exited slots are reused, so at most 8 curators plus the benchmark are ever scored</td>
            </tr>
          </tbody>
        </table>

        <h2 id="keeper">Keeper-free settlement</h2>
        <p>
          <code>OorkaReactive</code> runs on Reactive Network (Lasna) and subscribes to a built-in CRON event. Every N
          ticks it asks Reactive's system contract for a callback to <code>OorkaKeeper</code> on the hook's chain. The
          keeper accepts only the Reactive callback proxy, and only when the injected sender is our own reactive
          contract. If the epoch has ended it calls <code>settleEpoch()</code>; otherwise it emits
          <code>Idle</code>. A failed settle is logged and retried on the next tick.
        </p>
        <p>
          The keeper has no special rights on the hook. A takeover settle uses under 1.5M gas, half the 3M callback
          budget.
        </p>
        <ReactiveSeqFig />

        <h2 id="contracts">Contracts</h2>
        <p>
          Live addresses for Unichain Sepolia and Reactive Lasna are in the{" "}
          <a href={`${REPO_URL}#live-deployment-unichain-sepolia--reactive-lasna`} target="_blank" rel="noreferrer">
            README
          </a>
          .
        </p>
        <pre>
          <code>{`contracts/src/OorkaHook.sol              hook + vault (ERC-20 shares) + curator registry
contracts/src/reactive/OorkaReactive.sol CRON subscriber on Reactive Network
contracts/src/reactive/OorkaKeeper.sol   callback contract that settles epochs
contracts/test/                          61 Foundry tests + 5 invariants`}</code>
        </pre>

        <h2 id="run">Run it</h2>
        <pre>
          <code>{`# local: anvil + deploy + dashboard, no wallet needed
./demo.sh

# against the live Unichain Sepolia deployment, with a browser wallet
cd frontend && npm install && npx vite --mode unichain

# tests
cd contracts && forge test`}</code>
        </pre>

        <h2 id="limits">Known limits</h2>
        <ul>
          <li>
            <strong>Wash trading.</strong> A curator could wash-trade to raise fee growth at their range. It costs the swap
            fee and price impact, and those fees go to real liquidity in that range. A production version would cap
            per-epoch fee credit.
          </li>
          <li>
            <strong>Contract size.</strong> The hook is 23,964 bytes, close to the 24,576-byte limit. New features belong in
            separate contracts.
          </li>
          <li>
            <strong>Test tokens.</strong> The testnet pool uses mintable mock tokens.
          </li>
        </ul>
      </article>
    </main>
  );
}
