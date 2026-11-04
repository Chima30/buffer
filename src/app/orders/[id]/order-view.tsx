"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Money } from "@/components/money";
import { StatusBadge } from "@/components/status-badge";
import { ReportMarkdown } from "@/components/report-markdown";
import { txHashOf, useNearWallet } from "@/components/wallet";
import { resolutionOf } from "@/lib/domain/ledger-view";
import type { LedgerStatus } from "@/lib/domain/ledger";

interface OrderData {
  id: string;
  onchainOrderId: string;
  contractId: string;
  tokenContract: string;
  sku: string;
  productTitle?: string;
  state: string;
  priceUnits: string;
  authorised: boolean;
  brief: string | null;
  plan: { title: string; angles: string[]; use_dataset: boolean; dataset_reason: string } | null;
  transitions: { from_state: string | null; to_state: string; reason: string; at: string }[];
  ledger: { order_id?: string | null; event_type: string; status: LedgerStatus; amount_units: string | null; counterparty: string | null; tx_hash: string | null; explorer_url: string | null; details: Record<string, unknown>; at: string }[];
  purchase: { status: string; amount_units: string } | null;
  report: { content: string; content_hash: string } | null;
  proofs: { purpose: string; model: string; chat_id: string; signature_kind: string | null; signing_address: string | null; verification_level: string; gpu_attestation: "PASS" | "FAIL" | "ERROR" | null; gpu_attestation_detail: { detail: string; issued_at: string | null } | null; request_hash: string; response_hash: string; tokens_in: number; tokens_out: number; cost_usd_micros: string }[];
}

const STAGES: { key: string; label: string; states: string[] }[] = [
  { key: "pay", label: "Payment", states: ["CREATED", "AWAITING_PAYMENT"] },
  { key: "plan", label: "Planning", states: ["PAID", "PLANNING"] },
  { key: "buy", label: "Procurement", states: ["PROCURING", "AWAITING_APPROVAL"] },
  { key: "write", label: "Writing", states: ["DRAFTING"] },
  { key: "deliver", label: "Delivered", states: ["DELIVERED", "SETTLING"] },
  { key: "settle", label: "Settled", states: ["SETTLED"] },
];

const EVENT_LABELS: Record<string, string> = {
  payment_received: "Customer payment received",
  intents_quote: "NEAR Intents price quote",
  intents_settlement: "Cross-chain settlement",
  purchase_awaiting_approval: "Dataset purchase waiting for owner approval",
  purchase_approved: "Owner approved the purchase",
  vendor_paid: "Vendor paid by the contract",
  crosschain_payment_signed: "Payment signed by NEAR Chain Signatures",
  purchase_blocked: "Purchase blocked by policy",
  purchase_rejected: "Purchase rejected",
  purchase_rejected_by_owner: "Owner rejected the purchase",
  purchase_failed: "Purchase failed",
  order_fulfilled: "Report delivered, hash recorded on-chain",
  payout_owner: "Owner share (70%)",
  payout_contributor: "Contributor share (30%)",
  payout_reimb_owner: "Expenses reimbursed to owner",
  refund_topped_up: "Owner topped up the refund",
  refund_started: "Refund started",
  refund_paid: "Customer refunded",
};

// Browser-only values, read without effects. The order token lives in the URL fragment.
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

