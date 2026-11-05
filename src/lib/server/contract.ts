/**
 * Read-only access to the buffer-desk contract, plus helpers that turn a
 * transaction into verified facts. On-chain state is the source of truth for
 * money: the database records what the chain confirmed, never the reverse.
 */
import { nearConfig } from "./env";
import { parseEvents, verifyTransaction, viewFunction } from "./near-rpc";

export type PurchaseStatus = "AwaitingApproval" | "Sending" | "Paid" | "Failed" | "Rejected";
export type OrderStateOnchain = "Paid" | "Fulfilled" | "Settling" | "Settled" | "Refunding" | "Refunded";

export interface OnchainOrder {
  sku: string;
  customer: string;
  gross: string;
  state: OrderStateOnchain;
  report_hash: string | null;
  purchases: { vendor: string; amount: string; memo: string; status: PurchaseStatus }[];
  refund_top_up: string;
  expenses_counted: string;
  legs: { kind: "Owner" | "Contributor" | "ReimbOwner" | "Refund" | "Reserve"; recipient: string; amount: string; status: "Pending" | "Confirmed" | "Failed"; attempts: number }[];
}

export interface OnchainConfig {
  owner: string;
  agent: string;
  token_id: string;
  owner_payout: string;
  contributor: string;
  contributor_bps: number;
  purchase_approval_above: string;
  paused: boolean;
  policy_version: number;
  policy_hash: string | null;
}

export interface OnchainTreasury {
  reserve_bps: number;
  reserve_target: string;
  reserve_balance: string;
  gas_reserve: string;
  gas_refill_amount: string;
  gas_week_cap: string;
  gas_week_start_ns: number;
  gas_spent_week: string;
}

/** Null before the treasury upgrade is deployed. */
export async function getTreasury(): Promise<OnchainTreasury | null> {
  return viewFunction<OnchainTreasury>(nearConfig().contractId, "get_treasury").catch(() => null);
}

export interface OnchainSubscription {
  sku: string;
  customer: string;
  issue_price: string;
  issues_total: number;
  issues_started: number;
  interval_ns: number;
  created_ns: number;
  next_due_ns: number;
  escrow: string;
  state: "Active" | "Completed" | "Cancelled";
  refund: { recipient: string; amount: string; status: "Pending" | "Confirmed" | "Failed"; attempts: number } | null;
}

/** Null if the subscription does not exist (or the upgrade is not deployed yet). */
export async function getSubscription(subscriptionId: string): Promise<OnchainSubscription | null> {
  return viewFunction<OnchainSubscription | null>(nearConfig().contractId, "get_subscription", { subscription_id: subscriptionId }).catch(() => null);
}

export async function getSubscriptionPlans(): Promise<[string, { interval_ns: number; min_issues: number; max_issues: number; active: boolean }][] | null> {
  return viewFunction<[string, { interval_ns: number; min_issues: number; max_issues: number; active: boolean }][]>(nearConfig().contractId, "get_subscription_plans").catch(() => null);
}

export interface OnchainQuoteRules { min_price: string; max_price: string; max_expense_bps: number; max_ttl_ns: number; active: boolean }

/** Null before the quotes upgrade is deployed. */
export async function getQuoteRules(): Promise<[string, OnchainQuoteRules][] | null> {
  return viewFunction<[string, OnchainQuoteRules][]>(nearConfig().contractId, "get_quote_rules").catch(() => null);
}

export async function getQuote(orderId: string): Promise<{ sku: string; amount: string; max_expense: string; expires_ns: number; paid: boolean } | null> {
  return viewFunction<{ sku: string; amount: string; max_expense: string; expires_ns: number; paid: boolean } | null>(nearConfig().contractId, "get_quote", { order_id: orderId }).catch(() => null);
}

export async function getOrder(orderId: string): Promise<OnchainOrder | null> {
  return viewFunction<OnchainOrder | null>(nearConfig().contractId, "get_order", { order_id: orderId });
}

export async function getConfig(): Promise<OnchainConfig> {
  return viewFunction<OnchainConfig>(nearConfig().contractId, "get_config");
}

export interface BufferEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Buffer contract events from a confirmed transaction. */
export async function bufferEventsFromTx(txHash: string, sender: string): Promise<
  { state: "SUCCESS"; events: BufferEvent[] } | { state: "FAILED"; reason: string } | { state: "PENDING" }
> {
  const v = await verifyTransaction(txHash, sender);
  if (v.state !== "SUCCESS") return v;
  const events = parseEvents(v.logs)
    .filter((e) => e.standard === "buffer")
    .map((e) => ({ event: e.event, data: (Array.isArray(e.data) ? e.data[0] : e.data) as Record<string, unknown> }));
  return { state: "SUCCESS", events };
}
