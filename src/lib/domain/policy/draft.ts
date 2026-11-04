/**
 * Natural-language policy builder, deterministic half.
 *
 * The AI only translates the owner's English into a small, strict "edit" of
 * named numeric fields. Everything else is plain code: applying the edit,
 * checking safety invariants, describing the change, and computing the hash
 * the owner signs. The AI cannot add vendors, wallets, tools or permissions,
 * and cannot touch the prohibitions, because the edit has no field for them.
 */
import { z } from "zod";
import { formatUnits, toUnits } from "../money";
import type { PolicyDocument } from "./schema";
import { policyDocumentSchema } from "./schema";

const decimal = z.string().regex(/^\d{1,9}(\.\d{1,6})?$/, "must be a plain decimal amount");

export const EDITABLE = {
  per_transaction_usdc: "Maximum per transaction",
  daily_spend_usdc: "Daily spending limit",
  monthly_spend_usdc: "Monthly spending limit",
  max_per_purchase_usdc: "Maximum per vendor purchase",
  approval_above_usdc: "Owner approval needed above",
  inference_daily_usd: "Daily AI inference budget",
  inference_monthly_usd: "Monthly AI inference budget",
} as const;
export type EditableField = keyof typeof EDITABLE;

export const policyEditSchema = z
  .object({
    per_transaction_usdc: decimal.optional(),
    daily_spend_usdc: decimal.optional(),
    monthly_spend_usdc: decimal.optional(),
    max_per_purchase_usdc: decimal.optional(),
    approval_above_usdc: decimal.optional(),
    inference_daily_usd: decimal.optional(),
    inference_monthly_usd: decimal.optional(),
    /** Requests the builder cannot express, in the owner's words. */
    unsupported: z.array(z.string().max(300)).max(10).default([]),
  })
  .strict();
export type PolicyEdit = z.infer<typeof policyEditSchema>;

/** Current values of the editable fields, as decimal strings. */
export function editableValues(doc: PolicyDocument): Record<EditableField, string> {
  const r = doc.rules;
  const f = (u: string) => formatUnits(BigInt(u), 6, 0);
  return {
    per_transaction_usdc: f(r.limits.per_transaction_units),
    daily_spend_usdc: f(r.limits.daily_units),
    monthly_spend_usdc: f(r.limits.monthly_units),
    max_per_purchase_usdc: f(r.procurement.max_per_purchase_units),
    approval_above_usdc: f(approvalThresholdUnits(doc).toString()),
    inference_daily_usd: f(r.inference.daily_usd_micros),
    inference_monthly_usd: f(r.inference.monthly_usd_micros),
  };
}

/** The purchase-approval threshold (rule A-1). The contract must hold the same value. */
export function approvalThresholdUnits(doc: PolicyDocument): bigint {
  const a = doc.rules.approvals.find((x) => x.id === "A-1");
  if (!a?.when.amount_above_units) throw new Error("Policy has no A-1 approval threshold");
  return BigInt(a.when.amount_above_units);
}

export function applyEdit(current: PolicyDocument, edit: PolicyEdit): PolicyDocument {
  const next: PolicyDocument = structuredClone(current);
  next.version = current.version + 1;
  const r = next.rules;
  const u = (v: string) => toUnits(v).toString();
  if (edit.per_transaction_usdc) r.limits.per_transaction_units = u(edit.per_transaction_usdc);
  if (edit.daily_spend_usdc) r.limits.daily_units = u(edit.daily_spend_usdc);
  if (edit.monthly_spend_usdc) r.limits.monthly_units = u(edit.monthly_spend_usdc);
  if (edit.max_per_purchase_usdc) r.procurement.max_per_purchase_units = u(edit.max_per_purchase_usdc);
  if (edit.inference_daily_usd) r.inference.daily_usd_micros = u(edit.inference_daily_usd);
  if (edit.inference_monthly_usd) r.inference.monthly_usd_micros = u(edit.inference_monthly_usd);
  if (edit.approval_above_usdc) {
    const a = r.approvals.find((x) => x.id === "A-1");
    if (!a) throw new Error("Policy has no A-1 approval rule");
    a.when.amount_above_units = u(edit.approval_above_usdc);
    a.description = `Purchases above ${formatUnits(BigInt(a.when.amount_above_units), 6, 0)} USDC require owner approval`;
  }
  return policyDocumentSchema.parse(next);
}

export interface Change {
  field: EditableField;
  label: string;
  from: string;
  to: string;
}

export function describeChanges(current: PolicyDocument, next: PolicyDocument): Change[] {
  const a = editableValues(current);
  const b = editableValues(next);
  return (Object.keys(EDITABLE) as EditableField[]).filter((k) => a[k] !== b[k]).map((k) => ({ field: k, label: EDITABLE[k], from: a[k], to: b[k] }));
}

export interface Lint {
  errors: string[];
  warnings: string[];
}

/** Invariants a new policy must keep. Errors block signing; warnings are shown. */
export function lintPolicy(current: PolicyDocument, next: PolicyDocument, maxExpenseUnits: bigint): Lint {
  const errors: string[] = [];
  const warnings: string[] = [];
  const r = next.rules;
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

  // Structural parts the builder must never change.
  if (!same(r.prohibitions, current.rules.prohibitions)) errors.push("Prohibitions changed. The builder may not edit them.");
  if (!same(r.destinations, current.rules.destinations)) errors.push("Payment allowlist changed. The builder may not edit it.");
  if (!same(r.agent_permissions, current.rules.agent_permissions)) errors.push("Agent permissions changed. The builder may not edit them.");
  if (!same(r.procurement.approved_vendor_ids, current.rules.procurement.approved_vendor_ids)) errors.push("Approved vendors changed. The builder may not edit them.");
  if (!r.prohibitions.some((p) => p.when.destination_not_in_allowlist)) errors.push("The block on payments to unapproved wallets is missing.");

  const n = (s: string) => BigInt(s);
  const perTx = n(r.limits.per_transaction_units);
  const daily = n(r.limits.daily_units);
  const monthly = n(r.limits.monthly_units);
  if (perTx > daily) errors.push("Maximum per transaction is above the daily limit.");
  if (daily > monthly) errors.push("Daily spending limit is above the monthly limit.");
  if (n(r.inference.daily_usd_micros) > n(r.inference.monthly_usd_micros)) errors.push("Daily inference budget is above the monthly budget.");
  if (n(r.inference.daily_usd_micros) === 0n) warnings.push("Inference budget is 0: the agent will not be able to write reports.");

  const maxPurchase = n(r.procurement.max_per_purchase_units);
  const threshold = approvalThresholdUnits(next);
  if (maxPurchase > perTx) warnings.push("Maximum per vendor purchase is above the per-transaction limit, so the per-transaction limit applies.");
  if (maxPurchase > maxExpenseUnits) warnings.push(`The contract caps vendor spend at ${formatUnits(maxExpenseUnits)} USDC per order, so purchases above that are refused on-chain anyway.`);
  if (threshold >= maxPurchase) warnings.push("The approval threshold is at or above the maximum purchase, so no purchase will ever need your approval.");

  if (next.version !== current.version + 1) errors.push("Version must increase by exactly one.");
  return { errors, warnings };
}
