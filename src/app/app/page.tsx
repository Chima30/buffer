"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { Money } from "@/components/money";
import { MoneyFlow } from "@/components/money-flow";
import { LiveDot, LivePill, Sparkline } from "@/components/live";
import { HealthPanel } from "./health-panel";
import { BadgeCheck, CircleDollarSign, PiggyBank, Radio } from "lucide-react";
import { txHashOf, useNearWallet } from "@/components/wallet";
import { sessionHeaders, signInWithWallet } from "@/lib/client/session";

interface Overview {
  kpis: { days: string[]; revenueByDay: number[]; settledByDay: number[]; settledOrders: number; readAt: string };
  business: { id: string; name: string; status: "active" | "paused" } | null;
  contract: { id: string; paused: boolean; owner: string; policyVersion: number; policyHash: string | null; approvalAboveUnits: string; contributor: string; contributorBps: number };
  policy: { version: number; rules_hash: string; source_text: string | null; activated_at: string | null; values: Record<string, string> | null } | null;
  pendingPolicy: { version: number; hash: string; sourceText: string | null; createdAt: string | null; commands: OwnerCommand[] } | null;
  policyAnchored: boolean;
  agent: { id: string; name: string; role: string; near_account: string; status: "running" | "paused" | "frozen"; walletPubkey: string | null } | null;
  totals: { revenue: string; vendorSpend: string; inferenceSpend: string; net: string; ownerPaid: string; contributorPaid: string; reserveKept: string };
  businessTreasury: {
    reserve_bps: number; reserve_target: string; reserve_balance: string; gas_reserve: string; gas_refill_amount: string; gas_week_cap: string; gas_spent_week: string;
    agentGasYocto: string | null; ethereumShortfall: string;
    refills: { tx_hash: string; explorer_url: string; details: { amount_yocto?: string }; at: string }[];
  } | null;
  subscriptionSetup: {
    sku: string; title: string; contractSupports: boolean; policyAllows: boolean;
    product: { price: string; maxExpense: string; active: boolean } | null;
    plan: { interval_ns: number; min_issues: number; max_issues: number; active: boolean } | null;
    steps: { label: string; method: string; args: Record<string, unknown> }[];
  } | null;
  chainsSetup?: {
    treasuryAddress: string | null;
    policyCoversVendors: boolean;
    chains: {
      key: string; name: string; chainId: number; gasToken: string; configured: boolean; inPolicy: boolean; eth: string | null; usdc: string | null; explorerAddress: string | null;
      vendors: { id: string; name: string; address: string | null; priceNowUnits: string; basePriceUnits: string; approvedOnChain: boolean }[];
      steps: { label: string; method: string; args: Record<string, unknown> }[];
    }[];
    nearVendors: { id: string; name: string; address: string | null; priceNowUnits: string }[];
  };
  quoteSetup: {
    sku: string; title: string; contractSupports: boolean; policyAllows: boolean;
    rules: { min_price: string; max_price: string; max_expense_bps: number; max_ttl_ns: number; active: boolean } | null;
    steps: { label: string; method: string; args: Record<string, unknown> }[];
  } | null;
  subscriptions: { id: string; onchain_subscription_id: string; state: string; issues_total: number; issues_started: number; issue_price_units: string; customer_account: string | null; next_due_at: string | null; refund_units: string | null; refund_status: string | null; created_at: string }[];
  pendingApprovals: { id: string; amount_units: string; onchain_index: number; created_at: string; chain: string; orders: { onchain_order_id: string; state: string }; vendors: { name: string; near_account: string | null; evm_address: string | null } }[];
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
function cliCommand(contractId: string, method: string, args: Record<string, unknown>, signer: string, gas = "100 Tgas", deposit = "0 NEAR") {
  const json = JSON.stringify(args).replace(/"/g, '\\"');
  return `near --% contract call-function as-transaction ${contractId} ${method} json-args "${json}" prepaid-gas "${gas}" attached-deposit "${deposit}" sign-as ${signer} network-config testnet sign-with-keychain send`;
}

const yocto = (v: string | null | undefined) => (v ? Number(BigInt(v) / 10n ** 21n) / 1000 : 0);
const NEAR_YOCTO = (n: number) => (BigInt(Math.round(n * 1000)) * 10n ** 21n).toString();
/** Starting rules for the self-funding treasury; the owner can change them. */
const TREASURY_DEFAULTS = { reserve_bps: 1000, reserve_target: "20000000", gas_refill_amount: NEAR_YOCTO(0.5), gas_week_cap: NEAR_YOCTO(2) };

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "health", label: "Health" },
  { key: "rules", label: "Rules" },
  { key: "treasury", label: "Treasury" },
  { key: "products", label: "Products" },
  { key: "vendors", label: "Vendors" },
  { key: "activity", label: "Activity" },
] as const;
type TabKey = (typeof TABS)[number]["key"];
const TabContext = createContext<TabKey>("overview");

