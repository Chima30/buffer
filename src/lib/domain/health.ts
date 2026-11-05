/**
 * Autonomous Business Survival Engine: the pure part.
 *
 * Input: real business records (payments, vendor spend, inference, open orders,
 * subscription escrow, quotes, approvals, treasury and chain balances).
 * Output: actuals, a forecast that states its assumptions, runway, obligations,
 * risks, and interventions.
 *
 * Rules are deterministic thresholds; nothing here moves money. Interventions are
 * of two kinds only:
 *   - "autonomous": spends LESS than the agent is already allowed to (lean mode),
 *     or is something the contract already lets the agent do (gas refill). Never
 *     more spending, never new permissions.
 *   - "needs_owner": a recommendation the owner may sign (a top-up, a policy draft).
 * All amounts are USDC smallest units (6 decimals) unless named otherwise.
 */
export const DAY_MS = 86_400_000;

export interface HealthInput {
  now: number;
  payments: { amount: bigint; at: number }[];
  vendorSpend: { amount: bigint; at: number }[];
  inference: { amount: bigint; at: number }[];
  /** Paid orders not yet settled or refunded: the business owes a report or a refund. */
  openOrders: { onchainId: string; state: string; gross: bigint; vendorPaid: bigint; paidAt: number }[];
  /** Active subscriptions: prepaid issues not started yet, held in the contract's escrow. */
  subscriptions: { onchainId: string; unstartedIssues: number; issuePrice: bigint; nextDueAt: number | null }[];
  /** Unpaid quotes still open. */
  openQuotes: { onchainId: string; amount: bigint; maxExpense: bigint; expiresAt: number }[];
  pendingApprovals: { onchainOrderId: string; amount: bigint; since: number }[];
  treasury: { reserveBalance: bigint; reserveTarget: bigint; reserveBps: number; gasReserveYocto: bigint; gasRefillYocto: bigint; agentGasYocto: bigint | null } | null;
  /** Each EVM chain the contract can pay on, with this hour's cheapest vendor price there. */
  chains: { name: string; configured: boolean; usdc: bigint | null; gasOk: boolean; cheapestPrice: bigint | null }[];
  /** Vendor competitions: what the winner cost and what the dearest eligible bid would have cost. */
  competitions: { winner: bigint; dearest: bigint; at: number }[];
}

export type Severity = "info" | "warn" | "high";
export interface Risk {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
  evidence: Record<string, string | number>;
}
export interface Intervention {
  code: string;
  kind: "autonomous" | "needs_owner";
  title: string;
  detail: string;
  /** Where the owner acts, for needs_owner. */
  where?: "treasury" | "rules" | "vendors" | "overview";
  /** Autonomous interventions may only reduce spending or use a power the contract already grants. */
  effect: "reduce_spend" | "contract_granted" | "none";
  evidence: Record<string, string | number>;
}

export interface WindowStats {
  orders: number;
  revenue: bigint;
  vendorSpend: bigint;
  inference: bigint;
  net: bigint;
  /** Net as basis points of revenue (null without revenue). */
  marginBps: number | null;
  costPerOrder: bigint | null;
  inferencePerOrder: bigint | null;
}

export interface Health {
  status: "healthy" | "watch" | "at_risk";
  week: WindowStats;
  prevWeek: WindowStats;
  daily: { day: string; revenue: number; costs: number }[];
  forecast: {
    enoughData: boolean;
    minOrders: number;
    assumptions: string[];
    next7Revenue: { low: bigint; mid: bigint; high: bigint } | null;
    next7Costs: bigint | null;
    daily: { day: string; revenue: number }[];
  };
  runway: {
    /** Data purchases the cross-chain treasuries can still make at this hour's prices. */
    purchasesLeft: number;
    /** Orders the agent's gas plus the gas reserve can cover, at the stated assumption. */
    gasOrdersLeft: number | null;
    gasAssumption: string;
    /** Refund shortfall on open orders (vendor already paid) that the reserve covers. */
    refundExposure: bigint;
    reserveCoversRefunds: boolean;
  };
  obligations: {
    subscriptionIssues: number;
    subscriptionEscrow: bigint;
    openOrders: number;
    openOrdersGross: bigint;
    openQuotes: number;
    openQuotesAmount: bigint;
    pendingApprovals: number;
    pendingApprovalAmount: bigint;
    nextIssueAt: number | null;
  };
  savings: { competitions: number; savedUnits: bigint };
  lean: { active: boolean; reason: string };
  risks: Risk[];
  interventions: Intervention[];
}

