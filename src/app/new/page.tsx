"use client";

import { useState } from "react";

interface Draft {
  contractId: string;
  policyHash: string;
  policy: { rules: { limits: { per_transaction_units: string; daily_units: string }; inference: { daily_usd_micros: string }; approvals: { description: string }[]; prohibitions: { description: string }[]; revenue: { contributor_bps: number } } };
  changes: { label: string; from: string; to: string }[];
  warnings: string[];
  errors: string[];
  checklist: { step: string; detail: string; command?: string }[];
  translation: { verification: string; unsupported: string[] } | null;
}

const usd = (units: string) => (Number(units) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });

const FIELDS: { key: string; label: string; placeholder: string; hint?: string }[] = [
  { key: "businessName", label: "Business name", placeholder: "Lagos Price Watch" },
  { key: "owner", label: "Owner NEAR account", placeholder: "you.testnet", hint: "Signs every rule change, approval and emergency stop." },
  { key: "contributor", label: "Contributor NEAR account", placeholder: "partner.testnet", hint: "Receives a share of net revenue." },
  { key: "productTitle", label: "What you sell", placeholder: "Weekly food price report" },
  { key: "productSku", label: "Product id", placeholder: "food-prices", hint: "Lowercase letters, digits and dashes." },
  { key: "price", label: "Price (USDC)", placeholder: "15" },
  { key: "maxExpense", label: "Most the agent may spend per order (USDC)", placeholder: "9" },
  { key: "vendorName", label: "Data vendor", placeholder: "Market Data Co" },
  { key: "vendorAccount", label: "Vendor account", placeholder: "marketdata.testnet or 0x…" },
  { key: "vendorPrice", label: "Vendor price (USDC)", placeholder: "6" },
];

export default function NewBusinessPage() {
  const [form, setForm] = useState<Record<string, string>>({ contributorPercent: "30", vendorChain: "near", rules: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDraft(null);
    try {
      const res = await fetch("/api/onboarding/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, contributorPercent: Number(form.contributorPercent) }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not build the draft");
      setDraft(j);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!draft) return;
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${draft.contractId}-plan.json`;
    a.click();
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <main className="enter">
      <p className="text-sm text-ink-3">Start a business</p>
      <h1 className="mt-1 text-[28px] font-medium leading-[1.15] tracking-[-0.02em] sm:text-[32px]">Your rules, an AI agent, a contract that enforces them</h1>
      <p className="mt-2 text-sm text-ink-2">
        Describe what you sell and how the agent may spend. You get the starting policy with its hash, the contract settings and a launch checklist. Nothing is created or signed here: you run each step yourself.
      </p>

      <form onSubmit={submit} className="mt-8 grid gap-4 rounded-[var(--radius-card)] border border-rule bg-surface p-5 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.key} className="block text-sm">
            <span className="font-medium">{f.label}</span>
            <input required value={form[f.key] ?? ""} onChange={set(f.key)} placeholder={f.placeholder} className="mt-1 w-full rounded-md border border-rule-strong bg-paper p-2 text-sm" />
            {f.hint && <span className="mt-0.5 block text-xs text-ink-3">{f.hint}</span>}
          </label>
        ))}
        <label className="block text-sm">
          <span className="font-medium">Vendor is paid on</span>
          <select value={form.vendorChain} onChange={set("vendorChain")} className="mt-1 w-full rounded-md border border-rule-strong bg-paper p-2 text-sm">
            <option value="near">NEAR (from each order&apos;s escrow)</option>
            <option value="sepolia">Ethereum Sepolia (Chain Signatures)</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Contributor share of net revenue (%)</span>
          <input type="number" min={0} max={100} required value={form.contributorPercent} onChange={set("contributorPercent")} className="mt-1 w-full rounded-md border border-rule-strong bg-paper p-2 text-sm" />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="font-medium">Extra rules in plain English <span className="font-normal text-ink-3">(optional)</span></span>
          <textarea value={form.rules} onChange={set("rules")} rows={3} maxLength={1000} placeholder="e.g. Purchases above $5 need my approval. Keep AI spending under $5 a day." className="mt-1 w-full rounded-md border border-rule-strong bg-paper p-2 text-sm" />
        </label>
        {error && <p role="alert" className="rounded-md bg-failed-soft p-3 text-sm text-failed sm:col-span-2">{error}</p>}
        <button disabled={busy} className="rounded-md bg-ink px-4 py-2.5 text-sm font-medium text-paper disabled:opacity-60 sm:col-span-2">{busy ? "Building the plan…" : "Build the plan"}</button>
      </form>

      {draft && (
        <section className="mt-8 space-y-6">
          <div className="rounded-[var(--radius-card)] border border-rule bg-surface p-5 text-sm">
            <h2 className="font-medium">Policy v1</h2>
            <ul className="mt-2 space-y-1 text-ink-2">
              <li>Agent may spend at most {usd(draft.policy.rules.limits.per_transaction_units)} USDC per purchase, {usd(draft.policy.rules.limits.daily_units)} USDC a day</li>
              <li>AI inference budget: {usd(draft.policy.rules.inference.daily_usd_micros)} USD a day</li>
              {draft.policy.rules.approvals.map((a) => <li key={a.description}>{a.description}</li>)}
              {draft.policy.rules.prohibitions.map((p) => <li key={p.description}>{p.description} (no approval can override this)</li>)}
              <li>Net revenue split: {100 - draft.policy.rules.revenue.contributor_bps / 100}% owner, {draft.policy.rules.revenue.contributor_bps / 100}% contributor</li>
            </ul>
            {draft.changes.length > 0 && <p className="mt-3 text-xs text-ink-3">From your rules: {draft.changes.map((c) => `${c.label} ${c.from} → ${c.to}`).join("; ")}</p>}
            {draft.translation?.unsupported.map((u) => <p key={u} className="mt-1 text-xs text-pending">Not supported, left out: &ldquo;{u}&rdquo;</p>)}
            {draft.errors.map((e) => <p key={e} className="mt-1 text-xs text-failed">✕ {e}</p>)}
            {draft.warnings.map((w) => <p key={w} className="mt-1 text-xs text-pending">! {w}</p>)}
            <p className="mt-3 break-all font-mono text-xs text-ink-3">sha256 {draft.policyHash}</p>
          </div>

          <div className="rounded-[var(--radius-card)] border border-rule bg-surface p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-medium">Launch checklist for {draft.contractId}</h2>
              <button onClick={download} className="rounded-md border border-rule-strong px-3 py-1 text-xs">Download plan (JSON)</button>
            </div>
            <ol className="mt-3 space-y-4 text-sm">
              {draft.checklist.map((c, i) => (
                <li key={c.step}>
                  <div className="font-medium">{i + 1}. {c.step}</div>
                  <p className="text-xs text-ink-2">{c.detail}</p>
                  {c.command && (
                    <>
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-paper p-2 font-mono text-[11px]">{c.command}</pre>
                      <button type="button" onClick={() => navigator.clipboard.writeText(c.command ?? "")} className="mt-1 text-xs text-accent">Copy</button>
                    </>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}
    </main>
  );
}
