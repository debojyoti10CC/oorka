import { formatEther, formatUnits, parseUnits } from "viem";

// v4 TickMath bounds; swap limits must sit strictly inside them
export const MIN_SQRT_PRICE_LIMIT = 4295128739n + 1n;
export const MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n;

const Q96 = 2 ** 96;
const LOG_BASE = Math.log(1.0001);

// ---------------------------------------------------------------- the pool's token pair
// Prices are shown the way people read them: quote per base (e.g. USDC per WETH), whichever of the two the pool
// sorted first. `base` says which currency index (0 or 1) is the base asset.
export type Pair = {
  sym0: string;
  sym1: string;
  dec0: number;
  dec1: number;
  base: 0 | 1;
  /** open-mint test tokens (local devnet); real tokens come from faucets and wrapping instead */
  mintable: boolean;
};

let PAIR: Pair = { sym0: "tETH", sym1: "tUSD", dec0: 18, dec1: 18, base: 0, mintable: true };
export const setPair = (p: Pair) => {
  PAIR = p;
};
export const pair = () => PAIR;
export const baseSym = () => (PAIR.base === 0 ? PAIR.sym0 : PAIR.sym1);
export const quoteSym = () => (PAIR.base === 0 ? PAIR.sym1 : PAIR.sym0);
export const baseIndex = () => PAIR.base;
export const symOf = (i: 0 | 1) => (i === 0 ? PAIR.sym0 : PAIR.sym1);
export const decOf = (i: 0 | 1) => (i === 0 ? PAIR.dec0 : PAIR.dec1);

/** token1 per token0 in whole-token terms, from a raw on-chain ratio */
const humanRatio = (raw: number) => raw * Math.pow(10, PAIR.dec0 - PAIR.dec1);
const toDisplay = (ratio: number) => (PAIR.base === 0 ? ratio : 1 / ratio);

/** Display price (quote per base) at a tick. */
export const tickToPrice = (tick: number) => toDisplay(humanRatio(Math.pow(1.0001, tick)));

export function sqrtPriceToPrice(sqrtPriceX96: bigint) {
  const r = Number(sqrtPriceX96) / Q96;
  return toDisplay(humanRatio(r * r));
}

/** Tick for a display price, snapped to the tick spacing. `mode` rounds in tick space. */
export function priceToTick(price: number, spacing: number, mode: "floor" | "ceil" = "floor") {
  if (!(price > 0)) throw new Error("Price must be positive.");
  const ratio = PAIR.base === 0 ? price : 1 / price;
  const raw = Math.log(ratio * Math.pow(10, PAIR.dec1 - PAIR.dec0)) / LOG_BASE;
  const snapped = mode === "floor" ? Math.floor(raw / spacing) * spacing : Math.ceil(raw / spacing) * spacing;
  return snapped === 0 ? 0 : snapped; // avoid -0
}

/** A display price band [low, high] as a valid tick range, rounded outward. */
export function rangeToTicks(lowPrice: number, highPrice: number, spacing: number): [number, number] {
  const a = priceToTick(lowPrice, spacing, "floor");
  const b = priceToTick(highPrice, spacing, "floor");
  const lower = Math.min(a, b);
  const upper = Math.max(priceToTick(lowPrice, spacing, "ceil"), priceToTick(highPrice, spacing, "ceil"));
  return [lower, upper === lower ? lower + spacing : upper];
}

/** A tick range as a display price band, low first. */
export function rangePrices(lower: number, upper: number): [number, number] {
  const a = tickToPrice(lower);
  const b = tickToPrice(upper);
  return a < b ? [a, b] : [b, a];
}

export const fmtRange = (lower: number, upper: number, digits = 0, sep = " to ") => {
  const [lo, hi] = rangePrices(lower, upper);
  return `${fmt(lo, digits)}${sep}${fmt(hi, digits)}`;
};

// ---------------------------------------------------------------- amounts
/** WAD (1e18) fixed point, used for growth ratios. */
export const fromWad = (v: bigint | undefined | null) => (v == null ? 0 : Number(formatEther(v)));

export const fromUnits = (v: bigint | undefined | null, decimals: number) => (v == null ? 0 : Number(formatUnits(v, decimals)));

export function toUnits(v: string | number, decimals: number) {
  const s = String(v).trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error(`"${v}" is not a valid amount.`);
  const [whole, frac = ""] = s.split(".");
  return parseUnits(`${whole || "0"}.${frac.slice(0, decimals) || "0"}`, decimals);
}

/** 18-decimal amounts (kept for local mode helpers). */
export const toWad = (v: string | number) => toUnits(v, 18);

/** Amounts the hook books in token1 (NAVs, bonds, idle balances, fees). */
export const fromT1 = (v: bigint | undefined | null) => fromUnits(v, PAIR.dec1);

/** A token1 amount expressed in the quote asset, so every value on screen is in one unit. */
export const t1InQuote = (amount1: number, price: number) => (PAIR.base === 1 ? amount1 * price : amount1);

/** Sensible display digits for an amount of a token. */
export const digitsFor = (sym: string) => (/ETH|BTC/i.test(sym) ? 5 : 2);

export function fmt(n: number, digits = 2) {
  if (!isFinite(n)) return "–";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** `x` is a fraction: 0.0123 -> "+1.230%" */
export function fmtPct(x: number, digits = 2) {
  if (!isFinite(x)) return "–";
  const v = x * 100;
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return `${(0).toFixed(digits)}%`;
  return `${v > 0 ? "+" : "−"}${s}%`;
}