const sum = (xs: { amount: bigint }[]) => xs.reduce((a, x) => a + x.amount, 0n);
const within = <T extends { at: number }>(xs: T[], from: number, to: number) => xs.filter((x) => x.at >= from && x.at < to);
const usdc = (u: bigint) => (Number(u) / 1e6).toFixed(2);
const YOCTO = 10n ** 24n;
/** Assumed agent gas per order: 5-7 contract calls through OutLayer at a few milliNEAR each. */
export const GAS_PER_ORDER_YOCTO = 30n * 10n ** 21n; // 0.03 NEAR
/** Below this many paid orders in 14 days a forecast would be guesswork. */
export const MIN_FORECAST_ORDERS = 3;

export function windowStats(input: HealthInput, from: number, to: number): WindowStats {
  const pays = within(input.payments, from, to);
  const revenue = sum(pays);
  const vendorSpend = sum(within(input.vendorSpend, from, to));
  const inference = sum(within(input.inference, from, to));
  const net = revenue - vendorSpend - inference;
  const orders = pays.length;
  return {
    orders,
    revenue,
    vendorSpend,
    inference,
    net,
    marginBps: revenue > 0n ? Number((net * 10_000n) / revenue) : null,
    costPerOrder: orders ? (vendorSpend + inference) / BigInt(orders) : null,
    inferencePerOrder: orders ? inference / BigInt(orders) : null,
  };
}

/** Lean mode: skip optional dataset purchases while margins are being squeezed. Spends less; never needs approval. */
export function leanMode(week: WindowStats): { active: boolean; reason: string } {
  if (week.orders < MIN_FORECAST_ORDERS) return { active: false, reason: `Needs at least ${MIN_FORECAST_ORDERS} orders in 7 days to judge margins (has ${week.orders})` };
  if (week.marginBps !== null && week.marginBps < 2000) {
    return { active: true, reason: `Net margin over the last 7 days is ${(week.marginBps / 100).toFixed(1)}%, under the 20% floor` };
  }
  return { active: false, reason: `Net margin over the last 7 days is ${week.marginBps === null ? "n/a" : (week.marginBps / 100).toFixed(1) + "%"}, above the 20% floor` };
}

