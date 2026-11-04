"use client";

import { useState } from "react";
import { txHashOf, useNearWallet } from "@/components/wallet";

interface Draft {
  contractId: string;
  policyHash: string;
  policy: { rules: { limits: { per_transaction_units: string; daily_units: string }; inference: { daily_usd_micros: string }; approvals: { description: string }[]; prohibitions: { description: string }[]; revenue: { contributor_bps: number } } };
  changes: { label: string; from: string; to: string }[];
  warnings: string[];
  errors: string[];
  checklist: { step: string; detail: string; command?: string; call?: { contractId: string; method: string; args: Record<string, unknown> } }[];
  translation: { verification: string; unsupported: string[] } | null;
}

const usd = (units: string) => (Number(units) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });

const FIELDS: { key: string; label: string; placeholder: string; hint?: string }[] = [
  { key: "businessName", label: "Business name", placeholder: "Lagos Price Watch" },
  { key: "owner", label: "Owner NEAR account", placeholder: "you.testnet", hint: "Filled from your connected wallet. Signs every rule change, approval and emergency stop." },
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
  const wallet = useNearWallet();
  const [pendingBuild, setPendingBuild] = useState(false);
  // The connected wallet is the owner unless the user typed another account.
  const owner = form.owner ?? wallet.signedAccountId ?? "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    let account = wallet.signedAccountId;
    if (!account) {
      setPendingBuild(true);
      try {
        await wallet.signIn();
        const accounts = await wallet.connector?.getConnectedWallet().then((c) => c.accounts).catch(() => []);
        account = accounts?.[0]?.accountId ?? "";
      } catch {
        account = "";
      } finally {
        setPendingBuild(false);
      }
      if (!account) return setError("Connect a NEAR testnet wallet to build the plan.");
    }
    await build({ ...form, owner: form.owner?.trim() ? form.owner : account });
  }

  async function build(values: Record<string, string>) {
    setBusy(true);
    setError(null);
    setDraft(null);
    try {
      const res = await fetch("/api/onboarding/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, contributorPercent: Number(values.contributorPercent) }),
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
        Describe what you sell and how the agent may spend. You get the starting policy with its hash, the contract settings and a launch checklist. Connect your NEAR wallet to start. Building the plan signs nothing: you approve each launch step yourself.
      </p>

      <form onSubmit={submit} className="mt-8 grid gap-4 rounded-[var(--radius-card)] border border-rule bg-surface p-5 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.key} className="block text-sm">
            <span className="font-medium">{f.label}</span>
            <input required={f.key !== "owner" || !!wallet.signedAccountId} value={f.key === "owner" ? owner : (form[f.key] ?? "")} onChange={set(f.key)} placeholder={f.placeholder} className="mt-1 w-full rounded-md border border-rule-strong bg-paper p-2 text-sm" />
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
        <button disabled={busy} className="rounded-md bg-ink px-4 py-2.5 text-sm font-medium text-paper disabled:opacity-60 sm:col-span-2">{busy ? "Building the plan…" : pendingBuild ? "Waiting for your wallet…" : wallet.signedAccountId ? "Build the plan" : "Connect wallet and build the plan"}</button>
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
            <ul className="mt-3 space-y-5 text-sm">
              {draft.checklist.map((c, i) => (
                <li key={c.step} className="grid grid-cols-[24px_1fr] gap-x-2">
                  <span className="font-mono text-xs leading-5 text-ink-3">{String(i + 1).padStart(2, "0")}</span>
                  <div className="min-w-0">
                    <div className="font-medium">{c.step}</div>
                    <p className="text-xs text-ink-2">{c.detail}</p>
                    {c.call && <WalletStep call={c.call} owner={owner} />}
                    {c.command && (
                      <details className="mt-2" open={!c.call}>
                        <summary className="cursor-pointer text-xs text-ink-2">{c.call ? "Or with near-cli" : "near-cli command"}</summary>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-paper p-2 font-mono text-[11px]">{c.command}</pre>
                        <button type="button" onClick={() => navigator.clipboard.writeText(c.command ?? "")} className="mt-1 text-xs text-accent">Copy</button>
                      </details>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </main>
  );
}

/** Signs one checklist step with the connected NEAR wallet, if it is the owner's. */
function WalletStep({ call, owner }: { call: { contractId: string; method: string; args: Record<string, unknown> }; owner: string }) {
  const wallet = useNearWallet();
  const [state, setState] = useState<{ tone: "ok" | "err" | "busy"; text: string } | null>(null);
  const isOwner = wallet.signedAccountId === owner;
  async function sign() {
    setState({ tone: "busy", text: "Approve it in your wallet" });
    try {
      const outcome = await wallet.callFunctionRaw({ contractId: call.contractId, method: call.method, args: call.args, gas: "30000000000000", deposit: "0" });
      const hash = txHashOf(outcome);
      setState({ tone: "ok", text: hash ? `Signed: tx ${hash.slice(0, 10)}…` : "Signed" });
    } catch (e) {
      setState({ tone: "err", text: (e as Error).message });
    }
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" disabled={!isOwner || state?.tone === "busy"} onClick={sign} className="press h-8 rounded-lg bg-ink px-3 text-xs font-medium text-paper transition-opacity duration-150 hover:opacity-90 disabled:opacity-40">
        Sign with wallet
      </button>
      <span className={`text-xs ${state?.tone === "err" ? "text-failed" : state?.tone === "ok" ? "text-real" : "text-ink-3"}`}>
        {state?.text ?? (wallet.signedAccountId ? (isOwner ? "" : `Connected as ${wallet.signedAccountId}; connect ${owner} to sign`) : `Connect ${owner} with the wallet button to sign`)}
      </span>
    </div>
  );
}
