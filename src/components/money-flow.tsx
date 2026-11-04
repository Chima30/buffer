"use client";

/**
 * Money flow (Sankey): where a payment actually went. Left, what came in; middle,
 * costs versus net; right, each recipient. Every hue is a recipient and appears
 * with its label and amount, so colour never carries meaning alone.
 */
import { useEffect, useState } from "react";

export type FlowColor = "vendor" | "chain" | "ai" | "owner" | "contrib" | "in";
export interface FlowLeaf { label: string; units: bigint; color: FlowColor; note?: string }
export interface FlowGroup { label: string; leaves: FlowLeaf[] }

const W = 540;
const H = 260;
const BAR = 6;
const GAP = 12;
const X0 = 0;
const X1 = 190;
const X2 = 300;

const fill = (c: FlowColor) => `var(--flow-${c === "contrib" ? "contrib" : c})`;

export function formatUsdc(units: bigint): string {
  const neg = units < 0n;
  const a = neg ? -units : units;
  const whole = a / 1_000_000n;
  let frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}.${frac}`;
}

/** Counts up to the value once, on mount. Skipped for reduced motion. */
function useCountUp(target: number, ms = 900): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const t = setTimeout(() => setV(target), 0);
      return () => clearTimeout(t);
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      setV(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function ribbon(xa: number, ya0: number, ya1: number, xb: number, yb0: number, yb1: number): string {
  const mx = (xa + xb) / 2;
  return `M${xa},${ya0} C${mx},${ya0} ${mx},${yb0} ${xb},${yb0} L${xb},${yb1} C${mx},${yb1} ${mx},${ya1} ${xa},${ya1} Z`;
}

/** Pure geometry for the chart; computed outside render state. */
function layout(groups: FlowGroup[], leaves: FlowLeaf[], total: bigint) {
  // Heights: proportional, with a 3px floor so tiny amounts (inference) stay visible.
  const avail = H - GAP * (leaves.length - 1);
  const raw = leaves.map((l) => Math.max(3, (Number(l.units) / Number(total)) * avail));
  const scale = avail / raw.reduce((a, b) => a + b, 0);
  const hs = raw.map((h) => h * scale);

  // Right column positions.
  let y = 0;
  const right = hs.map((h) => {
    const r = { y0: y, y1: y + h };
    y += h + GAP;
    return r;
  });
  // Middle bars: one per group, spanning its leaves' total height; groups separated by a larger gap.
  const groupH = groups.map((g, gi) => {
    const first = groups.slice(0, gi).reduce((a, x) => a + x.leaves.length, 0);
    return hs.slice(first, first + g.leaves.length).reduce((a, b) => a + b, 0);
  });
  const midGap = 40;
  const midTotal = groupH.reduce((a, b) => a + b, 0) + midGap * (groups.length - 1);
  let my = (H - midTotal) / 2;
  const mid = groupH.map((h) => {
    const r = { y0: my, y1: my + h };
    my += h + midGap;
    return r;
  });
  // Source bar: the whole payment, centred.
  const srcH = groupH.reduce((a, b) => a + b, 0);
  const src = { y0: (H - srcH) / 2, y1: (H - srcH) / 2 + srcH };

  const paths: { d: string; color: FlowColor; key: string; op: number }[] = [];
  let sy = src.y0;
  let li = 0;
  groups.forEach((g, gi) => {
    paths.push({ key: `s${gi}`, d: ribbon(X0 + BAR, sy, sy + groupH[gi], X1, mid[gi].y0, mid[gi].y1), color: "in", op: 0.32 });
    sy += groupH[gi];
    let ly = mid[gi].y0;
    g.leaves.forEach((l) => {
      const h = hs[li];
      paths.push({ key: `m${li}`, d: ribbon(X1 + BAR, ly, ly + h, X2, right[li].y0, right[li].y1), color: l.color, op: 0.5 });
      ly += h;
      li++;
    });
  });

  return { hs, right, groupH, mid, src, srcH, paths };
}

export function MoneyFlow({ title, caption, sourceLabel, groups }: { title: string; caption?: React.ReactNode; sourceLabel: string; groups: FlowGroup[] }) {
  const leaves = groups.flatMap((g) => g.leaves);
  const total = leaves.reduce((a, l) => a + l.units, 0n);
  const counted = useCountUp(Number(total) / 1e6);
  if (total <= 0n) return null;

  const { right, mid, src, srcH, paths } = layout(groups, leaves, total);

  return (
    <figure className="rounded-[var(--radius-card)] border border-rule bg-surface p-5 sm:p-6">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm text-ink-2">{title}</span>
        <span className="font-mono text-2xl tabular text-ink">
          {counted.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-sm text-ink-3">USDC</span>
        </span>
      </figcaption>
      {caption && <div className="mt-1 text-xs text-ink-3">{caption}</div>}

      <svg viewBox={`-2 -28 ${W + 4} ${H + 40}`} className="mx-auto mt-5 hidden w-full max-w-[600px] sm:block" role="img" aria-label={`${title}: ${leaves.map((l) => `${l.label} ${formatUsdc(l.units)} USDC`).join(", ")}`}>
        <g className="flow-reveal">
          {paths.map((p) => (
            <path key={p.key} d={p.d} style={{ fill: fill(p.color), opacity: p.op }} />
          ))}
        </g>
        <rect x={X0} y={src.y0} width={BAR} height={srcH} rx={2} style={{ fill: "var(--ink-3)" }} />
        {mid.map((m, i) => (
          <rect key={i} x={X1} y={m.y0} width={BAR} height={m.y1 - m.y0} rx={2} style={{ fill: "var(--ink-2)" }} />
        ))}
        {right.map((r, i) => (
          <rect key={i} x={X2} y={r.y0} width={BAR} height={Math.max(3, r.y1 - r.y0)} rx={2} style={{ fill: fill(leaves[i].color) }} />
        ))}
        <g className="flow-label" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
          <text x={X0} y={src.y0 - 10} style={{ fill: "var(--ink-2)", fontFamily: "var(--font-sans)", fontSize: 12 }}>{sourceLabel}</text>
          {groups.map((g, i) => (
            <text key={g.label} x={X1 + BAR / 2} y={mid[i].y0 - 10} textAnchor="middle" style={{ fill: "var(--ink-2)", fontFamily: "var(--font-sans)", fontSize: 12 }}>
              {g.label} <tspan style={{ fill: "var(--ink-3)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{formatUsdc(g.leaves.reduce((a, l) => a + l.units, 0n))}</tspan>
            </text>
          ))}
          {leaves.map((l, i) => {
            const cy = (right[i].y0 + right[i].y1) / 2;
            return (
              <g key={l.label}>
                <text x={X2 + BAR + 10} y={cy + (l.note ? -3 : 4)} style={{ fill: "var(--ink)", fontFamily: "var(--font-sans)", fontSize: 13 }}>
                  {l.label}
                  <tspan x={W} textAnchor="end" style={{ fill: "var(--ink-2)", fontFamily: "var(--font-mono)", fontSize: 12 }}>{formatUsdc(l.units)}</tspan>
                </text>
                {l.note && <text x={X2 + BAR + 10} y={cy + 12} style={{ fill: "var(--ink-3)", fontFamily: "var(--font-sans)", fontSize: 11 }}>{l.note}</text>}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Small screens: the same flows as a ranked list with thin bars. */}
      <ul className="mt-4 space-y-3 sm:hidden">
        {leaves.map((l) => (
          <li key={l.label}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span>{l.label}</span>
              <span className="font-mono text-xs tabular text-ink-2">{formatUsdc(l.units)}</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-raised">
              <div className="flow-reveal h-full rounded-full" style={{ width: `${Math.max(1.5, (Number(l.units) / Number(total)) * 100)}%`, background: fill(l.color) }} />
            </div>
            {l.note && <p className="mt-1 text-xs text-ink-3">{l.note}</p>}
          </li>
        ))}
      </ul>
    </figure>
  );
}
