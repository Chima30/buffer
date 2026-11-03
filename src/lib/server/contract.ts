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
  legs: { kind: "Owner" | "Contributor" | "ReimbOwner" | "Refund"; recipient: string; amount: string; status: "Pending" | "Confirmed" | "Failed"; attempts: number }[];
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
