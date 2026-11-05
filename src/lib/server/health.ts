/**
 * Autonomous Business Survival Engine, server side: loads real records, runs the
 * pure engine (domain/health.ts), and keeps an audit trail of every risk and
 * intervention in health_events. It never moves money; the only behaviour it
 * changes is lean mode, which makes the agent spend less than it may.
 */
import { computeHealth, type Health, type HealthInput } from "@/lib/domain/health";
import { getTreasury } from "./contract";
import { db } from "./db";
import { getEvmChainConfigs, treasuryBalancesAll } from "./evm";
import { nearBalance } from "./near-rpc";
import { vendorPrice } from "./procurement";

const OPEN_STATES = ["PAID", "PLANNING", "PROCURING", "AWAITING_APPROVAL", "DRAFTING", "DELIVERED", "SETTLING", "REFUND_PENDING"];
const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : 0);
const big = (v: unknown) => BigInt(String(v ?? "0").split(".")[0] || "0");

export async function loadHealthInput(): Promise<{ input: HealthInput; businessId: string | null; policyVersion: number | null }> {
  const now = Date.now();
  const since = new Date(now - 14 * 86_400_000).toISOString();
  const [biz, agent, policy, pays, procs, calls, open, subs, quotes, approvals, bids, vendors, t, configs, balances] = await Promise.all([
    db().from("businesses").select("id").limit(1).maybeSingle(),
    db().from("agents").select("near_account").limit(1).maybeSingle(),
    db().from("policies").select("version").eq("status", "active").maybeSingle(),
    db().from("payments").select("amount_units,verified_at").eq("status", "VERIFIED").gte("verified_at", since),
    db().from("procurements").select("amount_units,created_at").eq("status", "confirmed").gte("created_at", since),
    db().from("inference_calls").select("cost_usd_micros,created_at").not("order_id", "is", null).gte("created_at", since),
    db().from("orders").select("id,onchain_order_id,state,price_units,created_at").in("state", OPEN_STATES),
    db().from("subscriptions").select("onchain_subscription_id,issues_total,issues_started,issue_price_units,next_due_at").eq("state", "ACTIVE"),
    db().from("orders").select("onchain_order_id,price_units,quote").eq("state", "AWAITING_PAYMENT").not("quote", "is", null),
    db().from("procurements").select("amount_units,created_at,orders!inner(onchain_order_id)").eq("status", "awaiting_approval"),
    db().from("ledger_entries").select("details,at").eq("event_type", "vendor_bids").gte("at", since),
    db().from("vendors").select("id,chain,unit_price_units").eq("approved", true),
    getTreasury().catch(() => null),
    getEvmChainConfigs().catch(() => []),
    treasuryBalancesAll().catch(() => []),
  ]);
  const agentGas = agent.data?.near_account ? await nearBalance(agent.data.near_account) : null;

  // Vendor spend already paid out of the escrow of orders still open: a full refund would need it back.
  const openIds = (open.data ?? []).map((o) => o.id);
  const paidNear = openIds.length ? ((await db().from("procurements").select("order_id,amount_units").in("order_id", openIds).eq("chain", "near").eq("status", "confirmed")).data ?? []) : [];

  const priceNow = new Map<string, bigint>();
  for (const v of vendors.data ?? []) {
    const p = vendorPrice({ id: v.id, unit_price_units: String(v.unit_price_units) });
    const cur = priceNow.get(v.chain);
    if (cur === undefined || p < cur) priceNow.set(v.chain, p);
  }

  const input: HealthInput = {
    now,
    payments: (pays.data ?? []).map((p) => ({ amount: big(p.amount_units), at: ms(p.verified_at) })),
    vendorSpend: (procs.data ?? []).map((p) => ({ amount: big(p.amount_units), at: ms(p.created_at) })),
    inference: (calls.data ?? []).map((c) => ({ amount: big(c.cost_usd_micros), at: ms(c.created_at) })),
    openOrders: (open.data ?? []).map((o) => ({
      onchainId: o.onchain_order_id,
      state: o.state,
      gross: big(o.price_units),
      vendorPaid: paidNear.filter((p) => p.order_id === o.id).reduce((a, p) => a + big(p.amount_units), 0n),
      paidAt: ms(o.created_at),
    })),
    subscriptions: (subs.data ?? []).map((s) => ({ onchainId: s.onchain_subscription_id, unstartedIssues: s.issues_total - s.issues_started, issuePrice: big(s.issue_price_units), nextDueAt: s.next_due_at ? ms(s.next_due_at) : null })),
    openQuotes: (quotes.data ?? []).map((q) => {
      const quote = q.quote as { expires_at?: string; max_expense_units?: string } | null;
      return { onchainId: q.onchain_order_id, amount: big(q.price_units), maxExpense: big(quote?.max_expense_units), expiresAt: ms(quote?.expires_at) };
    }),
    pendingApprovals: (approvals.data ?? []).map((a) => ({ onchainOrderId: (a.orders as unknown as { onchain_order_id: string }).onchain_order_id, amount: big(a.amount_units), since: ms(a.created_at) })),
    treasury: t
      ? { reserveBalance: big(t.reserve_balance), reserveTarget: big(t.reserve_target), reserveBps: t.reserve_bps, gasReserveYocto: big(t.gas_reserve), gasRefillYocto: big(t.gas_refill_amount), agentGasYocto: agentGas?.spendable ?? null }
      : null,
    chains: balances.map((b) => {
      const cfg = configs.find((c) => c.chain_id === b.chain.chainId);
      return { name: b.chain.name, configured: !!cfg, usdc: b.usdc, gasOk: cfg ? b.eth >= BigInt(cfg.gas_limit) * 1_000_000_000n : b.eth > 0n, cheapestPrice: priceNow.get(b.chain.key) ?? null };
    }),
    competitions: (bids.data ?? []).flatMap((e) => {
      const list = ((e.details as { bids?: { status: string; totalUnits: string }[] })?.bids ?? []).filter((b) => b.status === "won" || b.status === "eligible");
      const won = list.find((b) => b.status === "won");
      if (!won) return [];
      const dearest = list.reduce((a, b) => (big(b.totalUnits) > a ? big(b.totalUnits) : a), 0n);
      return [{ winner: big(won.totalUnits), dearest, at: ms(e.at) }];
    }),
  };
  return { input, businessId: biz.data?.id ?? null, policyVersion: policy.data?.version ?? null };
}

