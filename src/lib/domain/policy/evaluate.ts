/**
 * Deterministic policy evaluation. Pure function: same inputs, same decision.
 * No AI, no I/O. Every proposed agent action passes through here before any
 * executor may act, and again immediately before execution.
 *
 * Order: emergency -> status -> prohibitions -> permissions -> allowlists ->
 *        limits/budgets -> min price -> approval rules -> allow.
 * A prohibition returns "deny" and can never be turned into "needs_approval".
 */

import type { MatchCondition, PolicyDocument, ToolName } from "./schema";

export interface ProposedAction {
  tool: ToolName;
  agentId: string;
  orderId: string | null;
  /** Token amount in smallest units (procurement, transfers). */
  amountUnits?: bigint;
  tokenId?: string;
  /** NEAR account that would receive funds. */
  destination?: string;
  vendorId?: string;
  /** Estimated inference cost in micro-USD. */
  inferenceUsdMicros?: bigint;
  /** Sale price checks. */
  sku?: string;
  priceUnits?: bigint;
}

export interface EvaluationContext {
  businessStatus: "active" | "paused";
  agentStatus: "running" | "paused" | "frozen";
  spentTodayUnits: bigint;
  spentMonthUnits: bigint;
  inferenceTodayUsdMicros: bigint;
  inferenceMonthUsdMicros: bigint;
}

export type Outcome = "allow" | "deny" | "needs_approval";

export interface Reason {
  code: string;
  ruleId?: string;
  message: string;
}

export interface Decision {
  outcome: Outcome;
  reasons: Reason[];
  policyVersion: number;
  absolute: boolean;
}

const MOVES_FUNDS: ReadonlySet<ToolName> = new Set(["request_purchase"]);

function deny(policy: PolicyDocument, reason: Reason, absolute = false): Decision {
  return { outcome: "deny", reasons: [reason], policyVersion: policy.version, absolute };
}

function matches(
  when: MatchCondition,
  action: ProposedAction,
  allowlist: ReadonlySet<string>,
): boolean {
  // Every specified field must match (AND). An empty condition matches nothing,
  // so a malformed rule can never silently apply to everything.
  let specified = 0;
  if (when.tools) {
    specified++;
    if (!when.tools.includes(action.tool)) return false;
  }
  if (when.agent_ids) {
    specified++;
    if (!when.agent_ids.includes(action.agentId)) return false;
  }
  if (when.amount_above_units !== undefined) {
    specified++;
    if (action.amountUnits === undefined || action.amountUnits <= BigInt(when.amount_above_units)) return false;
  }
  if (when.destination_not_in_allowlist) {
    specified++;
    if (action.destination === undefined || allowlist.has(action.destination)) return false;
  }
  if (when.destinations) {
    specified++;
    if (action.destination === undefined || !when.destinations.includes(action.destination)) return false;
  }
  return specified > 0;
}

