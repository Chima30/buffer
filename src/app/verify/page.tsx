"use client";

import { Check as CheckIcon, Minus, X } from "lucide-react";
import { useEffect, useState } from "react";

interface Check {
  group: string;
  name: string;
  ok: boolean | null;
  detail: string;
}

const EXAMPLE = "o-91336486ee60";

export default function VerifyPage() {
  const [order, setOrder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);

  async function run(ref: string) {
    if (!ref.trim()) return;
    setBusy(true);
    setError(null);
    setChecks(null);
    try {
      const res = await fetch("/api/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order: ref.trim() }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Verification could not finish");
      setChecks(j.checks);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // /verify?order=… (linked from an order page) runs straight away.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("order");
    if (!q) return;
    const t = setTimeout(() => {
      setOrder(q);
      run(q);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const passed = checks?.filter((c) => c.ok === true).length ?? 0;
  const failed = checks?.filter((c) => c.ok === false).length ?? 0;
  const groups = checks ? [...new Set(checks.map((c) => c.group))] : [];

  return (
    <main className="enter max-w-[56rem]">
      <p className="text-sm text-ink-3">Verify</p>
      <h1 className="mt-1 text-[28px] font-medium leading-[1.15] tracking-[-0.02em] sm:text-[32px]">Check any order against the chains</h1>
      <p className="mt-3 text-ink-2">
        Paste an order link or id. Every check re-reads public chains: the payment and the report hash on NEAR, each data purchase on NEAR or the EVM testnet it was paid on, the MPC signature behind it, the TEE signatures on the AI&apos;s work, NVIDIA&apos;s GPU verdict and the 70/30 settlement math.
      </p>

      <form
        className="mt-6 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          run(order);
        }}
      >
        <input
          value={order}
          onChange={(e) => setOrder(e.target.value)}
          placeholder={`https://buffer-zeta.vercel.app/orders/…  or  ${EXAMPLE}`}
          className="h-10 min-w-0 flex-1 rounded-lg border border-rule-strong bg-surface px-3 font-mono text-sm outline-none focus:border-ink/40"
          aria-label="Order link or id"
        />
        <button type="submit" disabled={busy || !order.trim()} className="press h-10 rounded-lg bg-ink px-4 text-sm font-medium text-paper transition-opacity duration-150 hover:opacity-90 disabled:opacity-50">
          {busy ? "Checking the chains…" : "Verify"}
        </button>
      </form>
      <button
        type="button"
        onClick={() => {
          setOrder(EXAMPLE);
          run(EXAMPLE);
        }}
        disabled={busy}
        className="mt-2 text-sm text-accent disabled:opacity-50"
      >
        Try a settled cross-chain order ({EXAMPLE})
      </button>
      <p className="mt-1 text-xs text-ink-3">Include the #t=… part of your own order&apos;s link to also check that the report you received is the one hashed on-chain.</p>

      {error && <p role="alert" className="mt-6 rounded-md bg-failed-soft p-3 text-sm text-failed">{error}</p>}

      {busy && (
        <div className="mt-8 space-y-3" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-12" />
          ))}
        </div>
      )}

      {checks && (
        <>
          <div className={`mt-8 rounded-[var(--radius-card)] border p-4 ${failed ? "border-failed/30 bg-failed-soft" : "border-real/30 bg-real-soft"}`}>
            <p className={`font-medium ${failed ? "text-failed" : "text-real"}`}>
              {failed ? `${failed} check${failed === 1 ? "" : "s"} failed` : "Everything checked matches the chains"}
            </p>
            <p className="mt-0.5 text-sm text-ink-2">
              {passed} passed, {failed} failed, {checks.length - passed - failed} not checkable (the reason is given)
            </p>
          </div>
          <div className="stagger mt-6 space-y-6">
            {groups.map((g) => (
              <section key={g} className="rounded-[var(--radius-card)] border border-rule bg-surface">
                <h2 className="border-b border-rule px-5 py-3 font-medium">{g}</h2>
                <ul className="divide-y divide-rule">
                  {checks
                    .filter((c) => c.group === g)
                    .map((c, i) => (
                      <li key={i} className="flex gap-3 px-5 py-3">
                        <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${c.ok === true ? "bg-real-soft text-real" : c.ok === false ? "bg-failed-soft text-failed" : "bg-raised text-ink-3"}`}>
                          {c.ok === true ? <CheckIcon size={12} strokeWidth={2.5} /> : c.ok === false ? <X size={12} strokeWidth={2.5} /> : <Minus size={12} strokeWidth={2.5} />}
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{c.name}</p>
                          <p className="mt-0.5 break-all font-mono text-xs text-ink-3">{c.detail}</p>
                        </div>
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}

      <section className="mt-10 rounded-[var(--radius-card)] border border-rule bg-surface p-5">
        <h2 className="font-medium">Don&apos;t want to trust this website?</h2>
        <p className="mt-1 text-sm text-ink-2">This page runs the checks on our server. The same code runs on your own machine with no keys and no account:</p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-raised p-3 font-mono text-xs">{`git clone https://github.com/Chima30/buffer
cd buffer && npm install
npm run verify -- ${EXAMPLE}`}</pre>
      </section>
    </main>
  );
}
