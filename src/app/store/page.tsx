"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

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
    <main className="enter grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start">
      <section>
        <p className="text-sm text-ink-3">Store</p>
        <h1 className="mt-1 text-[28px] font-medium leading-[1.15] tracking-[-0.02em] sm:text-[32px]">Order a research brief</h1>
        <p className="mt-3 max-w-[34rem] text-ink-2">
          An AI agent plans your brief, buys a dataset from an approved vendor if it helps, and writes it with private inference on NEAR AI Cloud. You get the report and the proof behind it.
        </p>

        <fieldset className="mt-6 space-y-3">
          <legend className="sr-only">Choose a product</legend>
          {(products.length ? products : [{ sku: "weekly-market-brief", title: "Weekly Market Brief", description: "A short, sourced research brief on the topic you choose.", priceUnits: "20000000", vendor: { name: "", chain: "near" as const } }]).map((p) => {
            const on = p.sku === sku;
            return (
              <label key={p.sku} className={`flex cursor-pointer gap-3 rounded-[var(--radius-card)] border bg-surface p-4 transition-colors duration-150 ${on ? "border-ink/30 shadow-[var(--highlight)]" : "border-rule hover:bg-raised"}`}>
                <input type="radio" name="sku" value={p.sku} checked={on} onChange={() => setSku(p.sku)} className="sr-only" />
                <span aria-hidden className={`mt-1 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${on ? "border-accent" : "border-rule-strong"}`}>
                  <span className={`h-2 w-2 rounded-full bg-accent transition-opacity duration-150 ${on ? "opacity-100" : "opacity-0"}`} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{p.title}</span>
                    <span className="font-mono text-sm tabular">{(Number(p.priceUnits) / 1e6).toFixed(2)} <span className="text-ink-3">USDC</span></span>
                  </span>
                  <span className="mt-1 block text-sm text-ink-2">{p.description}</span>
                  <span className="mt-2 block text-xs text-ink-3">
                    Dataset vendor paid {p.vendor.chain === "sepolia" ? "on Ethereum Sepolia through NEAR Chain Signatures" : "on NEAR by the business contract"}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>

        <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-card)] border border-rule bg-rule text-sm">
          <div className="bg-surface p-4"><dt className="text-ink-3">Pay with</dt><dd className="mt-1">Testnet USDC on NEAR</dd></div>
          <div className="bg-surface p-4"><dt className="text-ink-3">Delivery</dt><dd className="mt-1">A few minutes</dd></div>
        </dl>
      </section>

      <form onSubmit={submit} className="space-y-5 rounded-[var(--radius-card)] border border-rule bg-surface p-5 sm:p-6 lg:sticky lg:top-10">
        <p className="font-medium">{selected?.title ?? "Weekly Market Brief"}</p>
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
            className="mt-2 w-full rounded-lg border border-rule-strong bg-paper p-3 text-sm outline-none transition-colors duration-150 focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Your NEAR testnet account <span className="font-normal text-ink-3">(optional, pre-fills the payment command)</span></span>
          <input
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="yourname.testnet"
            className="mt-2 h-10 w-full rounded-lg border border-rule-strong bg-paper px-3 font-mono text-sm outline-none transition-colors duration-150 focus:border-accent"
          />
        </label>
        {error && <p role="alert" className="rounded-md bg-failed-soft p-3 text-sm text-failed">{error}</p>}
        <button disabled={busy} className="press h-11 w-full rounded-lg bg-ink px-4 text-sm font-medium text-paper transition-opacity duration-150 hover:opacity-90 disabled:opacity-60">
          {busy ? "Creating order" : "Continue to payment"}
        </button>
        <p className="text-xs text-ink-3">Testnet only. Testnet USDC has no value; get some free at faucet.circle.com, NEAR Testnet.</p>
      </form>
    </main>
  );
}
