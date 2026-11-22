// Mega-menu navigation: a trigger opens a flyout panel with grouped links (title, one-line description, arrow) and a
// decorative preview card that recolours to match the hovered item.
//
// Behaviour: opens on click, and on hover for fine pointers. Escape closes it and returns focus to the trigger, and so
// do a click outside or picking a link. Only one menu is open at a time. Triggers carry aria-expanded and
// aria-controls. Under 640px the panel drops below the nav at full width and the preview card hides.
import { useEffect, useId, useRef, useState } from "react";

export type MenuItem = {
  title: string;
  desc: string;
  href: string;
  external?: boolean;
  tone: Tone;
  art: Art;
};
export type MenuGroup = { label?: string; items: MenuItem[] };
export type Tone = "violet" | "coral" | "green" | "blue" | "amber" | "lilac";

const TONES: Record<Tone, [string, string, string, string]> = {
  // background, stripe, ring, ring inner
  violet: ["#a78bfa", "#9a7cf6", "#8b5cf6", "#b9a3fb"],
  lilac: ["#d8c8ff", "#cbb6ff", "#a78bfa", "#e6dcff"],
  coral: ["#ffb3ad", "#ffa199", "#f87171", "#ffd0cb"],
  green: ["#b9e58f", "#a8dc7a", "#65a30d", "#d4f0b6"],
  blue: ["#a9c8ff", "#97bbff", "#3b82f6", "#cfe0ff"],
  amber: ["#fcd34d", "#f6c33a", "#f59e0b", "#fde68a"],
};

/** Preview card: a small illustration of the hovered link, on that link's tone. */
export type Art = "swap" | "vault" | "arena" | "curate" | "docs" | "paper" | "code" | "chain";

function ArtShape({ art, ink, mid }: { art: Art; ink: string; mid: string }) {
  const W = "#ffffff";
  switch (art) {
    case "swap":
      return (
        <g>
          <circle cx="92" cy="112" r="42" fill={W} />
          <text x="92" y="122" textAnchor="middle" fontFamily="Geist, sans-serif" fontWeight="700" fontSize="26" fill={ink}>tETH</text>
          <circle cx="150" cy="174" r="42" fill={mid} />
          <text x="150" y="184" textAnchor="middle" fontFamily="Geist, sans-serif" fontWeight="700" fontSize="26" fill={W}>tUSD</text>
          <path d="M150 92 A58 58 0 0 1 184 142" fill="none" stroke={ink} strokeWidth="6" strokeLinecap="round" />
          <path d="M176 136 L184 146 L192 134" fill="none" stroke={ink} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M92 196 A58 58 0 0 1 58 146" fill="none" stroke={ink} strokeWidth="6" strokeLinecap="round" />
          <path d="M66 152 L58 142 L50 154" fill="none" stroke={ink} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      );
    case "vault":
      return (
        <g>
          <rect x="44" y="64" width="152" height="150" rx="22" fill={W} />
          <circle cx="120" cy="139" r="40" fill="none" stroke={ink} strokeWidth="8" />
          {[0, 60, 120, 180, 240, 300].map((a) => (
            <line key={a} x1="120" y1="139" x2={120 + 40 * Math.cos((a * Math.PI) / 180)} y2={139 + 40 * Math.sin((a * Math.PI) / 180)} stroke={ink} strokeWidth="5" />
          ))}
          <circle cx="120" cy="139" r="12" fill={mid} />
          <rect x="62" y="214" width="24" height="14" rx="4" fill={ink} />
          <rect x="154" y="214" width="24" height="14" rx="4" fill={ink} />
        </g>
      );
    case "arena":
      return (
        <g>
          {[
            [70, 110, W],
            [40, 170, mid],
            [96, 70, W],
            [24, 196, W],
          ].map(([x, w, c], k) => (
            <rect key={k} x={x as number} y={74 + k * 40} width={w as number} height="20" rx="10" fill={c as string} />
          ))}
          <line x1="132" x2="132" y1="56" y2="236" stroke={ink} strokeWidth="4" strokeDasharray="6 6" />
          <rect x="102" y="40" width="60" height="24" rx="12" fill={ink} />
        </g>
      );
    case "curate":
      return (
        <g>
          <rect x="30" y="150" width="180" height="10" rx="5" fill={W} />
          <path d="M72 126 V184 M168 126 V184" stroke={ink} strokeWidth="8" strokeLinecap="round" />
          <rect x="72" y="146" width="96" height="18" rx="9" fill={mid} />
          <path d="M120 120 C120 120 98 98 98 84 A22 22 0 0 1 142 84 C142 98 120 120 120 120 Z" fill={W} stroke={ink} strokeWidth="5" />
          <circle cx="120" cy="84" r="7" fill={ink} />
        </g>
      );
    case "docs":
      return (
        <g>
          <rect x="62" y="44" width="116" height="196" rx="16" fill={W} />
          {[80, 104, 128, 176, 200].map((y, k) => (
            <rect key={y} x="82" y={y} width={k === 2 ? 50 : 76} height="10" rx="5" fill={k === 0 ? ink : mid} />
          ))}
          <rect x="82" y="148" width="76" height="16" rx="5" fill={ink} opacity="0.85" />
        </g>
      );
    case "paper":
      return (
        <g>
          <rect x="74" y="56" width="110" height="180" rx="14" fill={mid} />
          <rect x="56" y="40" width="110" height="180" rx="14" fill={W} />
          <text x="111" y="112" textAnchor="middle" fontFamily="Georgia, serif" fontStyle="italic" fontSize="34" fill={ink}>φ·Δ</text>
          {[136, 156, 176, 196].map((y) => (
            <rect key={y} x="76" y={y} width="70" height="7" rx="3.5" fill={mid} />
          ))}
        </g>
      );
    case "code":
      return (
        <g>
          <rect x="34" y="62" width="172" height="156" rx="18" fill={ink} />
          <circle cx="56" cy="82" r="5" fill="#f87171" />
          <circle cx="72" cy="82" r="5" fill="#fbbf24" />
          <circle cx="88" cy="82" r="5" fill="#4ade80" />
          <path d="M88 124 L64 146 L88 168 M152 124 L176 146 L152 168" fill="none" stroke={W} strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M132 116 L108 176" stroke={mid} strokeWidth="8" strokeLinecap="round" />
        </g>
      );
    case "chain":
      return (
        <g>
          {[0, 1, 2].map((k) => (
            <g key={k}>
              <rect x={30 + k * 66} y={110 - (k % 2) * 30} width="52" height="52" rx="12" fill={k === 1 ? mid : W} stroke={ink} strokeWidth="4" />
              {k < 2 && <line x1={82 + k * 66} y1={136 - (k % 2) * 30} x2={96 + k * 66} y2={k % 2 ? 136 : 106} stroke={ink} strokeWidth="5" />}
            </g>
          ))}
          <circle cx="56" cy="136" r="6" fill="#4ade80" />
        </g>
      );
  }
}

