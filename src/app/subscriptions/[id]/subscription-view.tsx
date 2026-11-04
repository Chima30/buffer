"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Money } from "@/components/money";
import { txHashOf, useNearWallet } from "@/components/wallet";
import { cadence } from "@/lib/domain/cadence";
import { sessionHeaders } from "@/lib/client/session";

interface SubData {
  id: string;
  onchainSubscriptionId: string;
  contractId: string;
  tokenContract: string;
  sku: string;
  productTitle: string;
  state: "AWAITING_PAYMENT" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  issuesTotal: number;
  issuesStarted: number;
  issuePriceUnits: string;
  totalUnits: string;
  escrowUnits: string | null;
  intervalSeconds: number | null;
  nextDueAt: string | null;
  customer: string | null;
  refund: { units: string; status: "Pending" | "Confirmed" | "Failed" | null } | null;
  authorised: boolean;
  topic: string | null;
  issues: { id: string; number: number; state: string; onchainOrderId: string; title: string | null; createdAt: string }[];
}

const STATE_LABEL: Record<SubData["state"], string> = {
  AWAITING_PAYMENT: "Awaiting payment",
  ACTIVE: "Active",
  COMPLETED: "All issues started",
  CANCELLED: "Cancelled",
};

const ISSUE_LABEL: Record<string, string> = {
  PAID: "Starting",
  PLANNING: "Planning",
  PROCURING: "Planning",
  DRAFTING: "Writing",
  DELIVERED: "Delivered",
  SETTLING: "Delivered",
  SETTLED: "Delivered, settled",
  REFUND_PENDING: "Refunding",
  REFUNDED: "Refunded",
  FAILED: "Failed",
};

const noSubscribe = () => () => {};
const useHashToken = () =>
  useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    () => new URLSearchParams(window.location.hash.slice(1)).get("t"),
    () => null,
  );
const useStoredPayer = () => useSyncExternalStore(noSubscribe, () => sessionStorage.getItem("buffer-payer") ?? "", () => "");
const useNow = () => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
};

function until(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 60_000) return "any minute now";
  const m = Math.round(ms / 60_000);
  if (m < 90) return `in about ${m} minutes`;
  const h = Math.round(m / 60);
  return h < 36 ? `in about ${h} hours` : `in about ${Math.round(h / 24)} days`;
}

