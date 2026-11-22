import type { ReactNode } from "react";
// Docs figures, ported from the whitepaper (whitepaper/oorka-whitepaper.tex) as theme-aware inline SVG.
// Colors come from CSS classes in styles.css (.fig-*), so they follow the design tokens.

const Arrow = ({ id }: { id: string }) => (
  <defs>
    <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" className="fig-arrowhead" />
    </marker>
  </defs>
);

function Fig({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure className="fig">
      {children}
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ 1. architecture */
export function ArchitectureFig() {
  const actors = [
    ["Depositors", "deposit / withdraw", 70],
    ["Seat holder", "declareRange", 150],
    ["Challengers", "register + bond", 230],
  ] as const;
  return (
    <Fig caption="Architecture. The hook owns two kinds of positions inside the PoolManager, separated by salt: the vault (real capital at the seat holder's range) and a dust probe at every declared range. Reactive Network triggers settlement with no off-chain keeper.">
      <svg viewBox="0 0 880 400" role="img" aria-label="Oorka architecture: actors call OorkaHook, which owns vault and probe positions in the Uniswap v4 PoolManager; Reactive Network calls OorkaKeeper, which calls settleEpoch.">
        <Arrow id="a1" />
        {/* actors */}
        {actors.map(([t, s, y]) => (
          <g key={t}>
            <rect x="10" y={y - 26} width="150" height="52" rx="12" className="fig-box" />
            <text x="85" y={y - 4} className="fig-t" textAnchor="middle">{t}</text>
            <text x="85" y={y + 14} className="fig-s" textAnchor="middle">{s}</text>
            <line x1="160" y1={y} x2="290" y2={y} className="fig-line" markerEnd="url(#a1)" />
          </g>
        ))}
        <rect x="10" y="300" width="150" height="52" rx="12" className="fig-box" />
        <text x="85" y="322" className="fig-t" textAnchor="middle">Traders</text>
        <text x="85" y="340" className="fig-s" textAnchor="middle">swaps &amp; arbitrage</text>
        <path d="M160 326 H 705 V 296" className="fig-line" markerEnd="url(#a1)" fill="none" />
        <text x="430" y="318" className="fig-s" textAnchor="middle">swap</text>

        {/* hook */}
        <rect x="292" y="40" width="250" height="250" rx="18" className="fig-box accent" />
        <text x="417" y="68" className="fig-t accent" textAnchor="middle">OorkaHook</text>
        {["Curator registry & paper NAVs", "Vault shares (oLP) & idle", "Block-open price & epoch TWAP", "Benchmark & performance fee"].map((t, i) => (
          <g key={t}>
            <rect x="308" y={86 + i * 46} width="218" height="36" rx="9" className="fig-cell" />
            <text x="417" y={109 + i * 46} className="fig-s strong" textAnchor="middle">{t}</text>
          </g>
        ))}

        {/* pool manager */}
        <rect x="610" y="40" width="250" height="250" rx="18" className="fig-box" />
        <text x="735" y="68" className="fig-t" textAnchor="middle">v4 PoolManager</text>
        <rect x="626" y="86" width="218" height="52" rx="9" className="fig-cell vault" />
        <text x="735" y="108" className="fig-s strong" textAnchor="middle">Vault position</text>
        <text x="735" y="126" className="fig-s" textAnchor="middle">salt = 2²⁵⁶−1</text>
        <rect x="626" y="148" width="218" height="52" rx="9" className="fig-cell probe" />
        <text x="735" y="170" className="fig-s strong" textAnchor="middle">Probe positions</text>
        <text x="735" y="188" className="fig-s" textAnchor="middle">salt = curator id, L = 1e9</text>
        <rect x="626" y="210" width="218" height="40" rx="9" className="fig-cell" />
        <text x="735" y="235" className="fig-s" textAnchor="middle">Third-party LPs</text>

        {/* hook <-> pool */}
        <line x1="608" y1="100" x2="544" y2="100" className="fig-line" markerEnd="url(#a1)" />
        <text x="576" y="92" className="fig-s" textAnchor="middle">beforeSwap</text>
        <line x1="544" y1="160" x2="608" y2="160" className="fig-line" markerEnd="url(#a1)" />
        <text x="576" y="152" className="fig-s" textAnchor="middle">modify</text>
        <line x1="608" y1="220" x2="544" y2="220" className="fig-line" markerEnd="url(#a1)" />
        <text x="576" y="212" className="fig-s" textAnchor="middle">feeGrowth</text>

        {/* reactive */}
        <rect x="610" y="345" width="250" height="44" rx="12" className="fig-box violet" />
        <text x="735" y="372" className="fig-t" textAnchor="middle">Reactive CRON → OorkaReactive</text>
        <rect x="292" y="345" width="250" height="44" rx="12" className="fig-box violet" />
        <text x="417" y="372" className="fig-t" textAnchor="middle">OorkaKeeper</text>
        <line x1="608" y1="367" x2="544" y2="367" className="fig-line" markerEnd="url(#a1)" />
        <line x1="417" y1="343" x2="417" y2="292" className="fig-line" markerEnd="url(#a1)" />
        <text x="425" y="322" className="fig-s">settleEpoch</text>
      </svg>
    </Fig>
  );
}

/* ------------------------------------------------------------------ 2. settlement flow */
export function SettleFlowFig() {
  const steps: [string, string?][] = [
    ["settleEpoch()", "term"],
    ["Epoch over?  no → revert EpochNotOver", "decision"],
    ["P̄ ← epoch TWAP of block-open ticks"],
    ["For each curator: mark fees, Gᵢ = NAVᵢ(P̄) / NAVᵢ_start"],
    ["Emit BenchmarkScored(vault growth, G_bench)"],
    ["Pay seat holder φ of value above hurdle (new oLP)", "fee"],
    ["For each challenger: full epoch and Gᵢ > G_seat(1+m)?  yes → streak+1, no → streak = 0", "decision"],
    ["Any streak ≥ W?  yes → Takeover: slash bond, reset streaks, migrate vault", "takeover"],
    ["Roll baselines: NAV_start ← NAV(P̄), vault share price, high-water"],
    ["epoch ← epoch + 1", "term"],
  ];
  const h = 44,
    gap = 16;
  return (
    <Fig caption="Epoch settlement. Permissionless and deterministic; every quantity it uses is readable on-chain.">
      <svg viewBox={`0 0 760 ${steps.length * (h + gap) + 8}`} role="img" aria-label="Settlement flow: check epoch, compute TWAP, mark curators, report benchmark, pay fee, update streaks, take over if earned, roll baselines, advance epoch.">
        <Arrow id="a2" />
        {steps.map(([t, kind], i) => {
          const y = 4 + i * (h + gap);
          return (
            <g key={i}>
              <rect
                x="40"
                y={y}
                width="680"
                height={h}
                rx={kind === "term" ? 22 : kind === "decision" ? 4 : 10}
                className={`fig-box ${kind === "fee" ? "accent" : kind === "takeover" ? "accent strong" : kind === "decision" ? "dashed" : ""}`}
              />
              <text x="380" y={y + 27} className={`fig-s strong ${kind === "takeover" ? "accent" : ""}`} textAnchor="middle">
                {t}
              </text>
              {i < steps.length - 1 && <line x1="380" y1={y + h} x2="380" y2={y + h + gap - 2} className="fig-line" markerEnd="url(#a2)" />}
            </g>
          );
        })}
      </svg>
    </Fig>
  );
}

/* ------------------------------------------------------------------ 3. TWAP chart */
export function TwapChart() {
  // 60 s window: spot flat at tick 0, pushed to −8,100 for the last 0.2 s; TWAP drifts only to −27
  const X = (s: number) => 60 + (s / 60) * 640;
  const Y = (t: number) => 30 + ((0 - t) / 9000) * 220;
  const ticks = [0, -2000, -4000, -6000, -8000];
  return (
    <Fig caption="Why settlement uses the epoch TWAP. A last-block push moves spot by thousands of ticks, but the time-weighted settlement price barely moves.">
      <svg viewBox="0 0 740 300" role="img" aria-label="Chart: spot tick stays at 0 then drops to minus 8,100 in the last block, while the TWAP only moves to about minus 27.">
        {ticks.map((t) => (
          <g key={t}>
            <line x1="60" x2="700" y1={Y(t)} y2={Y(t)} className="fig-grid" />
            <text x="52" y={Y(t) + 4} className="fig-axis" textAnchor="end">{t.toLocaleString("en-US")}</text>
          </g>
        ))}
        {[0, 15, 30, 45, 60].map((s) => (
          <text key={s} x={X(s)} y="272" className="fig-axis" textAnchor="middle">{s}s</text>
        ))}
        <text x="380" y="292" className="fig-axis" textAnchor="middle">time in epoch (illustrative 60 s window)</text>
        <polyline points={`${X(0)},${Y(0)} ${X(59.4)},${Y(0)} ${X(59.4)},${Y(-8100)} ${X(60)},${Y(-8100)}`} className="fig-spot" />
        <polyline points={`${X(0)},${Y(0)} ${X(60)},${Y(-27)}`} className="fig-twap" />
        <text x={X(57)} y={Y(-6500)} className="fig-s" textAnchor="end">push lasts one block</text>
        <g transform="translate(470,50)">
          <line x1="0" x2="24" y1="0" y2="0" className="fig-spot" />
          <text x="32" y="4" className="fig-s">spot tick</text>
          <line x1="110" x2="134" y1="0" y2="0" className="fig-twap" />
          <text x="142" y="4" className="fig-s">settlement TWAP</text>
        </g>
      </svg>
    </Fig>
  );
}

/* ------------------------------------------------------------------ 4. Reactive sequence */
export function ReactiveSeqFig() {
  const lanes = [
    ["Reactive system", 90],
    ["OorkaReactive", 290],
    ["OorkaKeeper", 490],
    ["OorkaHook", 690],
  ] as const;
  const msgs: [number, number, string, number, boolean?][] = [
    [90, 290, "CRON event (every k blocks)", 90],
    [290, 290, "ticks % N == 0", 130],
    [290, 490, "requestCallback → poke", 175],
    [490, 490, "check proxy & sender", 215],
    [490, 690, "settleEpoch() if ended", 260],
    [690, 490, "Settled / SettleFailed / Idle", 300, true],
  ];
  return (
    <Fig caption="Settlement automation. The reactive contract counts CRON ticks and sends a cross-chain callback. The keeper only accepts the callback proxy carrying our reactive contract's address. A failed settle is reported and retried on the next tick.">
      <svg viewBox="0 0 780 340" role="img" aria-label="Sequence: Reactive CRON event to OorkaReactive, callback to OorkaKeeper, keeper checks the sender and calls settleEpoch on OorkaHook, which reports the result.">
        <Arrow id="a4" />
        {lanes.map(([t, x]) => (
          <g key={t}>
            <rect x={x - 80} y="16" width="160" height="40" rx="10" className={`fig-box ${t === "OorkaHook" ? "accent" : t === "OorkaKeeper" || t === "OorkaReactive" ? "violet" : ""}`} />
            <text x={x} y="41" className="fig-t" textAnchor="middle">{t}</text>
            <line x1={x} x2={x} y1="58" y2="330" className="fig-life" />
          </g>
        ))}
        {msgs.map(([a, b, t, y, ret]) =>
          a === b ? (
            <g key={t}>
              <path d={`M${a} ${y - 10} h 40 v 20 h -38`} className="fig-line" fill="none" markerEnd="url(#a4)" />
              <text x={a + 48} y={y + 4} className="fig-s">{t}</text>
            </g>
          ) : (
            <g key={t}>
              <line x1={a} x2={b + (b > a ? -4 : 4)} y1={y} y2={y} className={ret ? "fig-line dashed" : "fig-line"} markerEnd="url(#a4)" />
              <text x={(a + b) / 2} y={y - 8} className="fig-s" textAnchor="middle">{t}</text>
            </g>
          ),
        )}
      </svg>
    </Fig>
  );
}

/* ------------------------------------------------------------------ 5. vault vs benchmark */
export function VaultVsBenchChart() {
  const data = [
    ["E0", 0.315, 0.258],
    ["E1", 0.44, 0.361],
    ["E2", 0.41, 0.336],
    ["E3*", 1.727, 0.695],
  ] as const;
  const max = 1.8;
  const H = 200;
  const Y = (v: number) => 30 + H - (v / max) * H;
  return (
    <Fig caption="Vault vs benchmark return per epoch in the local demo, from on-chain BenchmarkScored events. *E3 is the running epoch after Tight Tony's takeover. Since inception: vault +2.96%, benchmark +1.66%. Illustrative numbers from a synthetic market, not a performance claim.">
      <svg viewBox="0 0 640 290" role="img" aria-label="Bar chart: vault return beats the benchmark in every epoch, most after the takeover: 1.73% versus 0.70%.">
        {[0, 0.5, 1, 1.5].map((v) => (
          <g key={v}>
            <line x1="60" x2="620" y1={Y(v)} y2={Y(v)} className="fig-grid" />
            <text x="52" y={Y(v) + 4} className="fig-axis" textAnchor="end">{v.toFixed(1)}%</text>
          </g>
        ))}
        {data.map(([e, v, b], i) => {
          const cx = 130 + i * 135;
          return (
            <g key={e}>
              <rect x={cx - 40} y={Y(v)} width="36" height={Y(0) - Y(v)} rx="5" className="fig-bar-vault" />
              <rect x={cx + 4} y={Y(b)} width="36" height={Y(0) - Y(b)} rx="5" className="fig-bar-bench" />
              <text x={cx - 22} y={Y(v) - 6} className="fig-axis" textAnchor="middle">{v.toFixed(2)}</text>
              <text x={cx + 22} y={Y(b) - 6} className="fig-axis" textAnchor="middle">{b.toFixed(2)}</text>
              <text x={cx} y={Y(0) + 20} className="fig-s strong" textAnchor="middle">{e}</text>
            </g>
          );
        })}
        <g transform="translate(70,272)">
          <rect width="12" height="12" y="-10" rx="3" className="fig-bar-vault" />
          <text x="18" y="0" className="fig-s">Vault (seat holder's range)</text>
          <rect x="220" width="12" height="12" y="-10" rx="3" className="fig-bar-bench" />
          <text x="238" y="0" className="fig-s">Benchmark (never moves)</text>
        </g>
      </svg>
    </Fig>
  );
}
