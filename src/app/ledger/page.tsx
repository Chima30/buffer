"use client";

import { useEffect, useState } from "react";
import { Money } from "@/components/money";
import { SiteHeader } from "@/components/site-header";
import { StatusBadge } from "@/components/status-badge";
import type { LedgerStatus } from "@/lib/domain/ledger";

interface Entry {
  id: number;
  order_id: string | null;
  event_type: string;
  status: LedgerStatus;
  amount_units: string | null;
  counterparty: string | null;
  tx_hash: string | null;
  explorer_url: string | null;
  at: string;
}

export default function LedgerPage() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/ledger", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => (j.error ? setError(j.error) : setEntries(j.entries)))
        .catch((e) => setError(String(e)));
    const first = setTimeout(load, 0);
    const t = setInterval(load, 10_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <SiteHeader />
      <h1 className="mt-10 text-2xl font-semibold tracking-tight">Public business ledger</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-2">
        Every sale, purchase and payout of the Verified Research Desk. Real entries link to the NEAR testnet transaction
        that proves them. Quotes and simulations are labelled and never carry a transaction.
      </p>
      {error && <p role="alert" className="mt-6 rounded-md bg-failed-soft p-3 text-sm text-failed">Could not load the ledger: {error}</p>}
      {!entries && !error && <p className="mt-6 text-ink-3">Loading…</p>}
      {entries && entries.length === 0 && <p className="mt-6 rounded-md border border-rule bg-surface p-5 text-ink-3">No activity yet. The first order will appear here.</p>}
      {entries && entries.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-[var(--radius-card)] border border-rule bg-surface">
          <table className="w-full text-sm">
            <thead className="hidden border-b border-rule text-left text-xs text-ink-3 sm:table-header-group">
              <tr><th className="px-4 py-2 font-normal">Time (UTC)</th><th className="px-4 py-2 font-normal">Event</th><th className="px-4 py-2 font-normal">Status</th><th className="px-4 py-2 text-right font-normal">Amount</th><th className="px-4 py-2 font-normal">Evidence</th></tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {entries.map((e) => (
                <tr key={e.id} className="flex flex-col gap-1 px-4 py-3 sm:table-row sm:px-0 sm:py-0">
                  <td className="font-mono text-xs text-ink-3 sm:px-4 sm:py-2.5">{e.at.replace("T", " ").slice(0, 19)}</td>
                  <td className="sm:px-4 sm:py-2.5">{e.event_type.replace(/_/g, " ")}<div className="truncate text-xs text-ink-3">{e.counterparty}</div></td>
                  <td className="sm:px-4 sm:py-2.5"><StatusBadge status={e.status} /></td>
                  <td className="sm:px-4 sm:py-2.5 sm:text-right">{e.amount_units ? <Money units={e.amount_units} /> : <span className="text-ink-3">n/a</span>}</td>
                  <td className="sm:px-4 sm:py-2.5">{e.explorer_url ? <a href={e.explorer_url} target="_blank" rel="noreferrer" className="font-mono text-xs text-accent">{e.tx_hash?.slice(0, 10)}… ↗</a> : <span className="text-xs text-ink-3">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
