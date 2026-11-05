"use client";

import { useCallback, useEffect, useState } from "react";
import { LiveDot } from "./live";

interface Status {
  contract: "live" | "paused" | "unreachable";
  agent: string;
  policy: "anchored" | "mismatch" | "unknown";
  policyVersion: number | null;
  lastActivity: string | null;
  orders24h: number;
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "no activity yet";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Sidebar card: live health of the contract, the agent and the policy anchor. */
export function SystemStatus() {
  const [s, setS] = useState<Status | null>(null);
  const [now, setNow] = useState(0);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/status", { cache: "no-store" });
      if (r.ok) setS(await r.json());
    } catch {
      /* keep the last reading */
    }
    setNow(Date.now());
  }, []);
  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 20_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const allGood = s?.contract === "live" && s.agent === "running" && s.policy === "anchored";
  const rows: [string, string, "live" | "warn" | "down" | "off"][] = s
    ? [
        ["Contract", s.contract === "live" ? "Taking orders" : s.contract === "paused" ? "Paused by owner" : "Unreachable", s.contract === "live" ? "live" : s.contract === "paused" ? "warn" : "down"],
        ["Agent", s.agent === "running" ? "Running" : s.agent[0].toUpperCase() + s.agent.slice(1), s.agent === "running" ? "live" : "warn"],
        ["Policy", s.policy === "anchored" ? `v${s.policyVersion} anchored` : s.policy === "mismatch" ? "Change half-signed" : "Unknown", s.policy === "anchored" ? "live" : "warn"],
      ]
    : [];

  return (
    <div className="rounded-xl border border-rule bg-surface p-3 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">System status</span>
        {s ? <LiveDot tone={allGood ? "live" : "warn"} /> : <span className="skeleton h-2 w-2 rounded-full" />}
      </div>
      <p className={`mt-0.5 text-xs ${s ? (allGood ? "text-real" : "text-pending") : "text-ink-3"}`}>{s ? (allGood ? "All systems operational" : "Needs attention") : "Checking…"}</p>
      <ul className="mt-2.5 space-y-1.5">
        {s
          ? rows.map(([k, v, tone]) => (
              <li key={k} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-ink-3">{k}</span>
                <span className="flex items-center gap-1.5 text-ink-2">
                  {v}
                  <LiveDot tone={tone} />
                </span>
              </li>
            ))
          : [0, 1, 2].map((i) => <li key={i} className="skeleton h-3.5" />)}
      </ul>
      {s && (
        <div className="mt-2.5 border-t border-rule pt-2 text-[11px] text-ink-3">
          Last agent step {ago(s.lastActivity, now)} · {s.orders24h} order{s.orders24h === 1 ? "" : "s"} today
        </div>
      )}
    </div>
  );
}