function Preview({ tone, art }: { tone: Tone; art: Art }) {
  const [bg, , ring, inner] = TONES[tone];
  return (
    <svg className="menu-preview" viewBox="0 0 240 280" aria-hidden="true">
      <rect width="240" height="280" rx="18" fill={bg} />
      <circle cx="210" cy="250" r="90" fill={inner} opacity="0.55" />
      <circle cx="20" cy="30" r="48" fill={inner} opacity="0.45" />
      <ArtShape art={art} ink="#1f1147" mid={ring} />
    </svg>
  );
}

export function NavMenu({ label, groups, active }: { label: string; groups: MenuGroup[]; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const first = groups[0]?.items[0];
  const [pick, setPick] = useState<{ tone: Tone; art: Art }>({ tone: first?.tone ?? "violet", art: first?.art ?? "swap" });
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const hoverOpenedAt = useRef(0);
  const finePointer = typeof window !== "undefined" && window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;

  // one menu at a time
  useEffect(() => {
    const onOther = (e: Event) => {
      if ((e as CustomEvent).detail !== id) setOpen(false);
    };
    window.addEventListener("navmenu:open", onOther);
    return () => window.removeEventListener("navmenu:open", onOther);
  }, [id]);
  useEffect(() => {
    if (open) window.dispatchEvent(new CustomEvent("navmenu:open", { detail: id }));
  }, [open, id]);

  // close on outside click, Escape and route change
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const onHash = () => setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", onHash);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("hashchange", onHash);
    };
  }, [open]);

  const hover = (next: boolean) => {
    if (!finePointer) return;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      if (next) hoverOpenedAt.current = Date.now();
      setOpen(next);
    }, next ? 60 : 160);
  };

  return (
    <div className="navmenu" ref={root} onPointerEnter={() => hover(true)} onPointerLeave={() => hover(false)}>
      <button
        ref={trigger}
        className={`navmenu-trigger${open ? " open" : ""}${active ? " active" : ""}`}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => {
          // a click that lands just after hover opened the menu should keep it open, not toggle it shut
          if (open && Date.now() - hoverOpenedAt.current < 600) return;
          setOpen((o) => !o);
        }}
      >
        {label}
        <svg className="chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 L6 7.5 L9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div id={`${id}-panel`} className={`navmenu-panel${open ? " open" : ""}`} role="region" aria-label={`${label} menu`} hidden={!open}>
        <div className="navmenu-list">
          {groups.map((g, gi) => (
            <div className="navmenu-group" key={gi}>
              {g.label && <div className="navmenu-label">{g.label}</div>}
              {g.items.map((it) => (
                <a
                  key={it.title}
                  className="navmenu-item"
                  href={it.href}
                  target={it.external ? "_blank" : undefined}
                  rel={it.external ? "noreferrer" : undefined}
                  onPointerEnter={() => setPick({ tone: it.tone, art: it.art })}
                  onFocus={() => setPick({ tone: it.tone, art: it.art })}
                  onClick={() => setOpen(false)}
                >
                  <span className="navmenu-text">
                    <span className="navmenu-title">{it.title}</span>
                    <span className="navmenu-desc">{it.desc}</span>
                  </span>
                  <svg className="navmenu-arrow" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M3.5 8.5 L8.5 3.5 M4.5 3.5 H8.5 V7.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {it.external && <span className="visually-hidden"> (opens in a new tab)</span>}
                </a>
              ))}
            </div>
          ))}
        </div>
        <Preview tone={pick.tone} art={pick.art} />
      </div>
    </div>
  );
}