export function computeHealth(input: HealthInput): Health {
  const now = input.now;
  const week = windowStats(input, now - 7 * DAY_MS, now + 1);
  const prevWeek = windowStats(input, now - 14 * DAY_MS, now - 7 * DAY_MS);

  // Daily actuals for the last 14 days (UTC days, oldest first).
  const start = new Date(now - 13 * DAY_MS);
  start.setUTCHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => start.getTime() + i * DAY_MS);
  const daily = days.map((d) => ({
    day: new Date(d).toISOString().slice(0, 10),
    revenue: Number(sum(within(input.payments, d, d + DAY_MS))) / 1e6,
    costs: Number(sum(within(input.vendorSpend, d, d + DAY_MS)) + sum(within(input.inference, d, d + DAY_MS))) / 1e6,
  }));

  // Forecast: trailing 14-day daily revenue, mid = mean, band = ±1 standard deviation. Stated, not hidden.
  const orders14 = week.orders + prevWeek.orders;
  const enoughData = orders14 >= MIN_FORECAST_ORDERS;
  const revs = daily.map((d) => d.revenue);
  const mean = revs.reduce((a, b) => a + b, 0) / revs.length;
  const sd = Math.sqrt(revs.reduce((a, b) => a + (b - mean) ** 2, 0) / revs.length);
  const toUnits = (x: number) => BigInt(Math.max(0, Math.round(x * 1e6)));
  const costRatio = week.revenue + prevWeek.revenue > 0n ? Number(week.vendorSpend + week.inference + prevWeek.vendorSpend + prevWeek.inference) / Number(week.revenue + prevWeek.revenue) : 0;
  const forecast: Health["forecast"] = {
    enoughData,
    minOrders: MIN_FORECAST_ORDERS,
    assumptions: [
      `Based on ${orders14} paid order${orders14 === 1 ? "" : "s"} in the last 14 days.`,
      "Next 7 days ≈ the 14-day average daily revenue × 7; the band is ± one standard deviation of daily revenue.",
      `Costs scale with revenue at the recent cost share (${(costRatio * 100).toFixed(0)}% of revenue went to data and AI).`,
      "Testnet demand is driven by testing, not a market: treat this as a method, not a prediction.",
    ],
    next7Revenue: enoughData ? { low: toUnits(Math.max(0, mean - sd) * 7), mid: toUnits(mean * 7), high: toUnits((mean + sd) * 7) } : null,
    next7Costs: enoughData ? toUnits(mean * 7 * costRatio) : null,
    daily: enoughData ? Array.from({ length: 7 }, (_, i) => ({ day: new Date(start.getTime() + (14 + i) * DAY_MS).toISOString().slice(0, 10), revenue: mean })) : [],
  };

  // Runway.
  const purchasesLeft = input.chains.reduce((a, c) => (c.configured && c.gasOk && c.usdc !== null && c.cheapestPrice && c.cheapestPrice > 0n ? a + Number(c.usdc / c.cheapestPrice) : a), 0);
  const t = input.treasury;
  const gasPool = t && t.agentGasYocto !== null ? t.agentGasYocto + t.gasReserveYocto : null;
  const refundExposure = input.openOrders.reduce((a, o) => a + o.vendorPaid, 0n);
  const runway: Health["runway"] = {
    purchasesLeft,
    gasOrdersLeft: gasPool === null ? null : Number(gasPool / GAS_PER_ORDER_YOCTO),
    gasAssumption: "Assumes about 0.03 NEAR of agent gas per order (5-7 contract calls).",
    refundExposure,
    reserveCoversRefunds: !t || t.reserveBalance >= refundExposure,
  };

  const obligations: Health["obligations"] = {
    subscriptionIssues: input.subscriptions.reduce((a, s) => a + s.unstartedIssues, 0),
    subscriptionEscrow: input.subscriptions.reduce((a, s) => a + s.issuePrice * BigInt(s.unstartedIssues), 0n),
    openOrders: input.openOrders.length,
    openOrdersGross: input.openOrders.reduce((a, o) => a + o.gross, 0n),
    openQuotes: input.openQuotes.filter((q) => q.expiresAt > now).length,
    openQuotesAmount: input.openQuotes.filter((q) => q.expiresAt > now).reduce((a, q) => a + q.amount, 0n),
    pendingApprovals: input.pendingApprovals.length,
    pendingApprovalAmount: input.pendingApprovals.reduce((a, p) => a + p.amount, 0n),
    nextIssueAt: input.subscriptions.map((s) => s.nextDueAt).filter((x): x is number => x !== null).sort((a, b) => a - b)[0] ?? null,
  };

  const savings = {
    competitions: input.competitions.length,
    savedUnits: input.competitions.reduce((a, c) => a + (c.dearest > c.winner ? c.dearest - c.winner : 0n), 0n),
  };

  const lean = leanMode(week);
  const risks: Risk[] = [];
  const interventions: Intervention[] = [];

  // R1 reserve.
  if (t && t.reserveTarget > 0n) {
    const pct = Number((t.reserveBalance * 100n) / t.reserveTarget);
    if (t.reserveBalance === 0n) risks.push({ code: "reserve_empty", severity: "warn", title: "Business reserve is empty", detail: "Refund shortfalls would need an owner top-up.", evidence: { reserve: usdc(t.reserveBalance), target: usdc(t.reserveTarget) } });
    else if (pct < 25) risks.push({ code: "reserve_low", severity: "info", title: `Reserve at ${pct}% of target`, detail: `It grows by ${t.reserveBps / 100}% of the owner's share on every settled order.`, evidence: { reserve: usdc(t.reserveBalance), target: usdc(t.reserveTarget) } });
  }
  // R2 refunds the reserve could not cover.
  if (!runway.reserveCoversRefunds) {
    risks.push({ code: "refund_exposure", severity: "high", title: "Open orders could not all be refunded in full", detail: "Vendors were already paid on these orders; the reserve holds less than that.", evidence: { exposure: usdc(refundExposure), reserve: usdc(t?.reserveBalance ?? 0n) } });
    interventions.push({ code: "topup_reserve", kind: "needs_owner", title: "Top up for refunds", detail: "Fund the refund pool of the affected orders (Treasury tab → Refunds), or let the reserve grow before taking more data-heavy orders.", where: "treasury", effect: "none", evidence: { exposure: usdc(refundExposure) } });
  }
  // R3 agent gas.
  if (t && t.agentGasYocto !== null) {
    const canRefill = t.gasRefillYocto > 0n && t.gasReserveYocto >= t.gasRefillYocto;
    if (t.agentGasYocto < YOCTO && !canRefill) {
      risks.push({ code: "gas_stranded", severity: "high", title: "Agent gas is low and the gas reserve cannot refill it", detail: "The agent will stop calling the contract when its gas runs out.", evidence: { agent_gas_near: (Number(t.agentGasYocto / 10n ** 21n) / 1000).toFixed(3), gas_reserve_near: (Number(t.gasReserveYocto / 10n ** 21n) / 1000).toFixed(3) } });
      interventions.push({ code: "fund_gas_reserve", kind: "needs_owner", title: "Fund the gas reserve", detail: "Send NEAR to the gas reserve (Treasury tab). Refills are capped weekly by the contract.", where: "treasury", effect: "none", evidence: {} });
    } else if (t.agentGasYocto < YOCTO && canRefill) {
      interventions.push({ code: "gas_refill", kind: "autonomous", title: "Refill agent gas from the reserve", detail: "The contract lets the agent ask for one refill at a time within the owner's weekly cap; the runtime does this on its next run.", effect: "contract_granted", evidence: { agent_gas_near: (Number(t.agentGasYocto / 10n ** 21n) / 1000).toFixed(3) } });
    }
  }
  // R4 chain treasuries that cannot pay their vendor.
  for (const c of input.chains.filter((c) => c.configured)) {
    if (c.usdc !== null && c.cheapestPrice !== null && (c.usdc < c.cheapestPrice || !c.gasOk)) {
      risks.push({ code: `chain_short:${c.name}`, severity: "info", title: `${c.name} treasury cannot pay its vendor`, detail: "That vendor is skipped in competitions until it is funded; the other chains still bid.", evidence: { usdc: usdc(c.usdc), price_now: usdc(c.cheapestPrice), gas_ok: c.gasOk ? "yes" : "no" } });
      interventions.push({ code: `fund_chain:${c.name}`, kind: "needs_owner", title: `Fund the treasury on ${c.name}`, detail: "Send test USDC (and gas) to the cross-chain treasury address on that chain.", where: "treasury", effect: "none", evidence: { usdc: usdc(c.usdc) } });
    }
  }
  // R5 inference cost per order rising.
  if (week.orders >= MIN_FORECAST_ORDERS && prevWeek.orders >= MIN_FORECAST_ORDERS && week.inferencePerOrder !== null && prevWeek.inferencePerOrder !== null && prevWeek.inferencePerOrder > 0n && week.inferencePerOrder > prevWeek.inferencePerOrder * 2n) {
    risks.push({ code: "inference_rising", severity: "warn", title: "AI cost per order more than doubled", detail: "Check the inference budget in the policy; the daily cap still applies.", evidence: { this_week: usdc(week.inferencePerOrder), last_week: usdc(prevWeek.inferencePerOrder) } });
  }
  // R6 revenue falling.
  if (prevWeek.orders >= MIN_FORECAST_ORDERS && week.revenue * 2n < prevWeek.revenue) {
    risks.push({ code: "revenue_down", severity: "warn", title: "Revenue halved week on week", detail: "Fewer paid orders this week than last.", evidence: { this_week: usdc(week.revenue), last_week: usdc(prevWeek.revenue) } });
  }
  // R7 margin squeeze -> lean mode (autonomous, spends less).
  if (lean.active) {
    risks.push({ code: "margin_squeeze", severity: "warn", title: "Margins are being squeezed", detail: lean.reason, evidence: { margin_pct: ((week.marginBps ?? 0) / 100).toFixed(1), vendor_spend: usdc(week.vendorSpend), revenue: usdc(week.revenue) } });
    interventions.push({ code: "lean_mode", kind: "autonomous", title: "Lean mode: skip optional datasets", detail: "Single orders are written without buying data until margins recover. Quoted orders and subscriptions keep the scope the customer paid for.", effect: "reduce_spend", evidence: { margin_pct: ((week.marginBps ?? 0) / 100).toFixed(1) } });
    interventions.push({ code: "raise_price", kind: "needs_owner", title: "Consider a higher price floor", detail: "Draft a policy change that raises the minimum price (Rules tab).", where: "rules", effect: "none", evidence: {} });
  }
  // R8 approvals waiting long.
  const stale = input.pendingApprovals.filter((p) => now - p.since > 60 * 60_000);
  if (stale.length) {
    risks.push({ code: "approvals_stale", severity: "warn", title: `${stale.length} purchase approval${stale.length === 1 ? "" : "s"} waiting over an hour`, detail: "Those orders are paused until you approve or reject.", evidence: { orders: stale.map((s) => s.onchainOrderId).join(", ") } });
    interventions.push({ code: "approve_or_raise", kind: "needs_owner", title: "Approve, reject, or raise the threshold", detail: "Decide the waiting purchases (Overview tab), or raise the approval threshold if these are routine.", where: "overview", effect: "none", evidence: {} });
  }

  const status: Health["status"] = risks.some((r) => r.severity === "high") ? "at_risk" : risks.some((r) => r.severity === "warn") ? "watch" : "healthy";
  return { status, week, prevWeek, daily, forecast, runway, obligations, savings, lean, risks, interventions };
}
