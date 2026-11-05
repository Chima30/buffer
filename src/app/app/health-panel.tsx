"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Fuel, PiggyBank, ShoppingCart, TrendingUp } from "lucide-react";
import { LiveDot, LivePill } from "@/components/live";
import { Money } from "@/components/money";

type U = string; // bigint as string
interface Win { orders: number; revenue: U; vendorSpend: U; inference: U; net: U; marginBps: number | null; costPerOrder: U | null; inferencePerOrder: U | null }
interface HealthData {
  status: "healthy" | "watch" | "at_risk";
  week: Win;
  prevWeek: Win;
  daily: { day: string; revenue: number; costs: number }[];
  forecast: { enoughData: boolean; minOrders: number; assumptions: string[]; next7Revenue: { low: U; mid: U; high: U } | null; next7Costs: U | null; daily: { day: string; revenue: number }[] };
  runway: { purchasesLeft: number; gasOrdersLeft: number | null; gasAssumption: string; refundExposure: U; reserveCoversRefunds: boolean };
  obligations: { subscriptionIssues: number; subscriptionEscrow: U; openOrders: number; openOrdersGross: U; openQuotes: number; openQuotesAmount: U; pendingApprovals: number; pendingApprovalAmount: U; nextIssueAt: number | null };
  savings: { competitions: number; savedUnits: U };
  lean: { active: boolean; reason: string };
  risks: { code: string; severity: "info" | "warn" | "high"; title: string; detail: string; evidence: Record<string, string | number> }[];
  interventions: { code: string; kind: "autonomous" | "needs_owner"; title: string; detail: string; where?: string; effect: string; evidence: Record<string, string | number> }[];
}
interface HealthEvent { id: string; kind: string; code: string; severity: string | null; mode: string | null; status: string; title: string; detail: string | null; evidence: Record<string, unknown>; policy_check: { rule?: string; policy_version?: number | null }; tx_hash: string | null; explorer_url: string | null; created_at: string; resolved_at: string | null }

