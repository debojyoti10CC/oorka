// Oorka's own sticker set: flat, rounded, with a thick white die-cut outline and a soft drop shadow.
// Each sticker stands for a piece of the mechanism: the seat (crown), fees (coin), probes (pin),
// Reactive automation (bolt), defences (shield), the benchmark (ruler) and the takeover (trophy).
import type { CSSProperties, ReactNode } from "react";

type P = { size?: number; style?: CSSProperties; className?: string; label?: string };

function Sticker({ size = 96, style, className = "", label, children }: P & { children: ReactNode }) {
  return (
    <svg
      className={`sticker ${className}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      style={style}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {children}
    </svg>
  );
}

const OUT = { stroke: "#fff", strokeWidth: 9, strokeLinejoin: "round" as const, paintOrder: "stroke" as const };
const INK = "#171717";

export const Crown = (p: P) => (
  <Sticker {...p}>
    <path d="M14 70 L20 30 L38 50 L50 22 L62 50 L80 30 L86 70 Z" fill="#ffbe25" {...OUT} />
    <rect x="14" y="70" width="72" height="12" rx="4" fill="#f59e0b" {...OUT} />
    <circle cx="50" cy="58" r="5" fill="#ef4444" />
    <circle cx="32" cy="62" r="3.5" fill="#6366f1" />
    <circle cx="68" cy="62" r="3.5" fill="#22c55e" />
  </Sticker>
);

export const Coin = (p: P) => (
  <Sticker {...p}>
    <circle cx="50" cy="50" r="36" fill="#fbbf24" {...OUT} />
    <circle cx="50" cy="50" r="26" fill="none" stroke="#d97706" strokeWidth="4" />
    <text x="50" y="62" textAnchor="middle" fontFamily="Geist, sans-serif" fontWeight="700" fontSize="32" fill="#92400e">
      %
    </text>
  </Sticker>
);

export const Pin = (p: P) => (
  <Sticker {...p}>
    <path d="M50 88 C50 88 20 58 20 40 A30 30 0 0 1 80 40 C80 58 50 88 50 88 Z" fill="#6366f1" {...OUT} />
    <circle cx="50" cy="40" r="12" fill="#fff" />
    <circle cx="50" cy="40" r="5" fill={INK} />
  </Sticker>
);

export const Bolt = (p: P) => (
  <Sticker {...p}>
    <path d="M58 8 L22 56 H46 L38 92 L78 40 H54 Z" fill="#a78bfa" {...OUT} />
    <path d="M58 8 L22 56 H46 L38 92 L78 40 H54 Z" fill="none" stroke="#7c3aed" strokeWidth="3" strokeLinejoin="round" />
  </Sticker>
);

export const Shield = (p: P) => (
  <Sticker {...p}>
    <path d="M50 10 L84 22 V48 C84 70 68 84 50 92 C32 84 16 70 16 48 V22 Z" fill="#34d399" {...OUT} />
    <path d="M34 50 L46 62 L68 38" fill="none" stroke="#065f46" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
  </Sticker>
);

export const Trophy = (p: P) => (
  <Sticker {...p}>
    <path d="M28 14 H72 V40 A22 22 0 0 1 28 40 Z" fill="#fb7185" {...OUT} />
    <path d="M28 22 H14 A14 14 0 0 0 30 46 M72 22 H86 A14 14 0 0 1 70 46" fill="none" stroke="#fb7185" strokeWidth="7" />
    <rect x="44" y="60" width="12" height="14" fill="#e11d48" />
    <rect x="30" y="74" width="40" height="12" rx="4" fill="#e11d48" {...OUT} />
    <path d="M42 30 L50 24 V50" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
  </Sticker>
);

export const Ruler = (p: P) => (
  <Sticker {...p}>
    <rect x="10" y="34" width="80" height="32" rx="6" fill="#93c5fd" transform="rotate(-18 50 50)" {...OUT} />
    {[22, 34, 46, 58, 70].map((x, i) => (
      <line key={x} x1={x} x2={x} y1="40" y2={i % 2 ? 50 : 56} stroke="#1e3a8a" strokeWidth="3" strokeLinecap="round" transform="rotate(-18 50 50)" />
    ))}
  </Sticker>
);

export const Spark = (p: P) => (
  <Sticker {...p}>
    <path d="M50 8 C54 36 64 46 92 50 C64 54 54 64 50 92 C46 64 36 54 8 50 C36 46 46 36 50 8 Z" fill="#fde047" {...OUT} />
    <path d="M80 14 C81 22 84 25 92 26 C84 27 81 30 80 38 C79 30 76 27 68 26 C76 25 79 22 80 14 Z" fill="#fde047" {...OUT} />
  </Sticker>
);
