"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Money } from "@/components/money";
import { SiteHeader } from "@/components/site-header";
import { txHashOf, useNearWallet } from "@/components/wallet";

interface Overview {
  business: { id: string; name: string; status: "active" | "paused" } | null;
  contract: { id: string; paused: boolean; owner: string; policyVersion: number; policyHash: string | null; approvalAboveUnits: string; contributor: string; contributorBps: number };
  policy: { version: number; rules_hash: string; source_text: string | null; activated_at: string | null; values: Record<string, string> | null } | null;
  pendingPolicy: { version: number; hash: string; sourceText: string | null; createdAt: string | null; commands: OwnerCommand[] } | null;
  policyAnchored: boolean;
  agent: { id: string; name: string; role: string; near_account: string; status: "running" | "paused" | "frozen"; walletPubkey: string | null } | null;
  totals: { revenue: string; vendorSpend: string; inferenceSpend: string; net: string; ownerPaid: string; contributorPaid: string };
  pendingApprovals: { id: string; amount_units: string; onchain_index: number; created_at: string; chain: "near" | "sepolia"; orders: { onchain_order_id: string; state: string }; vendors: { name: string; near_account: string | null; evm_address: string | null } }[];
  treasury: { address: string; eth: string; usdc: string; explorerUrl: string } | null;
  alerts: string[];
  refunds: { id: string; onchain_order_id: string; state: string; price_units: string; topUpUnits: string }[];
  tokenId: string;
  orders: { id: string; onchain_order_id: string; state: string; price_units: string; created_at: string }[];
  recentActions: { tool: string; decision: "allow" | "deny" | "needs_approval"; reasons: { code: string; message: string; ruleId?: string }[]; policy_version: number; at: string }[];
}

interface OwnerCommand { label: string; method: "set_policy_hash" | "set_purchase_approval_above"; args: Record<string, unknown> }
interface DraftResult { version: number; hash: string | null; changes: { field: string; label: string; from: string; to: string }[]; warnings: string[]; errors: string[]; unsupported: string[]; commands: OwnerCommand[]; verification: string; chatId: string }

const OUTLAYER_CONTRACT = "outlayer.testnet";

const VALUE_LABELS: Record<string, [string, string]> = {
  approval_above_usdc: ["Owner approval needed above", "USDC"],
  max_per_purchase_usdc: ["Maximum per vendor purchase", "USDC"],
  per_transaction_usdc: ["Maximum per transaction", "USDC"],
  daily_spend_usdc: ["Daily spending limit", "USDC"],
  monthly_spend_usdc: ["Monthly spending limit", "USDC"],
  inference_daily_usd: ["Daily AI inference budget", "USD"],
  inference_monthly_usd: ["Monthly AI inference budget", "USD"],
};