export async function currentHealth(): Promise<{ health: Health; businessId: string | null; policyVersion: number | null }> {
  const { input, businessId, policyVersion } = await loadHealthInput();
  return { health: computeHealth(input), businessId, policyVersion };
}

const POLICY_CHECK = {
  autonomous: (v: number | null) => ({ policy_version: v, rule: "Spends less than the agent is allowed to, or uses a power the contract already grants; no new permission, no approval needed." }),
  needs_owner: (v: number | null) => ({ policy_version: v, rule: "Moves money or changes the rules: only the owner can sign it. Proposed, not executed." }),
};

/**
 * Records what the engine sees: opens new risks and proposals, refreshes their
 * evidence, resolves those that cleared, and switches lean mode on or off.
 * Idempotent: one live record per condition (a unique index enforces it).
 */
export async function runHealthCheck(): Promise<{ status: string; opened: number; resolved: number; lean: boolean }> {
  const { health, businessId, policyVersion } = await currentHealth();
  if (!businessId) return { status: "no business", opened: 0, resolved: 0, lean: false };
  const live = (await db().from("health_events").select("id,code,kind,status").eq("business_id", businessId).is("resolved_at", null).in("status", ["open", "proposed", "executed"])).data ?? [];

  const wanted = new Map<string, { kind: "risk" | "intervention"; row: Record<string, unknown> }>();
  for (const r of health.risks) {
    wanted.set(`risk:${r.code}`, { kind: "risk", row: { kind: "risk", code: r.code, severity: r.severity, status: "open", title: r.title, detail: r.detail, evidence: r.evidence } });
  }
  for (const i of health.interventions) {
    // gas_refill is executed (and recorded with its transaction) by the treasury maintenance itself.
    if (i.code === "gas_refill") continue;
    wanted.set(`intervention:${i.code}`, {
      kind: "intervention",
      row: { kind: "intervention", code: i.code, mode: i.kind, status: i.kind === "autonomous" ? "executed" : "proposed", title: i.title, detail: i.detail, evidence: i.evidence, policy_check: POLICY_CHECK[i.kind](policyVersion) },
    });
  }

  let opened = 0;
  let resolved = 0;
  for (const [key, w] of wanted) {
    const existing = live.find((e) => `${e.kind}:${e.code}` === key);
    if (existing) {
      await db().from("health_events").update({ evidence: w.row.evidence, detail: w.row.detail, title: w.row.title }).eq("id", existing.id);
    } else {
      const { error } = await db().from("health_events").insert({ business_id: businessId, ...w.row });
      if (!error) opened++;
    }
  }
  for (const e of live) {
    if (e.code === "lean_skip" || e.code === "gas_refilled") continue; // per-order and per-refill records are history, not conditions
    if (!wanted.has(`${e.kind}:${e.code}`)) {
      await db().from("health_events").update({ status: e.status === "open" || e.status === "proposed" ? "resolved" : e.status, resolved_at: new Date().toISOString() }).eq("id", e.id);
      resolved++;
    }
  }
  return { status: health.status, opened, resolved, lean: health.lean.active };
}

/** True while the engine has lean mode switched on. */
export async function leanModeActive(businessId: string): Promise<{ active: boolean; reason: string | null }> {
  const r = await db().from("health_events").select("evidence,detail").eq("business_id", businessId).eq("code", "lean_mode").eq("status", "executed").is("resolved_at", null).limit(1).maybeSingle();
  return { active: !!r.data, reason: r.data?.detail ?? null };
}

/** Audit record of a single autonomous action (one lean skip, one gas refill), with its transaction if any. */
export async function recordHealthAction(businessId: string, code: string, title: string, detail: string, evidence: Record<string, unknown>, extra: { orderId?: string; txHash?: string; policyVersion?: number | null } = {}) {
  await db().from("health_events").insert({
    business_id: businessId,
    kind: "intervention",
    code,
    mode: "autonomous",
    status: "executed",
    title,
    detail,
    evidence,
    policy_check: POLICY_CHECK.autonomous(extra.policyVersion ?? null),
    order_id: extra.orderId ?? null,
    tx_hash: extra.txHash ?? null,
    resolved_at: new Date().toISOString(),
  });
}
