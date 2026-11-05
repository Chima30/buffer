"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Money } from "@/components/money";
import { useNearWallet } from "@/components/wallet";
import { sessionHeaders, setSession, signInWithWallet, useLocalHistory, useSession } from "@/lib/client/session";

interface Mine {
  account: string;
  orders: { id: string; onchainId: string; state: string; priceUnits: string; title: string; createdAt: string; subscriptionId: string | null; issue: number | null }[];
  subscriptions: { id: string; onchainId: string; state: string; issuesTotal: number; issuesStarted: number; totalUnits: string; title: string; topic: string; createdAt: string }[];
}

const ORDER_STATE: Record<string, string> = {
  CREATED: "Awaiting payment",
  AWAITING_PAYMENT: "Awaiting payment",
  PAID: "Paid",
  PLANNING: "Planning",
  PROCURING: "Buying data",
  AWAITING_APPROVAL: "Waiting for owner",
  DRAFTING: "Writing",
  DELIVERED: "Delivered",
  SETTLING: "Delivered",
  SETTLED: "Delivered",
  REFUND_PENDING: "Refunding",
  REFUNDED: "Refunded",
  FAILED: "Failed",
};
const SUB_STATE: Record<string, string> = { AWAITING_PAYMENT: "Awaiting payment", ACTIVE: "Active", COMPLETED: "All issues started", CANCELLED: "Cancelled" };
const DONE = new Set(["DELIVERED", "SETTLING", "SETTLED", "COMPLETED"]);

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function MyOrdersPage() {
  const wallet = useNearWallet();
  const session = useSession();
  const local = useLocalHistory();
  const [mine, setMine] = useState<Mine | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    const res = await fetch("/api/me/orders", { cache: "no-store", headers: sessionHeaders() });
    if (res.status === 401) {
      setSession(null);
      setMine(null);
      return;
    }
    const j = await res.json();
    if (!res.ok) return setError(j.error ?? "Could not load your orders");
    setMine(j);
  }, [session]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  async function signIn() {
    if (!wallet.signedAccountId) return wallet.signIn();
    setBusy(true);
    setError(null);
    try {
      await signInWithWallet(wallet);
    } catch (e) {
      setError((e as Error).message || "Sign-in was cancelled");
    } finally {
      setBusy(false);
    }
  }

  const singles = mine?.orders.filter((o) => !o.subscriptionId) ?? [];
  const known = new Set([...(mine?.orders.map((o) => o.id) ?? []), ...(mine?.subscriptions.map((s) => s.id) ?? [])]);
  const browserOnly = local.filter((i) => !known.has(i.id));

  return (
    <main className="enter">
      <p className="text-sm text-ink-3">My orders</p>
      <h1 className="mt-1 text-[28px] font-medium leading-[1.15] tracking-[-0.02em] sm:text-[32px]">Your briefs and subscriptions</h1>

      {!session ? (
        <section className="mt-6 max-w-[40rem] rounded-[var(--radius-card)] border border-rule bg-surface p-5">
          <p className="font-medium">Sign in with the wallet you paid from</p>
          <p className="mt-1 text-sm text-ink-2">
            You sign a short message to prove the account is yours. It is not a transaction and costs nothing. Then you see every order and subscription paid from that account, with the full reports, on any device.
          </p>
          <button type="button" onClick={signIn} disabled={busy} className="press mt-4 h-10 rounded-lg bg-ink px-4 text-sm font-medium text-paper transition-opacity duration-150 hover:opacity-90 disabled:opacity-60">
            {busy ? "Waiting for your wallet…" : wallet.signedAccountId ? `Sign in as ${wallet.signedAccountId}` : "Connect wallet"}
          </button>
          {error && <p role="alert" className="mt-3 rounded-md bg-failed-soft p-3 text-sm text-failed">{error}</p>}
        </section>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
          <span>
            Signed in as <span className="font-mono">{session.accountId}</span>
          </span>
          <button type="button" onClick={() => setSession(null)} className="text-accent">
            Sign out
          </button>
        </div>
      )}

      {session && mine && (
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <List title="Subscriptions" empty="No subscriptions from this account yet.">
            {mine.subscriptions.map((s) => (
              <Row key={s.id} href={`/subscriptions/${s.id}`} title={s.topic} meta={`${s.onchainId} · ${day(s.createdAt)}`} status={`${SUB_STATE[s.state] ?? s.state} · ${s.issuesStarted}/${s.issuesTotal}`} done={s.state === "COMPLETED"} units={s.totalUnits} />
            ))}
          </List>
          <List title="Single orders" empty="No single orders from this account yet.">
            {singles.map((o) => (
              <Row key={o.id} href={`/orders/${o.id}`} title={o.title} meta={`${o.onchainId} · ${day(o.createdAt)}`} status={ORDER_STATE[o.state] ?? o.state} done={DONE.has(o.state)} units={o.priceUnits} />
            ))}
          </List>
        </div>
      )}

      {browserOnly.length > 0 && (
        <div className="mt-8">
          <List title="Started in this browser" note="Private links saved on this device, including ones paid from another account or not paid yet." empty="">
            {browserOnly.map((i) => (
              <Row key={i.id} href={`/${i.kind === "order" ? "orders" : "subscriptions"}/${i.id}#t=${i.token}`} title={i.title || (i.kind === "order" ? "Research brief" : "Subscription")} meta={`${i.kind === "order" ? "Order" : "Subscription"} · ${day(i.at)}`} />
            ))}
          </List>
        </div>
      )}
    </main>
  );
}

function List({ title, note, empty, children }: { title: string; note?: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-rule bg-surface">
      <div className="border-b border-rule px-5 py-3">
        <h2 className="font-medium">{title}</h2>
        {note && <p className="mt-0.5 text-xs text-ink-3">{note}</p>}
      </div>
      {children.length === 0 ? <p className="p-5 text-sm text-ink-3">{empty}</p> : <ul className="divide-y divide-rule">{children}</ul>}
    </section>
  );
}

function Row({ href, title, meta, status, done, units }: { href: string; title: string; meta: string; status?: string; done?: boolean; units?: string }) {
  return (
    <li>
      <Link href={href} className="flex items-start justify-between gap-3 px-5 py-3 transition-colors duration-150 hover:bg-raised">
        <span className="min-w-0">
          <span className="block truncate text-sm">{title}</span>
          <span className="block font-mono text-xs text-ink-3">{meta}</span>
        </span>
        <span className="shrink-0 text-right">
          {units && <Money units={units} className="text-sm" />}
          {status && <span className={`block text-xs ${done ? "text-real" : "text-ink-3"}`}>{status}</span>}
        </span>
      </Link>
    </li>
  );
}