export function SubscriptionView() {
  const { id } = useParams<{ id: string }>();
  const token = useHashToken();
  const now = useNow();
  const [sub, setSub] = useState<SubData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/subscriptions/${id}${token ? `?token=${token}` : ""}`, { cache: "no-store", headers: sessionHeaders() });
      if (!res.ok) throw new Error((await res.json()).error ?? "Subscription not found");
      setSub(await res.json());
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [id, token]);

  useEffect(() => {
    const t = setInterval(load, 6000);
    const first = setTimeout(load, 0);
    return () => {
      clearInterval(t);
      clearTimeout(first);
    };
  }, [load]);

  return (
    <main className="enter">
      {loadError && !sub && <p role="alert" className="rounded-md bg-failed-soft p-4 text-failed">{loadError}</p>}
      {!sub && !loadError && <p className="text-ink-3">Loading subscription</p>}
      {sub && (
        <>
          <section className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-xs text-ink-3">Subscription {sub.onchainSubscriptionId}</p>
              <h1 className="mt-1 text-[28px] font-medium leading-[1.15] tracking-[-0.02em] sm:text-[32px]">{sub.productTitle}</h1>
            </div>
            <div className="sm:text-right">
              <Money units={sub.totalUnits} className="text-lg" />
              <p className="text-xs text-ink-3">
                {sub.issuesTotal} issues × <Money units={sub.issuePriceUnits} />
              </p>
            </div>
          </section>

          <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-card)] border border-rule bg-rule text-sm sm:grid-cols-4">
            <Stat label="Status" value={STATE_LABEL[sub.state]} tone={sub.state === "ACTIVE" ? "real" : sub.state === "CANCELLED" ? "failed" : undefined} />
            <Stat label="Issues started" value={`${sub.issuesStarted} of ${sub.issuesTotal}`} />
            <Stat label="Still in escrow" value={sub.escrowUnits !== null ? <Money units={sub.escrowUnits} /> : "—"} />
            <Stat
              label="Next issue"
              value={sub.state === "ACTIVE" && sub.nextDueAt ? until(sub.nextDueAt, now) : sub.state === "AWAITING_PAYMENT" ? "After payment" : "None"}
            />
          </dl>
          {sub.intervalSeconds !== null && <p className="mt-2 text-xs text-ink-3">One issue {cadence(sub.intervalSeconds)}. The contract refuses to open an issue early.</p>}

          {sub.state === "AWAITING_PAYMENT" && sub.authorised && token && <PaymentPanel sub={sub} token={token} onPaid={load} />}
          {!sub.authorised && <Notice tone="simulated">You are viewing public status only. The topic and issues open with the private link from checkout, or in My orders after signing in with the wallet that paid.</Notice>}
          {sub.state === "CANCELLED" && sub.refund && (
            <Notice tone={sub.refund.status === "Confirmed" ? "real" : sub.refund.status === "Failed" ? "failed" : "pending"}>
              Cancelled. <Money units={sub.refund.units} /> for the unstarted issues {sub.refund.status === "Confirmed" ? "was refunded to you by the contract." : sub.refund.status === "Failed" ? "could not be sent yet; the owner or agent can retry it." : "is on its way back to you."}
            </Notice>
          )}
          {sub.state === "CANCELLED" && !sub.refund && <Notice tone="simulated">Cancelled. Every issue had already started, so nothing was left to refund.</Notice>}

          <div className="mt-8 grid gap-6 lg:grid-cols-[1.3fr_1fr]">
            <Card title="Issues">
              {sub.issues.length === 0 ? (
                <p className="text-sm text-ink-3">{sub.state === "AWAITING_PAYMENT" ? "The first issue starts as soon as your payment is confirmed." : "The first issue is being opened."}</p>
              ) : (
                <ol className="divide-y divide-rule text-sm">
                  {sub.issues.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="min-w-0">
                        <span className="font-mono text-xs text-ink-3">#{i.number}</span>{" "}
                        {sub.authorised ? (
                          <Link href={`/orders/${i.id}${token ? `#t=${token}` : ""}`} className="text-accent">
                            {i.title ?? `Issue ${i.number}`}
                          </Link>
                        ) : (
                          <span>{`Issue ${i.number}`}</span>
                        )}
                      </span>
                      <span className={`shrink-0 text-xs ${["SETTLED", "DELIVERED", "SETTLING"].includes(i.state) ? "text-real" : "text-ink-3"}`}>{ISSUE_LABEL[i.state] ?? i.state}</span>
                    </li>
                  ))}
                  {Array.from({ length: sub.state === "CANCELLED" ? 0 : sub.issuesTotal - sub.issues.length }, (_, k) => (
                    <li key={`pending-${k}`} className="flex items-center justify-between py-2.5 text-ink-3">
                      <span>
                        <span className="font-mono text-xs">#{sub.issues.length + k + 1}</span> Not started
                      </span>
                      <span className="text-xs">Paid, in escrow</span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
            <div className="space-y-6">
              {sub.topic && (
                <Card title="Topic">
                  <p className="whitespace-pre-wrap text-sm text-ink-2">{sub.topic}</p>
                </Card>
              )}
              {sub.state === "ACTIVE" && sub.authorised && <CancelPanel sub={sub} token={token} onDone={load} />}
            </div>
          </div>
        </>
      )}
    </main>
  );
}

function PaymentPanel({ sub, token, onPaid }: { sub: SubData; token: string; onPaid: () => void }) {
  const wallet = useNearWallet();
  const storedPayer = useStoredPayer();
  const [payerInput, setPayer] = useState<string | null>(null);
  const payer = payerInput ?? (wallet.signedAccountId || storedPayer);
  const [paying, setPaying] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [msg, setMsg] = useState<{ tone: "failed" | "pending" | "real"; text: string } | null>(null);

  const message = JSON.stringify({ subscription_id: sub.onchainSubscriptionId, sku: sub.sku, issues: sub.issuesTotal });
  const escaped = message.replace(/"/g, '\\\\\\"');
  const command = `near --% contract call-function as-transaction ${sub.tokenContract} ft_transfer_call json-args "{\\"receiver_id\\":\\"${sub.contractId}\\",\\"amount\\":\\"${sub.totalUnits}\\",\\"msg\\":\\"${escaped}\\"}" prepaid-gas "100 Tgas" attached-deposit "1 yoctoNEAR" sign-as ${payer || "<your-account>.testnet"} network-config testnet sign-with-keychain send`;

  async function submit(hash: string, sender: string) {
    setMsg({ tone: "pending", text: "Checking the transaction on NEAR testnet…" });
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`/api/subscriptions/${sub.id}/payment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, txHash: hash, sender }) });
      const j = await res.json();
      if (res.ok) {
        setMsg({ tone: "real", text: "Payment confirmed on-chain. The first issue is starting." });
        onPaid();
        return;
      }
      if (res.status !== 202) {
        setMsg({ tone: "failed", text: j.error ?? "Could not verify the payment" });
        return;
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    setMsg({ tone: "pending", text: "The transaction is not final yet. Paste its ID below in a moment to retry." });
  }

  async function payWithWallet() {
    if (!wallet.signedAccountId) return wallet.signIn();
    setPaying(true);
    setMsg({ tone: "pending", text: "Approve the payment in your wallet…" });
    try {
      const outcome = await wallet.callFunctionRaw({
        contractId: sub.tokenContract,
        method: "ft_transfer_call",
        args: { receiver_id: sub.contractId, amount: sub.totalUnits, msg: message },
        gas: "100000000000000",
        deposit: "1",
      });
      const hash = txHashOf(outcome);
      if (!hash) throw new Error("The wallet did not return a transaction ID. Paste it below instead.");
      await submit(hash, wallet.signedAccountId);
    } catch (err) {
      setMsg({ tone: "failed", text: (err as Error).message || "The wallet did not complete the payment" });
    } finally {
      setPaying(false);
    }
  }

  return (
    <section className="mt-8 rounded-[var(--radius-card)] border border-rule bg-surface p-5">
      <h2 className="font-medium">
        Prepay <Money units={sub.totalUnits} /> for {sub.issuesTotal} issues
      </h2>
      <p className="mt-1 text-sm text-ink-3">
        One payment into the subscription escrow at <span className="font-mono">{sub.contractId}</span>, never to the agent. Each issue takes exactly <Money units={sub.issuePriceUnits} /> when it starts. Wrong amounts are returned automatically.
      </p>
      <button type="button" onClick={payWithWallet} disabled={paying} className="press mt-4 w-full rounded-md bg-ink px-4 py-2.5 text-sm font-medium text-paper disabled:opacity-60 sm:w-auto">
        {wallet.signedAccountId ? (paying ? "Waiting for wallet…" : `Pay ${(Number(sub.totalUnits) / 1e6).toFixed(2)} USDC from ${wallet.signedAccountId}`) : "Connect a NEAR testnet wallet to pay"}
      </button>
      <p className="mt-2 text-xs text-ink-3">Your account needs testnet USDC (free at faucet.circle.com, network NEAR Testnet) and a little testnet NEAR for fees.</p>
      <details className="mt-4 rounded-md border border-rule p-3">
        <summary className="cursor-pointer text-sm text-ink-2">Pay from the command line instead (near-cli)</summary>
        <label className="mt-3 block text-sm">
          <span className="font-medium">Paying account</span>
          <input value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="yourname.testnet" className="mt-1 w-full rounded-md border border-rule-strong bg-paper p-2 font-mono text-sm" />
        </label>
        <p className="mt-3 text-sm font-medium">Run in PowerShell:</p>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-paper p-3 font-mono text-xs">{command}</pre>
        <button type="button" onClick={() => navigator.clipboard.writeText(command)} className="mt-2 text-sm text-accent">
          Copy command
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(txHash.trim(), payer.trim());
          }}
          className="mt-4 flex flex-col gap-2 sm:flex-row"
        >
          <input required value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="Paste the Transaction ID" className="flex-1 rounded-md border border-rule-strong bg-paper p-2 font-mono text-sm" />
          <button className="rounded-md border border-rule-strong px-4 py-2 text-sm font-medium">Confirm payment</button>
        </form>
      </details>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </section>
  );
}

