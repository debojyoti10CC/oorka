import { tickToPrice, fmt, fmtPct, fromWad } from "./lib/math";

export type CuratorRow = {
  id: number;
  owner: string;
  name: string;
  lower: number;
  upper: number;
  nav: bigint;
  epochStartNav: bigint;
  epochGrowthWad: bigint;
  bond: bigint;
  streak: number;
  joinedEpoch: number;
  active: boolean;
  incumbent: boolean;
  benchmark: boolean;
};

export const LANE_COLORS = ["#C2780F", "#13897A", "#7B4FC9", "#D0485C", "#2F6FD6", "#5E8A1F", "#B5568F", "#4F6B8A"];
export const BENCH_COLOR = "#8a8a93";
export const laneColor = (id: number) => LANE_COLORS[id % LANE_COLORS.length];
export const colorOf = (c: { id: number; benchmark?: boolean }) => (c.benchmark ? BENCH_COLOR : laneColor(c.id));

type Props = {
  curators: CuratorRow[];
  price: number;
  vault: { lower: number; upper: number; liquidity: bigint } | null;
};

const ROW = 38;
const GUTTER_L = 168;
const GUTTER_R = 120;
const W = 1040;

export function Lanes({ curators, price, vault }: Props) {
  const active = curators.filter((c) => c.active);
  // seat holder first, benchmark last, everyone else by id
  const sorted = [...active].sort(
    (a, b) => Number(b.incumbent) - Number(a.incumbent) || Number(a.benchmark) - Number(b.benchmark) || a.id - b.id,
  );

  const prices = active.flatMap((c) => [tickToPrice(c.lower), tickToPrice(c.upper)]);
  if (price > 0) prices.push(price);
  let lo = Math.max(Math.min(...prices) * 0.94, price / 2.2);
  let hi = Math.min(Math.max(...prices) * 1.06, price * 2.2);
  if (!isFinite(lo) || !isFinite(hi) || lo >= hi) {
    lo = price * 0.6;
    hi = price * 1.4;
  }
  const plotW = W - GUTTER_L - GUTTER_R;
  const x = (p: number) => GUTTER_L + ((Math.log(p) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * plotW;
  const clampX = (p: number) => Math.max(GUTTER_L, Math.min(GUTTER_L + plotW, x(p)));

  const rows = sorted.length + 1; // + vault lane
  const top = 30;
  const H = top + rows * ROW + 34;
  const axisTicks = niceTicks(lo, hi, 7);
  const incumbent = active.find((c) => c.incumbent);
  const incGrowth = incumbent ? fromWad(incumbent.epochGrowthWad) : 1;

  return (
    <svg className="lanes" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Curator ranges against the live pool price">
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="2" />
        </pattern>
      </defs>

      {/* axis */}
      {axisTicks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={top - 6} y2={H - 30} className="grid" />
          <text x={x(t)} y={H - 12} className="axis" textAnchor="middle">
            {fmt(t, 0)}
          </text>
        </g>
      ))}
      <text x={GUTTER_L + plotW + 14} y={H - 12} className="axis">tUSD / tETH</text>
      <text x={W - 8} y={top - 12} className="axis" textAnchor="end">epoch return</text>

      {/* vault lane */}
      <g transform={`translate(0, ${top})`}>
        <text x={12} y={ROW / 2 + 5} className="lane-name strong">Vault liquidity</text>
        {vault && vault.liquidity > 0n && (
          <rect
            x={clampX(tickToPrice(vault.lower))}
            y={ROW / 2 - 10}
            width={Math.max(2, clampX(tickToPrice(vault.upper)) - clampX(tickToPrice(vault.lower)))}
            height={20}
            rx={4}
            className="vault-bar"
          />
        )}
        <text x={W - 8} y={ROW / 2 + 5} className="lane-stat muted" textAnchor="end">real money</text>
        <line x1={12} x2={W - 8} y1={ROW} y2={ROW} className="rule" />
      </g>

      {sorted.map((c, i) => {
        const pl = tickToPrice(c.lower);
        const pu = tickToPrice(c.upper);
        const inRange = price >= pl && price <= pu;
        const g = fromWad(c.epochGrowthWad);
        const color = colorOf(c);
        const y0 = top + (i + 1) * ROW;
        const lead = !c.incumbent && !c.benchmark && g - incGrowth > 0.00005;
        return (
          <g key={c.id} transform={`translate(0, ${y0})`} style={{ color }}>
            <text x={12} y={ROW / 2 + 1} className="lane-name">
              {c.name}
            </text>
            <text x={12} y={ROW / 2 + 16} className="lane-sub">
              {c.incumbent ? "holds the seat" : c.benchmark ? "never moves" : streakText(c.streak)}
            </text>
            <rect
              x={clampX(pl)}
              y={ROW / 2 - 7}
              width={Math.max(2, clampX(pu) - clampX(pl))}
              height={14}
              rx={3}
              fill={inRange ? color : "url(#hatch)"}
              opacity={inRange ? 0.95 : 0.6}
              stroke={color}
              strokeWidth={inRange ? 0 : 1.2}
            />
            {c.incumbent && (
              <rect
                x={clampX(pl) - 3}
                y={ROW / 2 - 10}
                width={Math.max(2, clampX(pu) - clampX(pl)) + 6}
                height={20}
                rx={5}
                className="seat-ring"
              />
            )}
            <text x={W - 8} y={ROW / 2 + 5} className={`lane-stat ${lead ? "lead" : ""}`} textAnchor="end">
              {fmtPct(g - 1, 3)}
            </text>
            <line x1={12} x2={W - 8} y1={ROW} y2={ROW} className="rule" />
          </g>
        );
      })}

      {/* live price */}
      {price > 0 && (
        <g>
          <line x1={x(price)} x2={x(price)} y1={top - 8} y2={H - 30} className="price-line" />
          <rect x={x(price) - 40} y={4} width={80} height={20} rx={10} className="price-pill" />
          <text x={x(price)} y={18} textAnchor="middle" className="price-text">
            {fmt(price, 1)}
          </text>
        </g>
      )}
    </svg>
  );
}

function streakText(s: number) {
  if (s === 0) return "no wins yet";
  return s === 1 ? "1 epoch won" : `${s} epochs won`;
}

function niceTicks(lo: number, hi: number, n: number) {
  const span = hi - lo;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) ?? mag * 10;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(t);
  return out;
}