export function OrderView() {
  const { id } = useParams<{ id: string }>();
  const token = useHashToken();
  const [order, setOrder] = useState<OrderData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/orders/${id}${token ? `?token=${token}` : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Order not found");
      setOrder(await res.json());
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [id, token]);

  useEffect(() => {
    const t = setInterval(load, 4000);
    const first = setTimeout(load, 0);
    return () => {
      clearInterval(t);
      clearTimeout(first);
    };
  }, [load]);

  return (
    <main className="enter">
      {loadError && !order && <p role="alert" className="rounded-md bg-failed-soft p-4 text-failed">{loadError}</p>}
      {!order && !loadError && <p className="text-ink-3">Loading order</p>}
      {order && (
        <>
          <section className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="font-mono text-xs text-ink-3">Order {order.onchainOrderId}</p>
              <h1 className="mt-1 text-[28px] font-medium leading-[1.15] tracking-[-0.02em] sm:text-[32px]">{order.plan?.title ?? order.productTitle ?? "Weekly Market Brief"}</h1>
            </div>
            <Money units={order.priceUnits} className="text-lg" />
          </section>

          <Progress state={order.state} />

          {order.state === "AWAITING_PAYMENT" && order.authorised && token && <PaymentPanel order={order} token={token} onPaid={load} />}
          {order.state === "AWAITING_APPROVAL" && (
            <Notice tone="pending">The agent wants to buy a dataset for {order.purchase ? <Money units={order.purchase.amount_units} /> : "this order"}. Purchases above 10 USDC wait for the owner to approve that exact purchase on-chain.</Notice>
          )}
          {order.state === "REFUND_PENDING" && <Notice tone="failed">This order is being refunded in full. The agent has stopped working on it.</Notice>}
          {order.state === "REFUNDED" && <Notice tone="simulated">This order was refunded. The refund transaction is in the ledger below.</Notice>}
          {!order.authorised && <Notice tone="simulated">You are viewing public status only. The brief and report are visible with the private link from checkout.</Notice>}

          <div className="mt-8 grid gap-6 lg:grid-cols-[1.3fr_1fr]">
            <div className="space-y-6">
              {order.report ? <Report report={order.report} /> : order.brief && (
                <Card title="Your brief"><p className="whitespace-pre-wrap text-sm text-ink-2">{order.brief}</p></Card>
              )}
              {order.plan && (
                <Card title="Agent's plan">
                  <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">{order.plan.angles.map((a) => <li key={a}>{a}</li>)}</ul>
                  <p className="mt-3 text-xs text-ink-3">{order.plan.use_dataset ? `Buys the dataset${order.plan.dataset_reason ? `: ${order.plan.dataset_reason.replace(/\.$/, "")}` : ""}` : "No dataset needed"}</p>
                </Card>
              )}
            </div>
            <div className="space-y-6">
              <Ledger entries={order.ledger} />
              {order.proofs.length > 0 && <Proofs proofs={order.proofs} reportHash={order.report?.content_hash ?? null} />}
            </div>
          </div>
        </>
      )}
    </main>
  );
}

function Progress({ state }: { state: string }) {
  const idx = STAGES.findIndex((s) => s.states.includes(state));
  const failed = state === "FAILED" || state === "REFUND_PENDING" || state === "REFUNDED";
  return (
    <ol className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-[var(--radius-card)] border border-rule bg-rule text-xs sm:grid-cols-6">
      {STAGES.map((s, i) => {
        const done = !failed && (i < idx || state === "SETTLED");
        const current = !failed && i === idx && state !== "SETTLED";
        return (
          <li key={s.key} className={`bg-surface p-3 ${current ? "text-ink" : done ? "text-real" : "text-ink-3"}`}>
            <span aria-hidden>{done ? "●" : current ? "◐" : "○"}</span> {s.label}
            {current && <span className="sr-only"> (in progress)</span>}
          </li>
        );
      })}
    </ol>
  );
}