/** near-cli command for Windows PowerShell; --% keeps the JSON quotes intact. */
function cliCommand(contractId: string, method: string, args: Record<string, unknown>, signer: string, gas = "100 Tgas") {
  const json = JSON.stringify(args).replace(/"/g, '\\"');
  return `near --% contract call-function as-transaction ${contractId} ${method} json-args "${json}" prepaid-gas "${gas}" attached-deposit "0 NEAR" sign-as ${signer} network-config testnet sign-with-keychain send`;
}

export default function OwnerConsole() {
  const wallet = useNearWallet();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "real" | "failed" | "pending"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/owner/overview", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not load");
      setData(j);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 8000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const isOwner = !!data && wallet.signedAccountId === data.contract.owner;

  /** Verify an owner-signed transaction on-chain, then record it. Used by wallet and near-cli paths. */
  async function recordTx(label: string, hash: string) {
    setNotice({ tone: "pending", text: `${label}: confirming on NEAR testnet…` });
    for (let i = 0; i < 6; i++) {
      const res = await fetch("/api/owner/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ txHash: hash }) });
      if (res.status !== 202) {
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? "Could not record the action");
        setNotice({ tone: "real", text: `${label}: done and recorded (tx ${hash.slice(0, 10)}…).` });
        await load();
        return;
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    throw new Error("Transaction not final yet; paste it again in a moment");
  }

  async function recordPasted(label: string, hash: string) {
    setBusy(label);
    try {
      await recordTx(label, hash.trim());
    } catch (e) {
      setNotice({ tone: "failed", text: `${label}: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  /** Every owner action: wallet signs a real transaction, then the app verifies and records it. */
  async function act(label: string, contractId: string, method: string, args: Record<string, unknown>, gas = "100000000000000") {
    setBusy(label);
    setNotice({ tone: "pending", text: `${label}: approve it in your wallet…` });
    try {
      const outcome = await wallet.callFunctionRaw({ contractId, method, args, gas, deposit: "0" });
      const hash = txHashOf(outcome);
      if (!hash) throw new Error("The wallet did not return a transaction ID");
      await recordTx(label, hash);
    } catch (e) {
      setNotice({ tone: "failed", text: `${label}: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <SiteHeader />
      <div className="mt-10 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-xs uppercase tracking-wider text-ink-3">Owner console</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{data?.business?.name ?? "Business"}</h1>
        </div>
        {data && <StatusPill paused={data.contract.paused} agent={data.agent?.status ?? "paused"} />}
      </div>

      {!wallet.signedAccountId && <Banner tone="simulated">Viewing read-only. Connect the owner wallet to approve purchases or use the emergency controls.</Banner>}
      {wallet.signedAccountId && data && !isOwner && <Banner tone="failed">Connected as {wallet.signedAccountId}. Only {data.contract.owner} can act; the contract would reject anyone else.</Banner>}
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
      {error && <Banner tone="failed">{error}</Banner>}
      {data?.alerts.map((a) => <Banner key={a} tone="pending">Low balance: {a}</Banner>)}
      {!data && !error && <p className="mt-8 text-ink-3">Loading…</p>}

      {data && (
        <>
          <section className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-card)] border border-rule bg-rule sm:grid-cols-4">
            <Stat label="Revenue received" units={data.totals.revenue} />
            <Stat label="Paid to vendors" units={data.totals.vendorSpend} />
            <Stat label="Inference cost" units={data.totals.inferenceSpend} />
            <Stat label="Net" units={data.totals.net} />
            <Stat label="Paid to owner" units={data.totals.ownerPaid} />
            <Stat label="Paid to contributor" units={data.totals.contributorPaid} />
            <div className="col-span-2 bg-surface p-4 text-sm">
              <div className="text-ink-3">Split</div>
              <div className="mt-1">{100 - data.contract.contributorBps / 100}% owner · {data.contract.contributorBps / 100}% contributor, on net revenue</div>
            </div>
          </section>

          <div className="mt-6 grid gap-6 lg:grid-cols-[1.3fr_1fr]">
            <div className="space-y-6">
              <Card title={`Approvals${data.pendingApprovals.length ? ` (${data.pendingApprovals.length})` : ""}`}>
                {data.pendingApprovals.length === 0 ? (
                  <p className="text-sm text-ink-3">Nothing waiting. Purchases above <Money units={data.contract.approvalAboveUnits} /> will appear here.</p>
                ) : (
                  <ul className="space-y-4">
                    {data.pendingApprovals.map((p) => {
                      const evm = p.chain === "sepolia";
                      const approve = evm ? "approve_evm_purchase" : "approve_purchase";
                      const reject = evm ? "reject_evm_purchase" : "reject_purchase";
                      const args = { order_id: p.orders.onchain_order_id, index: p.onchain_index };
                      return (
                      <li key={p.id} className="rounded-md border border-rule p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">{p.vendors.name}</span>
                          <Money units={p.amount_units} />
                        </div>
                        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-ink-3">
                          <dt>Destination</dt><dd className="break-all font-mono">{evm ? p.vendors.evm_address : p.vendors.near_account}</dd>
                          <dt>Chain</dt><dd>{evm ? "Ethereum Sepolia (signed by NEAR Chain Signatures)" : "NEAR testnet"}</dd>
                          <dt>Order</dt><dd className="font-mono">{p.orders.onchain_order_id}, purchase #{p.onchain_index}</dd>
                          <dt>Rule</dt><dd>Purchases above <Money units={data.contract.approvalAboveUnits} /> need the owner (A-1)</dd>
                          <dt>Paid from</dt><dd>{evm ? "the contract's Ethereum treasury (you are reimbursed at settlement)" : "this order's escrow, by the contract"}</dd>
                        </dl>
                        <div className="mt-3 flex gap-2">
                          <button disabled={!isOwner || !!busy} onClick={() => act("Approve purchase", data.contract.id, approve, args, evm ? "150000000000000" : "100000000000000")} className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-paper disabled:opacity-40">Approve</button>
                          <button disabled={!isOwner || !!busy} onClick={() => act("Reject purchase", data.contract.id, reject, args, "30000000000000")} className="rounded-md border border-rule-strong px-3 py-1.5 text-sm disabled:opacity-40">Reject</button>
                        </div>
                        <CliFallback
                          label="Approve purchase"
                          command={cliCommand(data.contract.id, approve, args, data.contract.owner, evm ? "150 Tgas" : "100 Tgas")}
                          busy={!!busy}
                          onSubmit={(h) => recordPasted("Approve purchase", h)}
                        />
                      </li>
                      );
                    })}
                  </ul>
                )}
              </Card>

              <Card title="Recent orders">
                {data.orders.length === 0 ? <p className="text-sm text-ink-3">No orders yet. <Link href="/store" className="text-accent">Open the store</Link>.</p> : (
                  <ul className="divide-y divide-rule text-sm">
                    {data.orders.map((o) => (
                      <li key={o.id} className="flex items-center justify-between gap-2 py-2">
                        <Link href={`/orders/${o.id}`} className="font-mono text-xs text-accent">{o.onchain_order_id}</Link>
                        <span className="text-xs text-ink-2">{o.state.replace(/_/g, " ").toLowerCase()}</span>
                        <Money units={o.price_units} />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {data.refunds.length > 0 && (
                <Card title="Refunds">
                  <p className="text-sm text-ink-2">Return a customer&apos;s payment in full. A refund stops the agent on that order. If the vendor was already paid from escrow, you top up that amount first so the customer gets all of it back.</p>
                  <ul className="mt-3 space-y-3">
                    {data.refunds.map((r) => {
                      const topUp = BigInt(r.topUpUnits) > 0n;
                      const topUpCmd = `near --% contract call-function as-transaction ${data.tokenId} ft_transfer_call json-args "{\\"receiver_id\\":\\"${data.contract.id}\\",\\"amount\\":\\"${r.topUpUnits}\\",\\"msg\\":\\"{\\\\\\"refund_top_up\\\\\\":\\\\\\"${r.onchain_order_id}\\\\\\"}\\"}" prepaid-gas "100 Tgas" attached-deposit "1 yoctoNEAR" sign-as ${data.contract.owner} network-config testnet sign-with-keychain send`;
                      return (
                        <li key={r.id} className="rounded-md border border-rule p-3 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <Link href={`/orders/${r.id}`} className="font-mono text-xs text-accent">{r.onchain_order_id}</Link>
                            <span className="text-xs text-ink-3">{r.state.replace(/_/g, " ").toLowerCase()}</span>
                          </div>
                          {topUp && (
                            <CliFallback label={`1. Top up ${(Number(r.topUpUnits) / 1e6).toFixed(2)} USDC`} command={topUpCmd} busy={!!busy} onSubmit={(h) => recordPasted("Refund top-up", h)} />
                          )}
                          <CliFallback label={`${topUp ? "2. " : ""}Refund the customer`} command={cliCommand(data.contract.id, "refund", { order_id: r.onchain_order_id }, data.contract.owner)} busy={!!busy} onSubmit={(h) => recordPasted("Refund", h)} />
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )}

              <Card title="Agent decisions">
                <ul className="divide-y divide-rule text-sm">
                  {data.recentActions.map((a, i) => (
                    <li key={i} className="py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs">{a.tool}</span>
                        <span className={`text-xs ${a.decision === "allow" ? "text-real" : a.decision === "deny" ? "text-failed" : "text-pending"}`}>{a.decision.replace("_", " ")}</span>
                      </div>
                      <p className="text-xs text-ink-3">{a.reasons.map((r) => r.message).join("; ")}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>

            <div className="space-y-6">
              <Card title="Emergency controls">
                <p className="text-sm text-ink-2">Each control is a transaction you sign. The agent cannot undo it.</p>
                <div className="mt-4 space-y-3">
                  <Control
                    title="Business contract"
                    state={data.contract.paused ? "Paused: no payments, purchases or settlements" : "Active"}
                    danger={!data.contract.paused}
                    action={data.contract.paused ? "Resume" : "Pause business"}
                    disabled={!isOwner || !!busy}
                    onClick={() => act(data.contract.paused ? "Resume business" : "Pause business", data.contract.id, data.contract.paused ? "unpause" : "pause", {}, "30000000000000")}
                  />
                  <Control
                    title="Agent wallet (OutLayer)"
                    state={data.agent?.status === "frozen" ? "Frozen: OutLayer refuses to sign anything" : "Signing within policy"}
                    danger={data.agent?.status !== "frozen"}
                    action={data.agent?.status === "frozen" ? "Unfreeze" : "Freeze agent wallet"}
                    disabled={!isOwner || !!busy || !data.agent?.walletPubkey}
                    onClick={() => act(data.agent?.status === "frozen" ? "Unfreeze agent wallet" : "Freeze agent wallet", OUTLAYER_CONTRACT, data.agent?.status === "frozen" ? "unfreeze_wallet" : "freeze_wallet", { wallet_pubkey: data.agent?.walletPubkey }, "30000000000000")}
                  />
                </div>
                <CliFallback
                  label={data.contract.paused ? "Resume business" : "Pause business"}
                  command={cliCommand(data.contract.id, data.contract.paused ? "unpause" : "pause", {}, data.contract.owner, "30 Tgas")}
                  busy={!!busy}
                  onSubmit={(h) => recordPasted(data.contract.paused ? "Resume business" : "Pause business", h)}
                />
                {data.agent?.walletPubkey && (
                  <CliFallback
                    label={data.agent.status === "frozen" ? "Unfreeze agent wallet" : "Freeze agent wallet"}
                    command={cliCommand(OUTLAYER_CONTRACT, data.agent.status === "frozen" ? "unfreeze_wallet" : "freeze_wallet", { wallet_pubkey: data.agent.walletPubkey }, data.contract.owner, "30 Tgas")}
                    busy={!!busy}
                    onSubmit={(h) => recordPasted(data.agent?.status === "frozen" ? "Unfreeze agent wallet" : "Freeze agent wallet", h)}
                  />
                )}
              </Card>

              <Card title="Policy">
                <p className="text-sm">
                  Version {data.contract.policyVersion}{" "}
                  {data.policyAnchored ? <span className="text-real">● matches the on-chain anchor</span> : <span className="text-failed">✕ does not match the on-chain anchor: the agent will not act</span>}
                </p>
                {data.policy?.source_text && <blockquote className="mt-3 border-l-2 border-rule-strong pl-3 text-sm text-ink-2">{data.policy.source_text}</blockquote>}
                {data.policy?.values && (
                  <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs">
                    {Object.entries(VALUE_LABELS).map(([k, [label, unit]]) => (
                      <div key={k} className="contents"><dt className="text-ink-3">{label}</dt><dd className="text-right font-mono">{data.policy?.values?.[k]} {unit}</dd></div>
                    ))}
                    <dt className="text-ink-3">Payments to unapproved wallets</dt><dd className="text-right font-mono">always blocked</dd>
                  </dl>
                )}
                <p className="mt-3 break-all font-mono text-xs text-ink-3">sha256 {data.contract.policyHash}</p>

                {data.pendingPolicy && (
                  <div className="mt-4 rounded-md border border-pending p-3">
                    <p className="text-sm font-medium">Waiting for your signature: policy v{data.pendingPolicy.version}</p>
                    {data.pendingPolicy.sourceText && <p className="mt-1 text-xs text-ink-2">&ldquo;{data.pendingPolicy.sourceText}&rdquo;</p>}
                    <p className="mt-1 break-all font-mono text-[11px] text-ink-3">sha256 {data.pendingPolicy.hash}</p>
                    <p className="mt-2 text-xs text-ink-2">Nothing changes until you sign. While the two steps are half done, the agent pauses itself rather than act on mixed rules.</p>
                    {data.pendingPolicy.commands.map((c, i) => (
                      <div key={c.method} className="mt-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs">{i + 1}. {c.label}</span>
                          <button disabled={!isOwner || !!busy} onClick={() => act(c.label, data.contract.id, c.method, c.args, "30000000000000")} className="rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-paper disabled:opacity-40">Sign</button>
                        </div>
                        <CliFallback label={c.label} command={cliCommand(data.contract.id, c.method, c.args, data.contract.owner, "30 Tgas")} busy={!!busy} onSubmit={(h) => recordPasted(c.label, h)} />
                      </div>
                    ))}
                  </div>
                )}

                <RecordTx label="Record a policy transaction" busy={!!busy} onSubmit={(h) => recordPasted("Policy", h)} />
                <PolicyBuilder onDrafted={load} />
              </Card>

              {data.treasury && (
                <Card title="Ethereum treasury (Chain Signatures)">
                  <p className="text-xs text-ink-2">Controlled by the business contract through NEAR&apos;s MPC network. No one holds its private key; the contract signs only USDC transfers to approved vendors.</p>
                  <a href={data.treasury.explorerUrl} target="_blank" rel="noreferrer" className="mt-2 block break-all font-mono text-xs text-accent">{data.treasury.address} ↗</a>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                    <dt className="text-ink-3">USDC</dt><dd className="text-right"><Money units={data.treasury.usdc} /></dd>
                    <dt className="text-ink-3">ETH (gas)</dt><dd className="text-right font-mono">{(Number(BigInt(data.treasury.eth) / 10n ** 12n) / 1e6).toFixed(4)}</dd>
                  </dl>
                </Card>
              )}

              <Card title="Agent">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-ink-3">Name</dt><dd>{data.agent?.name}</dd>
                  <dt className="text-ink-3">Status</dt><dd>{data.agent?.status}</dd>
                  <dt className="text-ink-3">Account</dt><dd className="truncate font-mono text-xs">{data.agent?.near_account}</dd>
                  <dt className="text-ink-3">Can call</dt><dd className="font-mono text-xs">{data.contract.id} only</dd>
                </dl>
              </Card>
            </div>
          </div>
        </>
      )}
    </main>
  );
}

function PolicyBuilder({ onDrafted }: { onDrafted: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DraftResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function draft() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/policy/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not draft the policy");
      setResult(j);
      await onDrafted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 border-t border-rule pt-4">
      <h3 className="text-sm font-medium">Change the rules in plain English</h3>
      <p className="mt-1 text-xs text-ink-3">The AI only translates your words into numbers. Code checks the result, and nothing changes until you sign it on-chain.</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={1000}
        placeholder="e.g. Purchases above $5 need my approval, and keep AI spending under $10 a day."
        className="mt-2 w-full rounded-md border border-rule-strong bg-paper p-2 text-sm"
      />
      <button disabled={busy || text.trim().length < 5} onClick={draft} className="mt-2 rounded-md border border-rule-strong px-3 py-1.5 text-sm disabled:opacity-40">
        {busy ? "Drafting…" : "Draft new policy"}
      </button>
      {error && <p className="mt-2 text-xs text-failed">{error}</p>}
      {result && (
        <div className="mt-3 space-y-2 text-xs">
          {result.changes.length > 0 && (
            <table className="w-full">
              <thead className="text-left text-ink-3"><tr><th className="font-normal">Rule</th><th className="font-normal">Now</th><th className="font-normal">New</th></tr></thead>
              <tbody>
                {result.changes.map((c) => (
                  <tr key={c.field}><td>{c.label}</td><td className="font-mono text-ink-3">{c.from}</td><td className="font-mono">{c.to}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {result.unsupported.map((u) => <p key={u} className="text-pending">Not supported, left unchanged: &ldquo;{u}&rdquo;</p>)}
          {result.errors.map((e) => <p key={e} className="text-failed">✕ {e}</p>)}
          {result.warnings.map((w) => <p key={w} className="text-pending">! {w}</p>)}
          <p className="text-ink-3">Translated by {result.verification === "SIGNATURE_ATTESTED" ? "private TEE inference (signature verified)" : `NEAR AI (${result.verification})`}.</p>
          {result.hash && <p className="text-real">Draft v{result.version} saved. Sign it above to put it in force.</p>}
        </div>
      )}
    </div>
  );
}

/** Always available: record any owner transaction signed elsewhere (it is verified on-chain first). */
function RecordTx({ label, busy, onSubmit }: { label: string; busy: boolean; onSubmit: (txHash: string) => void }) {
  const [hash, setHash] = useState("");
  return (
    <details className="mt-3 rounded-md border border-rule p-3">
      <summary className="cursor-pointer text-xs text-ink-2">{label}</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (hash.trim()) onSubmit(hash);
        }}
        className="mt-2 flex flex-col gap-2 sm:flex-row"
      >
        <input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="Paste the Transaction ID" className="flex-1 rounded-md border border-rule-strong bg-paper p-1.5 font-mono text-xs" />
        <button disabled={busy} className="rounded-md border border-rule-strong px-3 py-1.5 text-xs disabled:opacity-40">Record</button>
      </form>
    </details>
  );
}

function CliFallback({ label, command, busy, onSubmit }: { label: string; command: string; busy: boolean; onSubmit: (txHash: string) => void }) {
  const [hash, setHash] = useState("");
  return (
    <details className="mt-3 rounded-md border border-rule p-3">
      <summary className="cursor-pointer text-xs text-ink-2">{label} with near-cli instead</summary>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-paper p-2 font-mono text-[11px]">{command}</pre>
      <button type="button" onClick={() => navigator.clipboard.writeText(command)} className="mt-1 text-xs text-accent">Copy command</button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (hash.trim()) onSubmit(hash);
        }}
        className="mt-2 flex flex-col gap-2 sm:flex-row"
      >
        <input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="Paste the Transaction ID" className="flex-1 rounded-md border border-rule-strong bg-paper p-1.5 font-mono text-xs" />
        <button disabled={busy} className="rounded-md border border-rule-strong px-3 py-1.5 text-xs disabled:opacity-40">Record</button>
      </form>
    </details>
  );
}

function StatusPill({ paused, agent }: { paused: boolean; agent: string }) {
  const live = !paused && agent === "running";
  return <span className={`rounded-full px-3 py-1 text-xs font-medium ${live ? "bg-real-soft text-real" : "bg-failed-soft text-failed"}`}>{live ? "● Operating" : paused ? "✕ Paused" : `✕ Agent ${agent}`}</span>;
}

function Stat({ label, units }: { label: string; units: string }) {
  return (
    <div className="bg-surface p-4">
      <div className="text-xs text-ink-3">{label}</div>
      <div className="mt-1 text-lg"><Money units={units} /></div>
    </div>
  );
}

function Control({ title, state, action, danger, disabled, onClick }: { title: string; state: string; action: string; danger: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-rule p-3">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-ink-3">{state}</div>
      </div>
      <button disabled={disabled} onClick={onClick} className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${danger ? "bg-failed text-white" : "border border-rule-strong"}`}>{action}</button>
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

function Banner({ tone, children }: { tone: "real" | "failed" | "pending" | "simulated"; children: React.ReactNode }) {
  const cls = { failed: "bg-failed-soft text-failed", pending: "bg-pending-soft text-pending", real: "bg-real-soft text-real", simulated: "bg-simulated-soft text-simulated" }[tone];
  return <p role="status" className={`mt-4 rounded-md p-3 text-sm ${cls}`}>{children}</p>;
}