const subscribeHash = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};
const useTab = (): TabKey => {
  const raw = useSyncExternalStore(subscribeHash, () => window.location.hash.slice(1), () => "");
  // Old links to #money land on the treasury.
  const key = raw === "money" ? "treasury" : raw;
  return (TABS.find((t) => t.key === key)?.key ?? "overview") as TabKey;
};

export default function OwnerConsole() {
  const wallet = useNearWallet();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "real" | "failed" | "pending"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/owner/overview", { cache: "no-store" });
      const text = await res.text();
      const j = text ? JSON.parse(text) : { error: `The server returned an empty response (HTTP ${res.status})` };
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
  const tab = useTab();
  const [chains, setChains] = useState<Overview["chainsSetup"] | null>(null);
  const loadChains = useCallback(async () => {
    const r = await fetch("/api/owner/chains", { cache: "no-store" });
    if (r.ok) setChains(await r.json());
  }, []);
  useEffect(() => {
    if (tab !== "vendors" && tab !== "treasury") return;
    const first = setTimeout(loadChains, 0);
    const t = setInterval(loadChains, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [tab, loadChains]);

  /** Owner-only server calls: sign in once with the wallet (free message), then retry. */
  async function ownerFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const send = () => fetch(url, { ...init, headers: { ...(init.headers ?? {}), ...sessionHeaders() } });
    let r = await send();
    if (r.status === 401 && isOwner) {
      setNotice({ tone: "pending", text: "Sign the short sign-in message in your wallet (free, not a transaction)…" });
      await signInWithWallet(wallet);
      r = await send();
    }
    return r;
  }

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

  async function draftPricing() {
    if (!isOwner) return setNotice({ tone: "failed", text: "Connect the owner wallet to draft policy changes." });
    setBusy("Policy draft");
    const r = await ownerFetch("/api/policy/pricing-draft", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    setNotice(r.ok ? { tone: "pending", text: j.version ? `Policy v${j.version} drafted. Sign "Anchor policy v${j.version}" in the policy card to put it in force.` : j.note } : { tone: "failed", text: j.error ?? "Could not draft the policy" });
    setBusy(null);
    await load();
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
    <main className="enter">
      <div>
        <p className="text-sm text-ink-3">Owner console</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-[28px] font-medium leading-[1.15] tracking-[-0.02em] sm:text-[32px]">{data?.business?.name ?? "Business"}</h1>
        </div>
      </div>

      {!wallet.signedAccountId && <Banner tone="simulated">Anyone can view this console; only the owner can act. Every change is a transaction the contract accepts from the owner account alone. Connect the owner wallet to act.</Banner>}
      {wallet.signedAccountId && data && !isOwner && <Banner tone="failed">Connected as {wallet.signedAccountId}. Only {data.contract.owner} can act; the contract would reject anyone else.</Banner>}
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
      {error && <Banner tone="failed">{error}</Banner>}
      {data?.alerts.map((a) => <Banner key={a} tone="pending">Low balance: {a}</Banner>)}
      {!data && !error && (
        <div aria-label="Loading the console" className="mt-6 space-y-6">
          <div className="skeleton h-11" />
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-32" />)}
          </div>
          <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
            <div className="skeleton h-72" />
            <div className="skeleton h-72" />
          </div>
        </div>
      )}

      {data && (
        <TabContext.Provider value={tab}>
          <nav aria-label="Owner console sections" className="sticky top-14 z-10 -mx-5 mt-6 overflow-x-auto border-b border-rule bg-paper/95 px-5 backdrop-blur sm:-mx-8 sm:px-8 lg:top-16">
            <ul className="flex gap-1">
              {TABS.map((t) => (
                <li key={t.key}>
                  <a
                    href={`#${t.key}`}
                    aria-current={tab === t.key ? "page" : undefined}
                    className={`relative block whitespace-nowrap px-3 py-3 text-sm transition-colors duration-150 ${tab === t.key ? "text-ink after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ink" : "text-ink-3 hover:text-ink"}`}
                  >
                    {t.label}
                    {t.key === "overview" && data.pendingApprovals.length > 0 && <span className="ml-1.5 rounded-full bg-pending-soft px-1.5 text-xs text-pending">{data.pendingApprovals.length}</span>}
                    {t.key === "treasury" && data.refunds.length > 0 && <span className="ml-1.5 rounded-full bg-failed-soft px-1.5 text-xs text-failed">{data.refunds.length}</span>}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          {tab === "overview" && (
            <>
              <section className="stagger mt-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
                {(() => {
                  const k = data.kpis;
                  const week = (xs: number[], from: number) => xs.slice(from, from + 7).reduce((a, b) => a + b, 0);
                  const thisWeek = week(k.revenueByDay, 7), lastWeek = week(k.revenueByDay, 0);
                  const delta = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : null;
                  const t = data.businessTreasury;
                  const live = !data.contract.paused && data.agent?.status === "running";
                  return (
                    <>
                      <Kpi icon={CircleDollarSign} label="Revenue received" value={<Money units={data.totals.revenue} />} foot={delta === null ? "Last 14 days" : <span className={delta >= 0 ? "text-real" : "text-failed"}>{delta >= 0 ? "↑" : "↓"} {Math.abs(delta)}% vs last week</span>} spark={k.revenueByDay} />
                      <Kpi icon={BadgeCheck} label="Orders settled" value={<span className="font-mono tabular">{k.settledOrders}</span>} foot="Paid out 70/30 on-chain" spark={k.settledByDay} />
                      <Kpi icon={PiggyBank} label="Business reserve" value={t ? <Money units={t.reserve_balance} /> : "—"} foot={t && BigInt(t.reserve_target) > 0n ? <span>Target <Money units={t.reserve_target} /></span> : "Not set"} progress={t && BigInt(t.reserve_target) > 0n ? Number((BigInt(t.reserve_balance) * 100n) / BigInt(t.reserve_target)) : null} />
                      <Kpi icon={Radio} label="Business status" value={<span className={live ? "text-real" : "text-pending"}>{live ? "Live" : data.contract.paused ? "Paused" : "Agent " + (data.agent?.status ?? "off")}</span>} foot={<span className="flex items-center gap-1.5"><LiveDot tone={live ? "live" : "warn"} /> Read from NEAR at {new Date(k.readAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>} glow={live} />
                    </>
                  );
                })()}
              </section>

              <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            {(() => {
                  const r = BigInt(data.totals.revenue), v = BigInt(data.totals.vendorSpend), ai = BigInt(data.totals.inferenceSpend), c = BigInt(data.totals.contributorPaid), kept = BigInt(data.totals.reserveKept ?? "0");
                  const owner = r - v - ai - c - kept;
                  if (r <= 0n || owner < 0n) return null;
                  return (
                    <MoneyFlow
                      title="Where all revenue went"
                      sourceLabel="Customers paid"
                      caption={<>Net revenue is split {100 - data.contract.contributorBps / 100}/{data.contract.contributorBps / 100} between owner and contributor, after costs</>}
                      groups={[
                        { label: "Costs", leaves: [{ label: "Data vendors", units: v, color: "chain" }, { label: "AI inference", units: ai, color: "ai" }] },
                        { label: "Net revenue", leaves: [{ label: "Owner", units: owner, color: "owner", note: "Includes orders not settled yet" }, { label: "Contributor", units: c, color: "contrib" }, ...(kept > 0n ? [{ label: "Business reserve", units: kept, color: "vendor" as const, note: "Kept to pay the business's own bills" }] : [])] },
                      ]}
                    />
                  );
                })()}
                <section className="lift rounded-[var(--radius-card)] border border-rule bg-surface">
                  <h2 className="flex items-center justify-between border-b border-rule px-5 py-3 font-medium">
                    Business health
                    <LivePill tone={!data.contract.paused && data.agent?.status === "running" ? "live" : "warn"}>{!data.contract.paused && data.agent?.status === "running" ? "Live" : "Check"}</LivePill>
                  </h2>
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-rule">
                      {(
                        [
                          ["Contract", data.contract.id, data.contract.paused ? "Paused" : "Taking orders", data.contract.paused ? "warn" : "live"],
                          ["Agent wallet", "OutLayer TEE custody", data.agent?.status === "running" ? "Running" : (data.agent?.status ?? "—"), data.agent?.status === "running" ? "live" : "warn"],
                          ["Policy", `v${data.contract.policyVersion}`, data.policyAnchored ? "Anchored" : "Half-signed", data.policyAnchored ? "live" : "warn"],
                          ["Agent gas", data.businessTreasury ? `${yocto(data.businessTreasury.agentGasYocto).toFixed(2)} NEAR` : "—", data.businessTreasury && yocto(data.businessTreasury.agentGasYocto) >= 1 ? "Funded" : "Low", data.businessTreasury && yocto(data.businessTreasury.agentGasYocto) >= 1 ? "live" : "warn"],
                          ["Approvals", `${data.pendingApprovals.length} waiting`, data.pendingApprovals.length ? "Needs you" : "Clear", data.pendingApprovals.length ? "warn" : "live"],
                          ["Refunds", `${data.refunds.length} open`, data.refunds.length ? "Needs you" : "Clear", data.refunds.length ? "warn" : "live"],
                        ] as [string, string, string, "live" | "warn"][]
                      ).map(([k, sub, v, tone]) => (
                        <tr key={k}>
                          <td className="px-5 py-2.5">
                            <div>{k}</div>
                            <div className="truncate font-mono text-[11px] text-ink-3">{sub}</div>
                          </td>
                          <td className="px-5 py-2.5 text-right">
                            <LivePill tone={tone}>{v}</LivePill>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              </div>
            </>
          )}

          {tab === "health" && <HealthPanel />}

          <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
            <div className="contents">
              <Card tab="overview" title={`Approvals${data.pendingApprovals.length ? ` (${data.pendingApprovals.length})` : ""}`}>
                {data.pendingApprovals.length === 0 ? (
                  <p className="text-sm text-ink-3">Nothing waiting. Purchases above <Money units={data.contract.approvalAboveUnits} /> will appear here.</p>
                ) : (
                  <ul className="space-y-4">
                    {data.pendingApprovals.map((p) => {
                      const evm = p.chain !== "near";
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

              <Card tab="treasury" title="Recent orders">
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
                <Card tab="treasury" title="Refunds">
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

              <Card tab="activity" wide title="Agent decisions">
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

            <div className="contents">
              <Card tab="overview" title="Emergency controls">
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

              <Card tab="rules" wide title="Policy">
                <p className="text-sm">
                  Version {data.contract.policyVersion}{" "}
                  {data.policyAnchored ? <span className="text-real">● matches the on-chain anchor</span> : <span className="text-failed">✕ does not match the on-chain anchor: the agent will not act</span>}
                </p>
                {data.policy?.source_text && <blockquote className="mt-3 border-l-2 border-rule-strong pl-3 text-sm text-ink-2">{data.policy.source_text}</blockquote>}
                {data.policy?.values && (
                  <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs">
                    {Object.entries(VALUE_LABELS).map(([k, [label, unit]]) => (
                      <div key={k} className="contents"><dt className="text-ink-3">{label}</dt><dd className="text-right font-mono tabular">{Number(data.policy?.values?.[k] ?? 0).toFixed(2)} {unit}</dd></div>
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
                <PolicyBuilder onDrafted={load} ownerFetch={ownerFetch} canDraft={isOwner} />
              </Card>

              <Card tab="treasury" first title="Self-funding treasury">
                {!data.businessTreasury ? (
                  <p className="text-sm text-ink-3">The self-funding treasury needs the latest contract upgrade.</p>
                ) : (
                  (() => {
                    const t = data.businessTreasury;
                    const rulesOn = t.reserve_bps > 0 || BigInt(t.gas_refill_amount) > 0n;
                    return (
                      <div className="space-y-5 text-sm">
                        <p className="text-ink-2">The business pays its own bills from its revenue, under your rules. Only you can change them or withdraw.</p>
                        <div>
                          <div className="flex items-baseline justify-between"><span className="font-medium">Business reserve</span><Money units={t.reserve_balance} /></div>
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
                            <div className="h-full rounded-full bg-[var(--flow-vendor)] transition-transform duration-500" style={{ width: `${Math.min(100, BigInt(t.reserve_target) > 0n ? Number((BigInt(t.reserve_balance) * 1000n) / BigInt(t.reserve_target)) / 10 : 0)}%` }} />
                          </div>
                          <p className="mt-1.5 text-xs text-ink-3">{t.reserve_bps > 0 ? <>Keeps {t.reserve_bps / 100}% of your share until it holds <Money units={t.reserve_target} />. Pays refunds first</> : "Not keeping anything yet"}</p>
                        </div>
                        <div>
                          <div className="flex items-baseline justify-between"><span className="font-medium">Agent gas</span><span className="font-mono tabular">{yocto(t.agentGasYocto).toFixed(3)} <span className="text-xs text-ink-3">NEAR</span></span></div>
                          <p className="mt-1 text-xs text-ink-3">
                            {BigInt(t.gas_refill_amount) > 0n
                              ? <>Refills {yocto(t.gas_refill_amount)} NEAR below 1 NEAR, at most {yocto(t.gas_week_cap)} a week ({yocto(t.gas_spent_week)} used). Gas reserve {yocto(t.gas_reserve).toFixed(3)} NEAR</>
                              : "Automatic refills are off"}
                          </p>
                          {t.refills.length > 0 && (
                            <ul className="mt-2 space-y-1">
                              {t.refills.map((r) => (
                                <li key={r.tx_hash} className="flex justify-between font-mono text-xs text-ink-3">
                                  <span>{r.at.replace("T", " ").slice(5, 16)} · {yocto(r.details.amount_yocto ?? "0")} NEAR</span>
                                  <a href={r.explorer_url} target="_blank" rel="noreferrer" className="text-accent">tx {r.tx_hash.slice(0, 8)}… ↗</a>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <CrossChainTreasury chains={chains} fallback={data.treasury} />
                        <div className="space-y-1 border-t border-rule pt-3">
                          {!rulesOn && <p className="text-xs text-ink-2">Turn it on: keep 10% of your share up to 20 USDC, refill the agent 0.5 NEAR at a time, at most 2 NEAR a week.</p>}
                          <CliFallback label={rulesOn ? "Change the rules" : "Turn on the self-funding treasury"} command={cliCommand(data.contract.id, "set_treasury_rules", TREASURY_DEFAULTS, data.contract.owner, "30 Tgas")} busy={!!busy} onSubmit={(h) => recordPasted("Treasury rules", h)} />
                          <CliFallback label="Fund the gas reserve with 3 NEAR" command={cliCommand(data.contract.id, "fund_gas_reserve", {}, data.contract.owner, "30 Tgas", "3 NEAR")} busy={!!busy} onSubmit={(h) => recordPasted("Gas reserve", h)} />
                          {BigInt(t.reserve_balance) > 0n && (
                            <CliFallback label="Withdraw the business reserve" command={cliCommand(data.contract.id, "withdraw_reserve", { amount: t.reserve_balance }, data.contract.owner, "100 Tgas")} busy={!!busy} onSubmit={(h) => recordPasted("Reserve withdrawal", h)} />
                          )}
                        </div>
                      </div>
                    );
                  })()
                )}
              </Card>

              {data.subscriptionSetup && (
                <Card tab="products" title="Subscriptions">
                  {(() => {
                    const su = data.subscriptionSetup!;
                    if (!su.contractSupports) return <p className="text-sm text-ink-2">Prepaid subscriptions need the latest contract upgrade.</p>;
                    return (
                      <div className="space-y-3 text-sm">
                        <p className="text-ink-2">
                          {su.plan?.active
                            ? <>Customers prepay {su.plan.min_issues} to {su.plan.max_issues} issues of {su.title}; the agent may open one every {Math.round(su.plan.interval_ns / 3.6e12) || 1} hour{Math.round(su.plan.interval_ns / 3.6e12) === 1 ? "" : "s"} and no sooner. Unstarted issues stay in escrow until the customer or you cancel.</>
                            : <>Not on sale yet. Two owner transactions switch it on.</>}
                        </p>
                        {!su.policyAllows && (
                          <div className="rounded-md border border-rule p-3">
                            <p className="text-xs font-medium">Allow selling it in the policy</p>
                            <p className="mt-1 text-xs text-ink-3">The agent only delivers products the signed policy prices. This drafts the next policy version with {su.title} at no less than its price; anchor it in the policy card above.</p>
                            <button type="button" disabled={!!busy} onClick={draftPricing} className="press mt-2 h-8 rounded-lg bg-ink px-3 text-xs font-medium text-paper disabled:opacity-40">
                              Draft the policy change
                            </button>
                          </div>
                        )}
                        {su.steps.map((st) => (
                          <div key={st.method} className="rounded-md border border-rule p-3">
                            <p className="text-xs font-medium">{st.label}</p>
                            {isOwner && (
                              <button type="button" disabled={!!busy} onClick={() => act(st.label, data.contract.id, st.method, st.args, "30000000000000")} className="press mt-2 h-8 rounded-lg bg-ink px-3 text-xs font-medium text-paper disabled:opacity-40">
                                Sign with wallet
                              </button>
                            )}
                            <CliFallback label={st.label} command={cliCommand(data.contract.id, st.method, st.args, data.contract.owner, "30 Tgas")} busy={!!busy} onSubmit={(h) => recordPasted(st.label, h)} />
                          </div>
                        ))}
                        {data.subscriptions.length > 0 && (
                          <ul className="divide-y divide-rule border-t border-rule">
                            {data.subscriptions.map((sub) => (
                              <li key={sub.id} className="py-2.5">
                                <div className="flex items-center justify-between gap-2">
                                  <Link href={`/subscriptions/${sub.id}`} className="font-mono text-xs text-accent">{sub.onchain_subscription_id}</Link>
                                  <span className="text-xs text-ink-3">{sub.state.toLowerCase()} · {sub.issues_started}/{sub.issues_total} issues</span>
                                </div>
                                <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-ink-3">
                                  <span className="truncate">{sub.customer_account}</span>
                                  {sub.state === "ACTIVE" && sub.next_due_at && <span>next {sub.next_due_at.replace("T", " ").slice(5, 16)} UTC</span>}
                                  {sub.refund_units && <span>refund <Money units={sub.refund_units} /> {sub.refund_status?.toLowerCase()}</span>}
                                </div>
                                {sub.state === "ACTIVE" && (
                                  <CliFallback
                                    label="Cancel and refund the unstarted issues"
                                    command={cliCommand(data.contract.id, "cancel_subscription", { subscription_id: sub.onchain_subscription_id }, data.contract.owner)}
                                    busy={!!busy}
                                    onSubmit={(h) => recordPasted("Subscription cancelled", h)}
                                  />
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })()}
                </Card>
              )}

              {data.quoteSetup && (
                <Card tab="products" title="Custom quotes">
                  {(() => {
                    const qs = data.quoteSetup!;
                    if (!qs.contractSupports) return <p className="text-sm text-ink-2">Custom quotes need the latest contract upgrade.</p>;
                    return (
                      <div className="space-y-3 text-sm">
                        <p className="text-ink-2">
                          {qs.rules?.active
                            ? <>The agent may quote <Money units={qs.rules.min_price} /> to <Money units={qs.rules.max_price} />, give itself at most {qs.rules.max_expense_bps / 100}% of the price to spend, and keep a quote open {Math.round(qs.rules.max_ttl_ns / 6e10)} minutes. The contract refuses anything else.</>
                            : <>Not on sale yet. The owner sets the limits the contract will enforce on every quote.</>}
                        </p>
                        {!qs.policyAllows && (
                          <div className="rounded-md border border-rule p-3">
                            <p className="text-xs font-medium">Allow selling it in the policy</p>
                            <p className="mt-1 text-xs text-ink-3">Drafts the next policy version with {qs.title} at no less than the minimum price; anchor it in the policy card.</p>
                            <button type="button" disabled={!!busy} onClick={draftPricing} className="press mt-2 h-8 rounded-lg bg-ink px-3 text-xs font-medium text-paper disabled:opacity-40">Draft the policy change</button>
                          </div>
                        )}
                        {qs.steps.map((st) => (
                          <div key={st.method} className="rounded-md border border-rule p-3">
                            <p className="text-xs font-medium">{st.label}</p>
                            {isOwner && (
                              <button type="button" disabled={!!busy} onClick={() => act(st.label, data.contract.id, st.method, st.args, "30000000000000")} className="press mt-2 h-8 rounded-lg bg-ink px-3 text-xs font-medium text-paper disabled:opacity-40">
                                Sign with wallet
                              </button>
                            )}
                            <CliFallback label={st.label} command={cliCommand(data.contract.id, st.method, st.args, data.contract.owner, "30 Tgas")} busy={!!busy} onSubmit={(h) => recordPasted(st.label, h)} />
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </Card>
              )}

              <Card tab="vendors" wide title="Vendors and chains">
                {(() => {
                  const cs = chains;
                  if (!cs) return <p className="text-sm text-ink-3">Reading the chains…</p>;
                  const eth = (w: string | null) => (w === null ? "—" : (Number(BigInt(w) / 10n ** 12n) / 1e6).toFixed(4));
                  return (
                    <div className="space-y-3 text-sm">
                      <p className="text-ink-2">When an order needs data, the agent asks every approved vendor for its price this hour, adds that chain&apos;s gas, and buys from the cheapest within your limits.</p>
                      {!cs.policyCoversVendors && (
                        <div className="rounded-md border border-rule p-3">
                          <p className="text-xs font-medium">Allow the new vendors in the policy</p>
                          <p className="mt-1 text-xs text-ink-3">Drafts the next policy version adding the Base and Arbitrum vendors under the same limits and approvals; anchor it in the policy card.</p>
                          <button type="button" disabled={!!busy} onClick={draftPricing} className="press mt-2 h-8 rounded-lg bg-ink px-3 text-xs font-medium text-paper disabled:opacity-40">Draft the policy change</button>
                        </div>
                      )}
                      <ul className="divide-y divide-rule border-t border-rule">
                        {cs.nearVendors.map((v) => (
                          <li key={v.id} className="flex items-baseline justify-between gap-2 py-2.5">
                            <span><span className="font-medium">NEAR</span> <span className="text-xs text-ink-3">{v.name}</span></span>
                            <span className="text-xs text-ink-3">this hour <Money units={v.priceNowUnits} /></span>
                          </li>
                        ))}
                        {cs.chains.map((c) => (
                          <li key={c.key} className="py-2.5">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="font-medium">{c.name}</span>
                              <span className={`text-xs ${c.configured && c.inPolicy ? "text-real" : "text-ink-3"}`}>{c.configured ? (c.inPolicy ? "on" : "on in the contract, not in the policy yet") : "off"}</span>
                            </div>
                            <p className="mt-0.5 text-xs text-ink-3">
                              Treasury: {c.usdc === null ? "—" : <Money units={c.usdc} />} · {eth(c.eth)} {c.gasToken} for gas
                              {c.explorerAddress && <> · <a href={c.explorerAddress} target="_blank" rel="noreferrer" className="text-accent">explorer ↗</a></>}
                            </p>
                            {c.vendors.map((v) => (
                              <p key={v.id} className="text-xs text-ink-3">{v.name}: this hour <Money units={v.priceNowUnits} />{v.approvedOnChain ? "" : " · not approved in the contract yet"}</p>
                            ))}
                            {c.steps.map((st) => (
                              <div key={st.label} className="mt-2 rounded-md border border-rule p-3">
                                <p className="text-xs font-medium">{st.label}</p>
                                {isOwner && (
                                  <button type="button" disabled={!!busy} onClick={() => act(st.label, data.contract.id, st.method, st.args, "30000000000000")} className="press mt-2 h-8 rounded-lg bg-ink px-3 text-xs font-medium text-paper disabled:opacity-40">Sign with wallet</button>
                                )}
                                <CliFallback label={st.label} command={cliCommand(data.contract.id, st.method, st.args, data.contract.owner, "30 Tgas")} busy={!!busy} onSubmit={(h) => recordPasted(st.label, h)} />
                              </div>
                            ))}
                          </li>
                        ))}
                      </ul>
                      {cs.treasuryAddress && (
                        <p className="text-xs text-ink-3">
                          Fund the treasury <span className="break-all font-mono">{cs.treasuryAddress}</span> on each chain: test USDC from faucet.circle.com, and a little of that chain&apos;s gas token (Sepolia ETH, POL on Amoy, AVAX on Fuji) from its faucet. A chain the treasury cannot pay on is skipped, never failed.
                        </p>
                      )}
                    </div>
                  );
                })()}
              </Card>

              <Card tab="overview" title="Agent">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-ink-3">Name</dt><dd>{data.agent?.name}</dd>
                  <dt className="text-ink-3">Status</dt><dd>{data.agent?.status}</dd>
                  <dt className="text-ink-3">Account</dt><dd className="truncate font-mono text-xs">{data.agent?.near_account}</dd>
                  <dt className="text-ink-3">Can call</dt><dd className="font-mono text-xs">{data.contract.id} only</dd>
                </dl>
              </Card>
            </div>
          </div>
        </TabContext.Provider>
      )}
    </main>
  );
}

function PolicyBuilder({ onDrafted, ownerFetch, canDraft }: { onDrafted: () => Promise<void>; ownerFetch: (url: string, init?: RequestInit) => Promise<Response>; canDraft: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DraftResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function draft() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (!canDraft) throw new Error("Connect the owner wallet to draft policy changes");
      const res = await ownerFetch("/api/policy/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
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


/** One MPC-derived address pays on every EVM chain: its USDC and gas, chain by chain. */
function CrossChainTreasury({ chains, fallback }: { chains: Overview["chainsSetup"] | null; fallback: Overview["treasury"] }) {
  if (!chains) {
    return fallback ? (
      <div className="space-y-2">
        <div className="flex items-baseline justify-between"><span className="font-medium">Cross-chain treasury</span><span className="text-xs text-ink-3">reading chains…</span></div>
        <div className="skeleton h-24" />
      </div>
    ) : null;
  }
  const gas = (w: string | null) => (w === null ? "—" : (Number(BigInt(w) / 10n ** 12n) / 1e6).toFixed(4));
  const total = chains.chains.reduce((a, c) => a + BigInt(c.usdc ?? "0"), 0n);
  const live = chains.chains.filter((c) => c.configured && c.usdc !== null && BigInt(c.usdc) > 0n && c.eth !== null && BigInt(c.eth) > 0n);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="font-medium">Cross-chain treasury</span>
        <Money units={total.toString()} />
      </div>
      <p className="mt-0.5 text-xs text-ink-3">
        One address on every EVM chain, signed only by the contract through Chain Signatures · {live.length} of {chains.chains.length} chains ready
      </p>
      {chains.treasuryAddress && <p className="mt-1 break-all font-mono text-[11px] text-ink-3">{chains.treasuryAddress}</p>}
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.06em] text-ink-3">
            <th className="pb-1.5 font-medium">Chain</th>
            <th className="pb-1.5 text-right font-medium">USDC</th>
            <th className="pb-1.5 text-right font-medium">Gas</th>
            <th className="pb-1.5 text-right font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {chains.chains.map((c) => {
            const funded = c.usdc !== null && BigInt(c.usdc) > 0n && c.eth !== null && BigInt(c.eth) > 0n;
            const tone = !c.configured ? "off" : funded ? "live" : "warn";
            return (
              <tr key={c.key}>
                <td className="py-2">
                  {c.explorerAddress ? <a href={c.explorerAddress} target="_blank" rel="noreferrer" className="hover:text-accent">{c.name} ↗</a> : c.name}
                </td>
                <td className="py-2 text-right">{c.usdc === null ? "—" : <Money units={c.usdc} />}</td>
                <td className="py-2 text-right font-mono text-xs tabular">{gas(c.eth)} <span className="text-ink-3">{c.gasToken}</span></td>
                <td className="py-2 text-right">
                  <LivePill tone={tone}>{!c.configured ? "Off" : funded ? "Live" : "Needs funding"}</LivePill>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, foot, spark, progress, glow }: { icon: typeof Radio; label: string; value: React.ReactNode; foot: React.ReactNode; spark?: number[]; progress?: number | null; glow?: boolean }) {
  return (
    <div className={`lift relative overflow-hidden rounded-[var(--radius-card)] border border-rule bg-surface p-4 sm:p-5 ${glow ? "shadow-[0_0_0_1px_var(--accent-soft)]" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm text-ink-3">{label}</span>
        <span className={`grid h-8 w-8 place-items-center rounded-lg border border-rule ${glow ? "text-accent" : "text-ink-3"}`}>
          <Icon size={16} strokeWidth={1.6} />
        </span>
      </div>
      <div className="mt-2 text-[24px] leading-none sm:text-[28px]">{value}</div>
      <div className="mt-3 flex items-end justify-between gap-2">
        <span className="text-xs text-ink-3">{foot}</span>
        {spark && <Sparkline values={spark} className="hidden shrink-0 sm:block" />}
      </div>
      {progress !== undefined && progress !== null && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-raised">
          <div className="grow h-full rounded-full bg-accent" style={{ width: `${Math.min(100, progress)}%` }} />
        </div>
      )}
      {glow && <span aria-hidden className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-[radial-gradient(circle,var(--accent-glow),transparent_70%)]" />}
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

function Card({ title, tab, wide, first, children }: { title: string; tab?: TabKey; wide?: boolean; first?: boolean; children: React.ReactNode }) {
  const active = useContext(TabContext);
  if (tab && tab !== active) return null;
  return (
    <section className={`rounded-[var(--radius-card)] border border-rule bg-surface ${wide ? "lg:col-span-2" : ""} ${first ? "order-first" : ""}`}>
      <h2 className="border-b border-rule px-5 py-3 font-medium">{title}</h2>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Banner({ tone, children }: { tone: "real" | "failed" | "pending" | "simulated"; children: React.ReactNode }) {
  const cls = { failed: "bg-failed-soft text-failed", pending: "bg-pending-soft text-pending", real: "bg-real-soft text-real", simulated: "bg-simulated-soft text-simulated" }[tone];
  return <p role="status" className={`mt-4 rounded-md p-3 text-sm ${cls}`}>{children}</p>;
}