function PaymentPanel({ order, token, onPaid }: { order: OrderData; token: string; onPaid: () => void }) {
  const wallet = useNearWallet();
  const storedPayer = useStoredPayer();
  const [payerInput, setPayer] = useState<string | null>(null);
  const payer = payerInput ?? (wallet.signedAccountId || storedPayer);
  const [paying, setPaying] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [msg, setMsg] = useState<{ tone: "failed" | "pending" | "real"; text: string } | null>(null);
  const [quote, setQuote] = useState<{ origin: string; amountIn: string | null; decimals: number } | null>(null);

  const orderMsg = JSON.stringify({ order_id: order.onchainOrderId, sku: order.sku }).replace(/"/g, '\\\\\\"');
  const command = `near --% contract call-function as-transaction ${order.tokenContract} ft_transfer_call json-args "{\\"receiver_id\\":\\"${order.contractId}\\",\\"amount\\":\\"${order.priceUnits}\\",\\"msg\\":\\"${orderMsg}\\"}" prepaid-gas "100 Tgas" attached-deposit "1 yoctoNEAR" sign-as ${payer || "<your-account>.testnet"} network-config testnet sign-with-keychain send`;

  async function submitPayment(hash: string, sender: string) {
    setMsg({ tone: "pending", text: "Checking the transaction on NEAR testnet…" });
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`/api/orders/${order.id}/payment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, txHash: hash, sender }) });
      const j = await res.json();
      if (res.ok) {
        setMsg({ tone: "real", text: "Payment confirmed on-chain. The agent has started." });
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

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    await submitPayment(txHash.trim(), payer.trim());
  }

  async function payWithWallet() {
    if (!wallet.signedAccountId) return wallet.signIn();
    setPaying(true);
    setMsg({ tone: "pending", text: "Approve the payment in your wallet…" });
    try {
      const outcome = await wallet.callFunctionRaw({
        contractId: order.tokenContract,
        method: "ft_transfer_call",
        args: { receiver_id: order.contractId, amount: order.priceUnits, msg: JSON.stringify({ order_id: order.onchainOrderId, sku: order.sku }) },
        gas: "100000000000000",
        deposit: "1",
      });
      const hash = txHashOf(outcome);
      if (!hash) throw new Error("The wallet did not return a transaction ID. Paste it below instead.");
      await submitPayment(hash, wallet.signedAccountId);
    } catch (err) {
      setMsg({ tone: "failed", text: (err as Error).message || "The wallet did not complete the payment" });
    } finally {
      setPaying(false);
    }
  }

  async function previewSol() {
    const res = await fetch("/api/intents/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: order.id, origin: "SOL", simulate: true }) });
    const j = await res.json();
    if (res.ok) setQuote(j);
  }

  return (
    <section className="mt-8 rounded-[var(--radius-card)] border border-rule bg-surface p-5">
      <h2 className="font-medium">Pay <Money units={order.priceUnits} /> to the business contract</h2>
      <p className="mt-1 text-sm text-ink-3">The payment goes into escrow at <span className="font-mono">{order.contractId}</span>, never to the agent. Wrong amounts are returned automatically.</p>
      <button type="button" onClick={payWithWallet} disabled={paying} className="mt-4 w-full rounded-md bg-ink px-4 py-2.5 text-sm font-medium text-paper disabled:opacity-60 sm:w-auto">
        {wallet.signedAccountId ? (paying ? "Waiting for wallet…" : `Pay 20 USDC from ${wallet.signedAccountId}`) : "Connect a NEAR testnet wallet to pay"}
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
        <button type="button" onClick={() => navigator.clipboard.writeText(command)} className="mt-2 text-sm text-accent">Copy command</button>
        <form onSubmit={confirm} className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input required value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="Paste the Transaction ID" className="flex-1 rounded-md border border-rule-strong bg-paper p-2 font-mono text-sm" />
          <button className="rounded-md border border-rule-strong px-4 py-2 text-sm font-medium">Confirm payment</button>
        </form>
      </details>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <div className="mt-6 border-t border-rule pt-4">
        <p className="text-sm text-ink-2">Holding SOL instead? See what it would cost through NEAR Intents.</p>
        <button type="button" onClick={previewSol} className="mt-2 rounded-md border border-rule-strong px-3 py-1.5 text-sm">Get a live quote</button>
        {quote && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status="QUOTE" />
            <span className="font-mono tabular">≈ {quote.amountIn ? (Number(quote.amountIn) / 10 ** quote.decimals).toFixed(5) : "?"} {quote.origin}</span>
            <StatusBadge status="SIMULATED" />
            <span className="text-ink-3">Settlement shown, not performed: NEAR Intents has no testnet. Pay in testnet USDC above.</span>
          </div>
        )}
      </div>
    </section>
  );
}

function Report({ report }: { report: { content: string; content_hash: string } }) {
  return (
    <Card title="Your research brief">
      <ReportMarkdown content={report.content} />
    </Card>
  );
}

function Ledger({ entries }: { entries: OrderData["ledger"] }) {
  return (
    <Card title="Order ledger">
      {entries.length === 0 ? (
        <p className="text-sm text-ink-3">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-rule text-sm">
          {entries.map((e, i) => {
            const resolved = resolutionOf(e, entries);
            return (
            <li key={i} className={`flex flex-col gap-1 py-2.5 ${resolved ? "opacity-60" : ""}`}>
              <div className="flex items-center justify-between gap-2">
                <span>
                  {e.event_type === "vendor_paid" && e.details?.chain === "sepolia" ? "Vendor paid on Ethereum Sepolia (Chain Signatures)" : (EVENT_LABELS[e.event_type] ?? e.event_type)}
                </span>
                <StatusBadge status={e.status} />
              </div>
              {resolved && <span className="text-xs text-ink-3">Resolved: {(EVENT_LABELS[resolved.event_type] ?? resolved.event_type).toLowerCase()}</span>}
              <div className="flex items-center justify-between gap-2 text-xs text-ink-3">
                <span className="truncate">{e.counterparty ?? ""}</span>
                {e.amount_units && <Money units={e.amount_units} />}
              </div>
              {e.event_type === "payout_reimb_owner" && typeof e.details?.treasury_units === "string" && (
                <span className="text-xs text-ink-3">
                  {BigInt(e.details.treasury_units) > 0n && <>Ethereum treasury <Money units={e.details.treasury_units} /> · </>}
                  inference <Money units={String(e.details.inference_units ?? "0")} />
                </span>
              )}
              {e.explorer_url && <a href={e.explorer_url} target="_blank" rel="noreferrer" className="font-mono text-xs text-accent">tx {e.tx_hash?.slice(0, 10)}… ↗</a>}
            </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function Proofs({ proofs, reportHash }: { proofs: OrderData["proofs"]; reportHash: string | null }) {
  return (
    <Card title="Proof of private inference">
      <ul className="space-y-3 text-xs">
        {proofs.map((p) => (
          <li key={p.chat_id} className="rounded-md bg-paper p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium capitalize">{p.purpose}</span>
              <span className={p.verification_level === "SIGNATURE_ATTESTED" ? "text-real" : "text-pending"}>
                {p.verification_level === "SIGNATURE_ATTESTED" ? "● Signed in attested TEE" : p.verification_level === "SIGNATURE_ONLY" ? "◐ Signature valid, signer not in report" : "✕ Not verified"}
              </span>
            </div>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono text-ink-3">
              <dt>model</dt><dd className="truncate">{p.model}</dd>
              <dt>signer</dt><dd className="truncate">{p.signing_address ?? "n/a"}</dd>
              <dt>GPU</dt>
              <dd className={p.gpu_attestation === "PASS" ? "text-real" : p.gpu_attestation === "FAIL" ? "text-failed" : ""} title={p.gpu_attestation_detail?.detail}>
                {p.gpu_attestation === "PASS" ? "● Verified by NVIDIA NRAS" : p.gpu_attestation === "FAIL" ? "✕ NVIDIA NRAS check failed" : p.gpu_attestation === "ERROR" ? "◌ NRAS check unavailable" : "not checked"}
              </dd>
              <dt>request</dt><dd className="truncate">{p.request_hash}</dd>
              <dt>response</dt><dd className="truncate">{p.response_hash}</dd>
              <dt>cost</dt><dd><Money units={p.cost_usd_micros} symbol="USD" /></dd>
            </dl>
          </li>
        ))}
      </ul>
      {reportHash && <p className="mt-3 break-all font-mono text-xs text-ink-3">report sha256 {reportHash} (recorded on-chain at delivery)</p>}
    </Card>
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
  return <p role="status" className={`mt-4 rounded-md p-3 text-sm ${cls}`}>{children}</p>;
}
