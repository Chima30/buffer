import type { ToolName } from "./policy/schema";

export const ORDER_STATES = [
  "CREATED",
  "AWAITING_PAYMENT",
  "PAID",
  "PLANNING",
  "PROCURING",
  "AWAITING_APPROVAL",
  "DRAFTING",
  "DELIVERED",
  "SETTLING",
  "SETTLED",
  "REFUND_PENDING",
  "REFUNDED",
  "FAILED",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  CREATED: ["AWAITING_PAYMENT", "FAILED"],
  AWAITING_PAYMENT: ["PAID", "FAILED"],
  PAID: ["PLANNING", "REFUND_PENDING"],
  PLANNING: ["PROCURING", "DRAFTING", "REFUND_PENDING"],
  PROCURING: ["AWAITING_APPROVAL", "DRAFTING", "REFUND_PENDING"],
  AWAITING_APPROVAL: ["PROCURING", "DRAFTING", "REFUND_PENDING"],
  DRAFTING: ["DELIVERED", "REFUND_PENDING"],
  DELIVERED: ["SETTLING"],
  SETTLING: ["SETTLED", "SETTLING"],
  SETTLED: [],
  REFUND_PENDING: ["REFUNDED"],
  REFUNDED: [],
  FAILED: [],
};

/** Tools are only available in specific states — the agent cannot buy while drafting. */
const TOOLS_BY_STATE: Partial<Record<OrderState, readonly ToolName[]>> = {
  PLANNING: ["get_vendor_catalog", "run_inference"],
  PROCURING: ["request_purchase"],
  DRAFTING: ["run_inference", "deliver_report"],
  DELIVERED: ["request_settlement"],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) throw new Error(`Illegal order transition ${from} -> ${to}`);
}

export function toolsAvailable(state: OrderState): readonly ToolName[] {
  return TOOLS_BY_STATE[state] ?? [];
}

export function isTerminal(state: OrderState): boolean {
  return TRANSITIONS[state].length === 0;
}
