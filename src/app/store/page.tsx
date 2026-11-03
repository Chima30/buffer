"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SiteHeader } from "@/components/site-header";

export default function StorePage() {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [account, setAccount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief, customerAccount: account.trim() || undefined }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not create the order");
      if (account.trim()) sessionStorage.setItem("buffer-payer", account.trim());
      // The access token stays in the URL fragment, which is never sent to the server.
      router.push(`/orders/${j.orderId}#t=${j.accessToken}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10">
      <SiteHeader />
      <section className="mt-12">
        <p className="font-mono text-xs uppercase tracking-wider text-ink-3">Verified Research Desk</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Weekly Market Brief</h1>
        <p className="mt-3 text-ink-2">
          A short, sourced research brief on the topic you choose. An AI agent plans it, may buy a dataset from an approved
          vendor, writes it with private inference on NEAR AI Cloud, and signs off with a verifiable proof.
        </p>
        <dl className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-[var(--radius-card)] border border-rule bg-rule text-sm">
          <div className="bg-surface p-3"><dt className="text-ink-3">Price</dt><dd className="mt-0.5 font-mono tabular">20.00 USDC</dd></div>
          <div className="bg-surface p-3"><dt className="text-ink-3">Pay with</dt><dd className="mt-0.5">Testnet USDC</dd></div>
          <div className="bg-surface p-3"><dt className="text-ink-3">Delivery</dt><dd className="mt-0.5">A few minutes</dd></div>
        </dl>
      </section>

      <form onSubmit={submit} className="mt-8 space-y-5 rounded-[var(--radius-card)] border border-rule bg-surface p-5">
        <label className="block">
          <span className="text-sm font-medium">What should the brief cover?</span>
          <textarea
            required
            minLength={10}
            maxLength={4000}
            rows={5}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="e.g. How AI agents can hold and spend money safely on NEAR, and what limits matter most."
            className="mt-2 w-full rounded-md border border-rule-strong bg-paper p-3 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Your NEAR testnet account <span className="font-normal text-ink-3">(optional, pre-fills the payment command)</span></span>
          <input
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="yourname.testnet"
            className="mt-2 w-full rounded-md border border-rule-strong bg-paper p-2.5 font-mono text-sm outline-none focus:border-accent"
          />
        </label>
        {error && <p role="alert" className="rounded-md bg-failed-soft p-3 text-sm text-failed">{error}</p>}
        <button disabled={busy} className="w-full rounded-md bg-ink px-4 py-2.5 text-sm font-medium text-paper disabled:opacity-60">
          {busy ? "Creating order…" : "Continue to payment"}
        </button>
        <p className="text-xs text-ink-3">Testnet only. Testnet USDC has no value; get some free at faucet.circle.com (NEAR Testnet).</p>
      </form>
    </main>
  );
}