export function evaluate(
  policy: PolicyDocument,
  action: ProposedAction,
  ctx: EvaluationContext,
): Decision {
  const r = policy.rules;
  const allowlist = new Set(r.destinations.allowlist);

  // 1. Emergency and operational status.
  if (r.emergency.shutdown) {
    return deny(policy, { code: "EMERGENCY_SHUTDOWN", message: "Emergency shutdown is active" }, true);
  }
  if (ctx.businessStatus !== "active") {
    return deny(policy, { code: "BUSINESS_PAUSED", message: "Business is paused" }, true);
  }
  if (ctx.agentStatus !== "running") {
    return deny(policy, { code: "AGENT_NOT_RUNNING", message: `Agent is ${ctx.agentStatus}` }, true);
  }

  // 2. Absolute prohibitions.
  for (const p of r.prohibitions) {
    if (matches(p.when, action, allowlist)) {
      return deny(policy, { code: "PROHIBITED", ruleId: p.id, message: p.description }, true);
    }
  }

  // 3. Agent permissions.
  const permitted = r.agent_permissions[action.agentId] ?? [];
  if (!permitted.includes(action.tool)) {
    return deny(policy, {
      code: "TOOL_NOT_PERMITTED",
      message: `Agent ${action.agentId} is not permitted to use ${action.tool}`,
    });
  }

  const reasons: Reason[] = [];

  // 4. Fund-moving checks.
  if (MOVES_FUNDS.has(action.tool)) {
    if (action.amountUnits === undefined || action.amountUnits <= 0n) {
      return deny(policy, { code: "MISSING_AMOUNT", message: "Fund-moving action has no positive amount" });
    }
    if (action.tokenId !== r.token_id) {
      return deny(policy, {
        code: "TOKEN_NOT_ALLOWED",
        message: `Token ${action.tokenId ?? "(none)"} is not the business token`,
      });
    }
    if (!action.destination || !allowlist.has(action.destination)) {
      return deny(
        policy,
        { code: "DESTINATION_NOT_ALLOWED", message: `Destination ${action.destination ?? "(none)"} is not on the allowlist` },
        true,
      );
    }
    if (action.tool === "request_purchase") {
      if (!action.vendorId || !r.procurement.approved_vendor_ids.includes(action.vendorId)) {
        return deny(policy, { code: "VENDOR_NOT_APPROVED", message: `Vendor ${action.vendorId ?? "(none)"} is not approved` });
      }
      if (action.amountUnits > BigInt(r.procurement.max_per_purchase_units)) {
        return deny(policy, { code: "PROCUREMENT_MAX", message: "Purchase exceeds the maximum procurement amount" });
      }
    }
    if (action.amountUnits > BigInt(r.limits.per_transaction_units)) {
      return deny(policy, { code: "PER_TX_LIMIT", message: "Amount exceeds the per-transaction limit" });
    }
    if (ctx.spentTodayUnits + action.amountUnits > BigInt(r.limits.daily_units)) {
      return deny(policy, { code: "DAILY_LIMIT", message: "Amount would exceed the daily spending limit" });
    }
    if (ctx.spentMonthUnits + action.amountUnits > BigInt(r.limits.monthly_units)) {
      return deny(policy, { code: "MONTHLY_LIMIT", message: "Amount would exceed the monthly spending limit" });
    }
    reasons.push({ code: "WITHIN_LIMITS", message: "Within allowlist and spending limits" });
  }

  // 5. Inference budget.
  if (action.tool === "run_inference") {
    const est = action.inferenceUsdMicros ?? 0n;
    if (ctx.inferenceTodayUsdMicros + est > BigInt(r.inference.daily_usd_micros)) {
      return deny(policy, { code: "INFERENCE_DAILY_BUDGET", message: "Inference would exceed the daily budget" });
    }
    if (ctx.inferenceMonthUsdMicros + est > BigInt(r.inference.monthly_usd_micros)) {
      return deny(policy, { code: "INFERENCE_MONTHLY_BUDGET", message: "Inference would exceed the monthly budget" });
    }
    reasons.push({ code: "WITHIN_BUDGET", message: "Within inference budget" });
  }

  // 6. Minimum price (applies wherever a sale price is part of the action).
  if (action.sku !== undefined && action.priceUnits !== undefined) {
    const min = r.pricing.min_price_units[action.sku];
    if (min === undefined) {
      return deny(policy, { code: "UNKNOWN_SKU", message: `No minimum price configured for ${action.sku}` });
    }
    if (action.priceUnits < BigInt(min)) {
      return deny(policy, { code: "BELOW_MIN_PRICE", message: "Price is below the minimum selling price" });
    }
  }

  // 7. Approval rules.
  const approvalHits = r.approvals.filter((a) => matches(a.when, action, allowlist));
  if (approvalHits.length > 0) {
    return {
      outcome: "needs_approval",
      reasons: [
        ...reasons,
        ...approvalHits.map((a) => ({ code: "APPROVAL_REQUIRED", ruleId: a.id, message: a.description })),
      ],
      policyVersion: policy.version,
      absolute: false,
    };
  }

  return {
    outcome: "allow",
    reasons: reasons.length ? reasons : [{ code: "ALLOWED", message: "Permitted by policy" }],
    policyVersion: policy.version,
    absolute: false,
  };
}
