/**
 * Buffer revenue engine — formula version 2 ("net distributable, vendors paid from escrow").
 * Mirrors `compute_split` in contract/src/lib.rs exactly.
 *
 *   V  = supplier expenses with status PAID: vendor purchases the contract already
 *        paid out of the order's escrow (on-chain, so always <= product.maxExpense)
 *   I  = inference expenses with status METERED (chat id evidence)
 *   PENDING blocks settlement; REJECTED / evidence-less are never counted.
 *   E  = min(V + I, product.maxExpense, G)
 *   Eu = (V + I) - E    (over-cap inference: absorbed by the owner, flagged)
 *   D  = G - E          (distributable)
 *   C  = floor(D * contributorBps / 10000)
 *   O  = D - C          (owner receives rounding dust)
 *   reimbOwner = E - V  (inference credits the owner prepaid)
 *
 * Invariant: V + reimbOwner + C + O === G.
 *
 * "treasury" expenses (PAID) are cross-chain vendor payments made from the
 * owner-funded Ethereum treasury through Chain Signatures. Like inference they are
 * reimbursed to the owner inside the cap, exactly as the contract's settle does.
 * The agent never holds funds: vendors are paid by the contract, not reimbursed.
 */

import { minUnits, sumUnits, type Units } from "./money";

export const FORMULA_VERSION = 2;
export const BPS_DENOMINATOR = 10_000n;

export type ExpenseCategory = "supplier" | "inference" | "treasury";
export type ExpenseStatus = "PAID" | "METERED" | "PENDING" | "REJECTED";

export interface ExpenseInput {
  id: string;
  category: ExpenseCategory;
  amount: Units;
  status: ExpenseStatus;
  evidenceRef: string | null;
}

export interface SettlementInput {
  gross: Units;
  maxExpense: Units;
  contributorBps: number;
  expenses: ExpenseInput[];
}

/** Legs the contract pays at settlement. Vendor payments already happened during the order. */
export type PayoutLeg = "owner" | "contributor" | "reimb_owner";

export interface SettlementResult {
  formulaVersion: number;
  gross: Units;
  paidToVendors: Units;
  expensesCounted: Units;
  expensesUncounted: Units;
  distributable: Units;
  contributorShare: Units;
  ownerShare: Units;
  reimbOwner: Units;
  legs: { leg: PayoutLeg; amount: Units }[];
  excludedExpenseIds: string[];
  overCap: boolean;
}

export class SettlementBlockedError extends Error {
  constructor(public readonly pendingExpenseIds: string[]) {
    super(`Settlement blocked: ${pendingExpenseIds.length} expense(s) still pending`);
    this.name = "SettlementBlockedError";
  }
}

function assertBps(bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error(`contributorBps must be an integer between 0 and 10000, got ${bps}`);
  }
  return BigInt(bps);
}

export function computeSettlement(input: SettlementInput): SettlementResult {
  const { gross, maxExpense } = input;
  if (gross <= 0n) throw new Error("Gross must be positive to settle");
  if (maxExpense < 0n) throw new Error("maxExpense cannot be negative");
  const bps = assertBps(input.contributorBps);

  const pending = input.expenses.filter((e) => e.status === "PENDING");
  if (pending.length > 0) throw new SettlementBlockedError(pending.map((e) => e.id));

  const excluded: string[] = [];
  const hasEvidence = (e: ExpenseInput) => e.evidenceRef !== null && e.evidenceRef !== "";
  for (const e of input.expenses) if (e.amount < 0n) throw new Error(`Expense ${e.id} has a negative amount`);

  const vendor = input.expenses.filter((e) => {
    const ok = e.category === "supplier" && e.status === "PAID" && hasEvidence(e);
    if (e.category === "supplier" && !ok) excluded.push(e.id);
    return ok;
  });
  const inference = input.expenses.filter((e) => {
    const ok = e.category === "inference" && e.status === "METERED" && hasEvidence(e);
    if (e.category === "inference" && !ok) excluded.push(e.id);
    return ok;
  });

  const treasury = input.expenses.filter((e) => {
    const ok = e.category === "treasury" && e.status === "PAID" && hasEvidence(e);
    if (e.category === "treasury" && !ok) excluded.push(e.id);
    return ok;
  });

  const paidToVendors = sumUnits(vendor.map((e) => e.amount));
  if (paidToVendors > maxExpense || paidToVendors > gross) {
    throw new Error("Vendor payments exceed the expense cap; the contract would never allow this");
  }
  const claimed = paidToVendors + sumUnits(inference.map((e) => e.amount)) + sumUnits(treasury.map((e) => e.amount));
  const expenses = minUnits(claimed, maxExpense, gross);
  const uncounted = claimed - expenses;
  const distributable = gross - expenses;
  const contributorShare = (distributable * bps) / BPS_DENOMINATOR;
  const ownerShare = distributable - contributorShare;
  const reimbOwner = expenses - paidToVendors;

  const total = paidToVendors + reimbOwner + contributorShare + ownerShare;
  if (total !== gross) throw new Error(`Invariant violated: parts sum to ${total}, gross is ${gross}`);

  const legs = (
    [
      { leg: "owner", amount: ownerShare },
      { leg: "contributor", amount: contributorShare },
      { leg: "reimb_owner", amount: reimbOwner },
    ] as { leg: PayoutLeg; amount: Units }[]
  ).filter((l) => l.amount > 0n);

  return {
    formulaVersion: FORMULA_VERSION,
    gross,
    paidToVendors,
    expensesCounted: expenses,
    expensesUncounted: uncounted,
    distributable,
    contributorShare,
    ownerShare,
    reimbOwner,
    legs,
    excludedExpenseIds: excluded,
    overCap: uncounted > 0n,
  };
}

/**
 * Refund policy: the customer is made whole (full gross). The contract can only
 * refund what the order still holds in escrow (gross minus vendor payments), so
 * the owner tops up the vendor spend first. Inference already spent is the
 * owner's loss too. The contributor receives nothing: there is no revenue.
 */
export interface RefundResult {
  refundToCustomer: Units;
  escrowAvailable: Units;
  ownerTopUpRequired: Units;
  unrecoveredLoss: Units;
}

export function computeRefund(gross: Units, expenses: ExpenseInput[]): RefundResult {
  if (gross < 0n) throw new Error("Gross cannot be negative");
  const vendorPaid = sumUnits(expenses.filter((e) => e.category === "supplier" && e.status === "PAID").map((e) => e.amount));
  const inferenceSpent = sumUnits(expenses.filter((e) => e.category === "inference" && e.status === "METERED").map((e) => e.amount));
  return {
    refundToCustomer: gross,
    escrowAvailable: gross - vendorPaid,
    ownerTopUpRequired: vendorPaid,
    unrecoveredLoss: vendorPaid + inferenceSpent,
  };
}
