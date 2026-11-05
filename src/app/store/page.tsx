"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cadence } from "@/lib/domain/cadence";
import { rememberLocal } from "@/lib/client/session";

interface Product { sku: string; title: string; description: string | null; priceUnits: string; vendor: { name: string; chain: "near" | "sepolia" } }
interface QuoteOffer { sku: string; title: string; description: string | null; minUnits: string; maxUnits: string }
interface Plan { sku: string; title: string; description: string | null; issuePriceUnits: string; intervalSeconds: number; minIssues: number; maxIssues: number }

const usdc = (units: string | bigint) => (Number(units) / 1e6).toFixed(2);

export default function StorePage() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [quoteOffers, setQuoteOffers] = useState<QuoteOffer[]>([]);
  const [sku, setSku] = useState("weekly-market-brief");
  useEffect(() => {
    fetch("/api/products")
      .then((r) => r.json())
      .then((j) => {
        setProducts(j.products ?? []);
        setPlans(j.subscriptions ?? []);
        setQuoteOffers(j.quotes ?? []);
      })
      .catch(() => setProducts([]))
      .finally(() => setLoaded(true));
  }, []);
  const selected = products.find((p) => p.sku === sku);
  const plan = plans.find((p) => p.sku === sku);
  const quoteOffer = quoteOffers.find((q) => q.sku === sku);
  const [issuesInput, setIssues] = useState<number | null>(null);
  const issues = plan ? Math.min(plan.maxIssues, Math.max(plan.minIssues, issuesInput ?? Math.min(plan.maxIssues, Math.max(plan.minIssues, 4)))) : 0;
  const [brief, setBrief] = useState("");
  const [account, setAccount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (account.trim()) sessionStorage.setItem("buffer-payer", account.trim());
      if (quoteOffer) {
        const res = await fetch("/api/quotes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ request: brief, customerAccount: account.trim() || undefined }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? "Could not get a quote");
        rememberLocal({ kind: "order", id: j.orderId, token: j.accessToken, title: `Quote: ${brief.slice(0, 70)}` });
        router.push(`/orders/${j.orderId}#t=${j.accessToken}`);
        return;
      }
      if (plan) {
        const res = await fetch("/api/subscriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: brief, issues, sku, customerAccount: account.trim() || undefined }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? "Could not create the subscription");
        rememberLocal({ kind: "subscription", id: j.subscriptionId, token: j.accessToken, title: `${plan.title}: ${brief.slice(0, 60)}` });
        router.push(`/subscriptions/${j.subscriptionId}#t=${j.accessToken}`);
        return;
      }
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief, sku, customerAccount: account.trim() || undefined }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not create the order");
      rememberLocal({ kind: "order", id: j.orderId, token: j.accessToken, title: brief.slice(0, 80) });
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
          {!loaded && <p className="rounded-[var(--radius-card)] border border-rule bg-surface p-4 text-sm text-ink-3">Loading products…</p>}
          {(products.length || !loaded ? products : [{ sku: "weekly-market-brief", title: "Weekly Market Brief", description: "A short, sourced research brief on the topic you choose.", priceUnits: "20000000", vendor: { name: "", chain: "near" as const } }]).map((p) => {
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
                    When data is needed, approved vendors on NEAR and six EVM testnets bid, and the cheapest total wins
                  </span>
                </span>
              </label>
            );
          })}
          {quoteOffers.map((p) => {
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
                    <span className="font-mono text-sm tabular">{usdc(p.minUnits)}–{usdc(p.maxUnits)} <span className="text-ink-3">USDC</span></span>
                  </span>
                  <span className="mt-1 block text-sm text-ink-2">{p.description}</span>
                  <span className="mt-2 block text-xs text-ink-3">The AI estimates the work, code sets the price, and the contract refuses any quote outside the owner&apos;s limits.</span>
                </span>
              </label>
            );
          })}
          {plans.map((p) => {
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
                    <span className="font-mono text-sm tabular">{usdc(p.issuePriceUnits)} <span className="text-ink-3">USDC / issue</span></span>
                  </span>
                  <span className="mt-1 block text-sm text-ink-2">{p.description}</span>
                  <span className="mt-2 block text-xs text-ink-3">One issue {cadence(p.intervalSeconds)}. Prepaid into the contract; cancel any time and the unstarted issues come back to you.</span>
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
        <p className="font-medium">{quoteOffer?.title ?? plan?.title ?? selected?.title ?? "Weekly Market Brief"}</p>
        <label className="block">
          <span className="text-sm font-medium">{quoteOffer ? "Describe what you need" : plan ? "What topic should every issue follow?" : "What should the brief cover?"}</span>
          <textarea
            required
            minLength={quoteOffer ? 20 : 10}
            maxLength={plan ? 2000 : 4000}
            rows={5}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="e.g. How AI agents can hold and spend money safely on NEAR, and what limits matter most."
            className="mt-2 w-full rounded-lg border border-rule-strong bg-paper p-3 text-sm outline-none transition-colors duration-150 focus:border-accent"
          />
        </label>
        {plan && (
          <label className="block">
            <span className="text-sm font-medium">Number of issues</span>
            <select value={issues} onChange={(e) => setIssues(Number(e.target.value))} className="mt-2 h-10 w-full rounded-lg border border-rule-strong bg-paper px-3 text-sm">
              {Array.from({ length: plan.maxIssues - plan.minIssues + 1 }, (_, i) => plan.minIssues + i).map((n) => (
                <option key={n} value={n}>
                  {n} issues, {usdc(BigInt(plan.issuePriceUnits) * BigInt(n))} USDC paid once
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-ink-3">The first issue starts as soon as your payment is confirmed, then one {cadence(plan.intervalSeconds)}.</span>
          </label>
        )}
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
          {busy ? (quoteOffer ? "The agent is scoping your request, about 30 seconds…" : plan ? "Creating subscription" : "Creating order") : quoteOffer ? "Get a quote" : "Continue to payment"}
        </button>
        <p className="text-xs text-ink-3">Testnet only. Testnet USDC has no value; get some free at faucet.circle.com, NEAR Testnet.</p>
      </form>
    </main>
  );
}
