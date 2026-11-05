/**
 * Live signals. A green dot that keeps pinging means the value is read live
 * from the chain or the runtime; amber means attention; grey means off.
 */
export function LiveDot({ tone = "live", className = "" }: { tone?: "live" | "warn" | "off" | "down"; className?: string }) {
  const color = tone === "live" ? "bg-live" : tone === "warn" ? "bg-pending" : tone === "down" ? "bg-failed" : "bg-ink-3";
  return (
    <span className={`relative inline-flex h-2 w-2 shrink-0 ${className}`} aria-hidden>
      {tone === "live" && <span className={`live-ping absolute inset-0 rounded-full ${color}`} />}
      {tone === "warn" && <span className={`live-blink absolute inset-0 rounded-full ${color}`} />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}

/** A small pill: "● Live", "● Paused", … */
export function LivePill({ tone = "live", children }: { tone?: "live" | "warn" | "off" | "down"; children: React.ReactNode }) {
  const cls = tone === "live" ? "bg-real-soft text-real" : tone === "warn" ? "bg-pending-soft text-pending" : tone === "down" ? "bg-failed-soft text-failed" : "bg-simulated-soft text-simulated";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      <LiveDot tone={tone} />
      {children}
    </span>
  );
}

/** A tiny trend line that draws itself in. Values are plotted as given. */
export function Sparkline({ values, className = "", stroke = "var(--accent)" }: { values: number[]; className?: string; stroke?: string }) {
  const w = 96;
  const h = 32;
  if (values.length < 2) return <svg width={w} height={h} className={className} aria-hidden />;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 3 - ((v - min) / span) * (h - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  const id = `spark-${values.join("-").slice(0, 24).replace(/\./g, "_")}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} className="flow-label" />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="draw" style={{ ["--len" as string]: "300" }} />
    </svg>
  );
}