function CancelPanel({ sub, token, onDone }: { sub: SubData; token: string | null; onDone: () => void }) {
  const wallet = useNearWallet();
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [msg, setMsg] = useState<{ tone: "failed" | "pending" | "real"; text: string } | null>(null);
  const remaining = sub.issuesTotal - sub.issuesStarted;
  const signer = sub.customer ?? "<your-account>.testnet";
  const command = `near --% contract call-function as-transaction ${sub.contractId} cancel_subscription json-args "{\\"subscription_id\\":\\"${sub.onchainSubscriptionId}\\"}" prepaid-gas "100 Tgas" attached-deposit "0 NEAR" sign-as ${signer} network-config testnet sign-with-keychain send`;
  const isCustomer = !!wallet.signedAccountId && wallet.signedAccountId === sub.customer;

  async function record(hash: string, sender: string) {
    setMsg({ tone: "pending", text: "Checking the cancellation on NEAR testnet…" });
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`/api/subscriptions/${sub.id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", ...sessionHeaders() }, body: JSON.stringify({ token: token ?? undefined, txHash: hash, sender }) });
      const j = await res.json();
      if (res.ok) {
        setMsg({ tone: "real", text: "Cancelled on-chain. Your refund was sent by the contract." });
        onDone();
        return;
      }
      if (res.status !== 202) {
        setMsg({ tone: "failed", text: j.error ?? "Could not verify the cancellation" });
        return;
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  async function cancel() {
    if (!wallet.signedAccountId) return wallet.signIn();
    if (!isCustomer) return setMsg({ tone: "failed", text: `Connect ${sub.customer} to cancel; only the subscriber or the owner can.` });
    setBusy(true);
    setMsg({ tone: "pending", text: "Approve the cancellation in your wallet…" });
    try {
      const outcome = await wallet.callFunctionRaw({ contractId: sub.contractId, method: "cancel_subscription", args: { subscription_id: sub.onchainSubscriptionId }, gas: "100000000000000", deposit: "0" });
      const hash = txHashOf(outcome);
      if (!hash) throw new Error("The wallet did not return a transaction ID. Paste it below instead.");
      await record(hash, wallet.signedAccountId);
    } catch (err) {
      setMsg({ tone: "failed", text: (err as Error).message || "The wallet did not complete the cancellation" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Cancel">
      <p className="text-sm text-ink-2">
        Stop the subscription and get back <Money units={(BigInt(sub.issuePriceUnits) * BigInt(remaining)).toString()} /> for the {remaining} unstarted {remaining === 1 ? "issue" : "issues"}, sent by the contract straight to {sub.customer ?? "you"}. Issues already started still finish.
      </p>
      <button type="button" onClick={cancel} disabled={busy} className="press mt-4 h-9 rounded-lg border border-rule-strong px-3 text-sm font-medium transition-colors duration-150 hover:bg-raised disabled:opacity-60">
        {wallet.signedAccountId ? (busy ? "Waiting for wallet…" : "Cancel and refund") : "Connect your wallet to cancel"}
      </button>
      <details className="mt-4 rounded-md border border-rule p-3">
        <summary className="cursor-pointer text-sm text-ink-2">Cancel from the command line instead (near-cli)</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-paper p-3 font-mono text-xs">{command}</pre>
        <button type="button" onClick={() => navigator.clipboard.writeText(command)} className="mt-2 text-sm text-accent">
          Copy command
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void record(txHash.trim(), signer);
          }}
          className="mt-3 flex flex-col gap-2 sm:flex-row"
        >
          <input required value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="Paste the Transaction ID" className="flex-1 rounded-md border border-rule-strong bg-paper p-2 font-mono text-sm" />
          <button className="rounded-md border border-rule-strong px-4 py-2 text-sm font-medium">Record cancellation</button>
        </form>
      </details>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "real" | "failed" }) {
  return (
    <div className="bg-surface p-4">
      <dt className="text-ink-3">{label}</dt>
      <dd className={`mt-1 ${tone === "real" ? "text-real" : tone === "failed" ? "text-failed" : ""}`}>{value}</dd>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-rule bg-surface">
      <h2 className="border-b border-rule px-5 py-3 font-medium">{title}</h2>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Notice({ tone, children }: { tone: "failed" | "pending" | "real" | "simulated"; children: React.ReactNode }) {
  const cls = { failed: "bg-failed-soft text-failed", pending: "bg-pending-soft text-pending", real: "bg-real-soft text-real", simulated: "bg-simulated-soft text-simulated" }[tone];
  return (
    <p role="status" className={`mt-4 rounded-md p-3 text-sm ${cls}`}>
      {children}
    </p>
  );
}