const STATUS = {
  healthy: { label: "Healthy", tone: "live" as const, note: "Nothing needs you. The agent keeps running inside your limits." },
  watch: { label: "Watch", tone: "warn" as const, note: "Something is drifting. Details and suggested fixes below." },
  at_risk: { label: "At risk", tone: "down" as const, note: "The business may not meet an obligation without you. See what needs you." },
};
const pct = (bps: number | null) => (bps === null ? "—" : `${(bps / 100).toFixed(1)}%`);
const time = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function HealthPanel() {
  const [data, setData] = useState<{ health: HealthData; events: HealthEvent[]; readAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/owner/health", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not read the business health");
      setData(j);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  if (error && !data) return <p role="alert" className="mt-6 rounded-md bg-failed-soft p-3 text-sm text-failed">{error}</p>;
  if (!data)
    return (
      <div className="mt-6 space-y-4">
        <div className="skeleton h-20" />
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-28" />)}</div>
        <div className="skeleton h-72" />
      </div>
    );

  const h = data.health;
  const s = STATUS[h.status];
  const auto = h.interventions.filter((i) => i.kind === "autonomous");
  const owner = h.interventions.filter((i) => i.kind === "needs_owner");

  return (
    <div className="enter mt-6 space-y-6">
      <section className={`lift relative overflow-hidden rounded-[var(--radius-card)] border bg-surface p-5 ${h.status === "healthy" ? "border-rule" : h.status === "watch" ? "border-pending/40" : "border-failed/40"}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <LivePill tone={s.tone}>{s.label}</LivePill>
            <h2 className="text-lg font-medium">Autonomous business health</h2>
          </div>
          <span className="flex items-center gap-1.5 text-xs text-ink-3">
            <LiveDot tone="live" /> Computed from real records at {new Date(data.readAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        </div>
        <p className="mt-2 text-sm text-ink-2">{s.note}</p>
        {h.lean.active && <p className="mt-2 text-sm text-pending">Lean mode is on: {h.lean.reason}. Single orders skip optional datasets until margins recover.</p>}
      </section>

      <section className="stagger grid grid-cols-2 gap-3 xl:grid-cols-5">
        <Tile icon={TrendingUp} label="Net margin, 7 days" value={pct(h.week.marginBps)} foot={<>last week {pct(h.prevWeek.marginBps)}</>} />
        <Tile icon={Activity} label="Cost per order" value={h.week.costPerOrder ? <Money units={h.week.costPerOrder} /> : "—"} foot={<>{h.week.orders} paid order{h.week.orders === 1 ? "" : "s"} this week</>} />
        <Tile icon={ShoppingCart} label="Data runway" value={<span className="font-mono tabular">{h.runway.purchasesLeft}</span>} foot="purchases the chain treasuries can still pay, at this hour's prices" />
        <Tile icon={Fuel} label="Gas runway" value={<span className="font-mono tabular">{h.runway.gasOrdersLeft ?? "—"}</span>} foot={<>orders · {h.runway.gasAssumption}</>} />
        <Tile icon={PiggyBank} label="Saved by competition" value={<Money units={h.savings.savedUnits} />} foot={<>vs the dearest eligible bid, {h.savings.competitions} purchase{h.savings.competitions === 1 ? "" : "s"}</>} />
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card title="Cash flow: 14 days actual, 7 days forecast">
          <CashChart daily={h.daily} forecast={h.forecast.daily} />
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-[0.06em] text-ink-3">Actual, last 7 days</p>
              <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-sm">
                <dt className="text-ink-3">Revenue</dt><dd className="text-right"><Money units={h.week.revenue} /></dd>
                <dt className="text-ink-3">Data vendors</dt><dd className="text-right"><Money units={h.week.vendorSpend} /></dd>
                <dt className="text-ink-3">AI inference</dt><dd className="text-right"><Money units={h.week.inference} /></dd>
                <dt className="font-medium">Net</dt><dd className="text-right font-medium"><Money units={h.week.net} /></dd>
              </dl>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.06em] text-ink-3">Forecast, next 7 days</p>
              {h.forecast.next7Revenue ? (
                <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-sm">
                  <dt className="text-ink-3">Revenue (likely)</dt><dd className="text-right"><Money units={h.forecast.next7Revenue.mid} /></dd>
                  <dt className="text-ink-3">Range</dt><dd className="text-right text-xs text-ink-2"><Money units={h.forecast.next7Revenue.low} /> – <Money units={h.forecast.next7Revenue.high} /></dd>
                  <dt className="text-ink-3">Costs</dt><dd className="text-right"><Money units={h.forecast.next7Costs ?? "0"} /></dd>
                </dl>
              ) : (
                <p className="mt-1 text-sm text-ink-2">Not enough data yet: it takes at least {h.forecast.minOrders} paid orders in 14 days.</p>
              )}
            </div>
          </div>
          <details className="mt-4 rounded-md border border-rule p-3 text-xs text-ink-3">
            <summary className="cursor-pointer text-ink-2">How the forecast is made (it is an estimate, not a balance)</summary>
            <ul className="mt-2 list-disc space-y-1 pl-4">{h.forecast.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
          </details>
        </Card>

        <Card title="Upcoming obligations">
          <ul className="divide-y divide-rule text-sm">
            <Row k="Subscription issues still owed" sub={h.obligations.nextIssueAt ? `next due ${time(new Date(h.obligations.nextIssueAt).toISOString())}` : "none scheduled"} v={<><span className="mr-2 text-ink-3"><span className="font-mono tabular text-ink-2">{h.obligations.subscriptionIssues}</span> {h.obligations.subscriptionIssues === 1 ? "issue" : "issues"} ·</span><Money units={h.obligations.subscriptionEscrow} /></>} />
            <Row k="Paid orders to deliver" sub="customer prepaid; a report or a refund is owed" v={<><span className="mr-2 text-ink-3"><span className="font-mono tabular text-ink-2">{h.obligations.openOrders}</span> {h.obligations.openOrders === 1 ? "order" : "orders"} ·</span><Money units={h.obligations.openOrdersGross} /></>} />
            <Row k="Open quotes" sub="not paid yet; become orders if accepted" v={<><span className="mr-2 text-ink-3"><span className="font-mono tabular text-ink-2">{h.obligations.openQuotes}</span> {h.obligations.openQuotes === 1 ? "quote" : "quotes"} ·</span><Money units={h.obligations.openQuotesAmount} /></>} />
            <Row k="Purchases waiting for you" sub="paused until you approve or reject" v={<><span className="mr-2 text-ink-3"><span className="font-mono tabular text-ink-2">{h.obligations.pendingApprovals}</span> {h.obligations.pendingApprovals === 1 ? "purchase" : "purchases"} ·</span><Money units={h.obligations.pendingApprovalAmount} /></>} />
            <Row k="Refund exposure" sub={h.runway.reserveCoversRefunds ? "covered by the business reserve" : "more than the reserve holds"} v={<span className={h.runway.reserveCoversRefunds ? "" : "text-failed"}><Money units={h.runway.refundExposure} /></span>} />
          </ul>
          <p className="mt-3 text-xs text-ink-3">Subscription escrow and order payments are held by the contract, not by the agent; they can only go to delivery or back to the customer.</p>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={`Detected risks${h.risks.length ? ` (${h.risks.length})` : ""}`}>
          {h.risks.length === 0 ? (
            <p className="text-sm text-ink-3">No risks detected by the 8 rules.</p>
          ) : (
            <ul className="space-y-3">
              {h.risks.map((r) => (
                <li key={r.code} className="rounded-lg border border-rule p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium">{r.title}</span>
                    <LivePill tone={r.severity === "high" ? "down" : r.severity === "warn" ? "warn" : "off"}>{r.severity === "high" ? "High" : r.severity === "warn" ? "Watch" : "Info"}</LivePill>
                  </div>
                  <p className="mt-1 text-xs text-ink-2">{r.detail}</p>
                  <Evidence e={r.evidence} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Interventions">
          <p className="text-xs uppercase tracking-[0.06em] text-ink-3">Taken by the agent</p>
          {auto.length === 0 ? <p className="mt-1 text-sm text-ink-3">None needed right now.</p> : auto.map((i) => <Intervention key={i.code} i={i} />)}
          <p className="mt-4 text-xs uppercase tracking-[0.06em] text-ink-3">Needs you</p>
          {owner.length === 0 ? <p className="mt-1 text-sm text-ink-3">Nothing to approve.</p> : owner.map((i) => <Intervention key={i.code} i={i} />)}
          <p className="mt-4 text-xs text-ink-3">The agent acts alone only to spend less or to use a power the contract already gives it (a capped gas refill). Anything that moves money or changes the rules is proposed here and signed by you.</p>
        </Card>
      </div>

      <Card title="Audit trail">
        {data.events.length === 0 ? (
          <p className="text-sm text-ink-3">The engine records here every risk it opens or resolves and every action it takes or proposes. It runs every few minutes.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.06em] text-ink-3">
                  <th className="pb-2 font-medium">When</th>
                  <th className="pb-2 font-medium">What</th>
                  <th className="pb-2 font-medium">Policy check</th>
                  <th className="pb-2 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {data.events.map((e) => (
                  <tr key={e.id} className="align-top">
                    <td className="py-2 pr-3 font-mono text-xs text-ink-3">{time(e.created_at)}</td>
                    <td className="py-2 pr-3">
                      <div>{e.title}</div>
                      {e.explorer_url && <a href={e.explorer_url} target="_blank" rel="noreferrer" className="font-mono text-xs text-accent">tx {e.tx_hash?.slice(0, 10)}… ↗</a>}
                    </td>
                    <td className="py-2 pr-3 text-xs text-ink-3">{e.kind === "risk" ? "Detection only; moves nothing" : (e.policy_check?.rule ?? "")}{e.policy_check?.policy_version ? ` (policy v${e.policy_check.policy_version})` : ""}</td>
                    <td className="py-2 text-right">
                      <LivePill tone={e.status === "executed" ? "live" : e.status === "proposed" || e.status === "open" ? (e.resolved_at ? "off" : "warn") : "off"}>
                        {e.status === "open" && !e.resolved_at ? "Open" : e.status === "proposed" && !e.resolved_at ? "Proposed" : e.status === "executed" ? "Executed" : "Resolved"}
                      </LivePill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Tile({ icon: Icon, label, value, foot }: { icon: typeof Activity; label: string; value: React.ReactNode; foot: React.ReactNode }) {
  return (
    <div className="lift rounded-[var(--radius-card)] border border-rule bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm text-ink-3">{label}</span>
        <Icon size={16} strokeWidth={1.6} className="text-ink-3" />
      </div>
      <div className="mt-2 text-[22px] leading-none">{value}</div>
      <p className="mt-2 text-xs text-ink-3">{foot}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-rule bg-surface">
      <h2 className="border-b border-rule px-5 py-3 font-medium">{title}</h2>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Row({ k, sub, v }: { k: string; sub: string; v: React.ReactNode }) {
  return (
    <li className="flex items-start justify-between gap-3 py-2.5">
      <span>
        <span className="block">{k}</span>
        <span className="block text-xs text-ink-3">{sub}</span>
      </span>
      <span className="shrink-0 text-right">{v}</span>
    </li>
  );
}

function Evidence({ e }: { e: Record<string, string | number> }) {
  const entries = Object.entries(e);
  if (!entries.length) return null;
  return (
    <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px] text-ink-3">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt className="inline">{k.replace(/_/g, " ")}: </dt>
          <dd className="inline text-ink-2">{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Intervention({ i }: { i: HealthData["interventions"][number] }) {
  return (
    <div className="mt-2 rounded-lg border border-rule p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium">{i.title}</span>
        <LivePill tone={i.kind === "autonomous" ? "live" : "warn"}>{i.kind === "autonomous" ? "Autonomous" : "Needs you"}</LivePill>
      </div>
      <p className="mt-1 text-xs text-ink-2">{i.detail}</p>
      {i.where && <a href={`#${i.where}`} className="mt-1 inline-block text-xs text-accent">Open the {i.where} tab →</a>}
      <Evidence e={i.evidence} />
    </div>
  );
}

/** 14 days of actual revenue and costs (bars) and 7 forecast days (dashed line). */
function CashChart({ daily, forecast }: { daily: HealthData["daily"]; forecast: HealthData["forecast"]["daily"] }) {
  const all = [...daily.map((d) => Math.max(d.revenue, d.costs)), ...forecast.map((f) => f.revenue), 1];
  const max = Math.max(...all);
  const n = daily.length + forecast.length;
  const W = 640;
  const H = 180;
  const pad = 20;
  const bw = (W - pad * 2) / Math.max(n, 1);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const fx = (i: number) => pad + (daily.length + i) * bw + bw / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full" role="img" aria-label="Daily revenue and costs, with a 7-day forecast">
      <line x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} stroke="var(--rule-strong)" />
      {daily.map((d, i) => (
        <g key={d.day} className="grow" style={{ transformOrigin: `0 ${H - pad}px`, transformBox: "view-box" }}>
          <rect x={pad + i * bw + bw * 0.12} width={bw * 0.38} y={y(d.revenue)} height={H - pad - y(d.revenue)} rx="2" fill="var(--flow-owner)" opacity="0.85">
            <title>{`${d.day}: revenue ${d.revenue.toFixed(2)} USDC`}</title>
          </rect>
          <rect x={pad + i * bw + bw * 0.5} width={bw * 0.38} y={y(d.costs)} height={H - pad - y(d.costs)} rx="2" fill="var(--accent)" opacity="0.75">
            <title>{`${d.day}: costs ${d.costs.toFixed(2)} USDC`}</title>
          </rect>
        </g>
      ))}
      {forecast.length > 0 && (
        <>
          <rect x={pad + daily.length * bw} y={pad / 2} width={forecast.length * bw} height={H - pad * 1.5} fill="var(--raised)" opacity="0.6" />
          <polyline points={forecast.map((f, i) => `${fx(i)},${y(f.revenue)}`).join(" ")} fill="none" stroke="var(--flow-owner)" strokeWidth="2" strokeDasharray="5 4" className="flow-label" />
          <text x={pad + daily.length * bw + 6} y={H - pad - 6} fontSize="11" fill="var(--ink-3)">forecast</text>
        </>
      )}
      <text x={pad} y={H - 4} fontSize="11" fill="var(--ink-3)">{daily[0]?.day.slice(5)}</text>
      <text x={pad + (daily.length - 1) * bw} y={H - 4} fontSize="11" fill="var(--ink-3)">today</text>
      <g fontSize="11" fill="var(--ink-3)">
        <rect x={W - 200} y={6} width="9" height="9" rx="2" fill="var(--flow-owner)" />
        <text x={W - 186} y={14}>revenue</text>
        <rect x={W - 130} y={6} width="9" height="9" rx="2" fill="var(--accent)" />
        <text x={W - 116} y={14}>data + AI costs</text>
      </g>
    </svg>
  );
}
