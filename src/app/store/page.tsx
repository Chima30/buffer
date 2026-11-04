"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SiteHeader } from "@/components/site-header";

interface Product { sku: string; title: string; description: string | null; priceUnits: string; vendor: { name: string; chain: "near" | "sepolia" } }

export default function StorePage() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [sku, setSku] = useState("weekly-market-brief");
  useEffect(() => {
    fetch("/api/products").then((r) => r.json()).then((j) => setProducts(j.products ?? [])).catch(() => setProducts([]));
  }, []);
  const selected = products.find((p) => p.sku === sku);
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
        body: JSON.stringify({ brief, sku, customerAccount: account.trim() || undefined }),
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
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{selected?.title ?? "Weekly Market Brief"}</h1>
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

      {products.length > 1 && (
        <fieldset className="mt-6 grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">Choose a product</legend>
          {products.map((p) => (
            <label key={p.sku} className={`cursor-pointer rounded-[var(--radius-card)] border p-4 text-sm ${p.sku === sku ? "border-accent bg-accent-soft" : "border-rule bg-surface"}`}>
              <input type="radio" name="sku" value={p.sku} checked={p.sku === sku} onChange={() => setSku(p.sku)} className="sr-only" />
              <span className="font-medium">{p.title}</span>
              <span className="mt-1 block text-xs text-ink-2">{p.description}</span>
              <span className="mt-2 block text-xs text-ink-3">
                Dataset vendor paid {p.vendor.chain === "sepolia" ? "on Ethereum Sepolia via NEAR Chain Signatures" : "on NEAR by the business contract"}
              </span>
            </label>
          ))}
        </fieldset>
      )}

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
