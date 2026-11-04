"use client";

import { useEffect, useState } from "react";
import { SiteHeader } from "@/components/site-header";

type Outcome = "BLOCKED" | "NOT_BLOCKED" | "ERROR";
type EvidenceKind = "signed_inference" | "policy_engine" | "custody_policy" | "onchain_tx";

interface Defence { layer: string; kind: EvidenceKind; held: boolean; breached?: boolean; detail: string; txHash?: string; explorerUrl?: string }
interface AttackResult { key: string; title: string; goal: string; attempt: string; outcome: Outcome; defences: Defence[]; error?: string }
interface Run { id: string; startedAt: string; finishedAt: string; agentAccount: string; contractId: string; results: AttackResult[] }

const KIND: Record<EvidenceKind, string> = {
  signed_inference: "Signed TEE inference",
  policy_engine: "Deterministic check",
  custody_policy: "Custody refusal",
  onchain_tx: "On-chain transaction",
};

const OUTCOME: Record<Outcome, { label: string; className: string }> = {
  BLOCKED: { label: "Blocked", className: "bg-real-soft text-real" },
  NOT_BLOCKED: { label: "Not blocked", className: "bg-failed-soft text-failed" },
  ERROR: { label: "Did not run", className: "bg-pending-soft text-pending" },
};

const LAYERS = [
  ["Model instructions", "The customer brief is wrapped as untrusted data. The model is told to ignore instructions inside it and to flag them."],
  ["No money path from text", "Model output never chooses a payee or an amount. Those come from the owner's configuration."],
  ["Policy engine", "Deterministic rules checked before every action: allowlist, limits, budgets, approvals. Prohibitions cannot be approved away."],
  ["Custody policy (OutLayer)", "The agent's key lives in a TEE. Its signing policy allows calls to one contract only."],
  ["Business contract (NEAR)", "Holds the money. Only approved vendors, a per-order cap, owner-only configuration, owner approvals above the threshold."],
];

export default function SecurityPage() {
  const [run, setRun] = useState<Run | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      fetch("/api/security", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => (j.error ? setError(j.error) : setRun(j.run)))
        .catch((e) => setError(String(e)));
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const blocked = run?.results.filter((r) => r.outcome === "BLOCKED").length ?? 0;

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <SiteHeader />
      <p className="mt-10 font-mono text-xs uppercase tracking-wider text-ink-3">Red team</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Can the agent be turned against its owner?</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-2">
        We attack our own business the way a prompt injection or a hijacked server would. Every attack runs for real against the live
        testnet business. Rejected transactions are real failed transactions you can open on the explorer. No funds move.
      </p>

      <section className="mt-8 grid gap-3 sm:grid-cols-5">
        {LAYERS.map(([name, text], i) => (
          <div key={name} className="rounded-[var(--radius-card)] border border-rule bg-surface p-4">
            <div className="font-mono text-xs text-ink-3">Layer {i + 1}</div>
            <div className="mt-1 text-sm font-medium">{name}</div>
            <p className="mt-1 text-xs text-ink-2">{text}</p>
          </div>
        ))}
      </section>

      {error && <p role="alert" className="mt-6 rounded-md bg-failed-soft p-3 text-sm text-failed">Could not load the results: {error}</p>}
      {run === undefined && !error && <p className="mt-8 text-ink-3">Loading…</p>}
      {run === null && <p className="mt-8 rounded-md border border-rule bg-surface p-5 text-ink-3">The attack suite has not been run yet.</p>}

      {run && (
        <>
          <div className="mt-10 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">
              {blocked} of {run.results.length} attacks blocked
            </h2>
            <p className="font-mono text-xs text-ink-3">
              run {run.id} · {run.finishedAt.replace("T", " ").slice(0, 19)} UTC · agent {run.agentAccount.slice(0, 10)}…
            </p>
          </div>
          <div className="mt-4 space-y-4">
            {run.results.map((a, i) => (
              <article key={a.key} className="overflow-hidden rounded-[var(--radius-card)] border border-rule bg-surface">
                <header className="flex flex-wrap items-start justify-between gap-3 border-b border-rule p-4">
                  <div>
                    <div className="font-mono text-xs text-ink-3">Attack {i + 1}</div>
                    <h3 className="font-medium">{a.title}</h3>
                    <p className="mt-1 text-sm text-ink-2">Goal: {a.goal}</p>
                  </div>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${OUTCOME[a.outcome].className}`}>{OUTCOME[a.outcome].label}</span>
                </header>
                <div className="p-4">
                  <div className="text-xs text-ink-3">What the attacker sent</div>
                  <pre className="mt-1 whitespace-pre-wrap break-words rounded-md bg-paper p-3 font-mono text-xs text-ink-2">{a.attempt}</pre>
                  {a.error && <p className="mt-3 text-sm text-pending">Error: {a.error}</p>}
                  <ol className="mt-4 space-y-3">
                    {a.defences.map((d) => (
                      <li key={d.layer} className="flex gap-3">
                        <span aria-hidden className={`mt-0.5 font-mono text-sm ${d.breached ? "text-failed" : d.held ? "text-real" : "text-ink-3"}`}>{d.breached ? "✕" : d.held ? "■" : "□"}</span>
                        <div className="min-w-0">
                          <div className="text-sm font-medium">
                            {d.layer} <span className="ml-1 rounded border border-rule px-1.5 py-0.5 font-mono text-[11px] font-normal text-ink-3">{KIND[d.kind]}</span>
                            {!d.held && !d.breached && <span className="ml-1 text-xs font-normal text-ink-3">(did not stop it)</span>}
                          </div>
                          <p className="mt-0.5 break-words text-sm text-ink-2">{d.detail}</p>
                          {d.explorerUrl && (
                            <a href={d.explorerUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block font-mono text-xs text-accent">
                              tx {d.txHash?.slice(0, 12)}… ↗
                            </a>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      <section className="mt-10 rounded-[var(--radius-card)] border border-rule bg-surface p-5 text-sm text-ink-2">
        <h2 className="text-base font-semibold text-ink">Try it yourself</h2>
        <p className="mt-1">
          Order a report from the <a href="/store" className="text-accent">store</a> and paste a malicious instruction into the brief. The
          agent records any injection it detects in the audit log, and whatever the model says, the only payment it can make is to the
          approved vendor, at the listed price, within the order&apos;s cap.
        </p>
      </section>
    </main>
  );
}
