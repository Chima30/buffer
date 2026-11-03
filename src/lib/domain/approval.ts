/**
 * Approvals are bound to the exact action. The owner signs a NEP-413 message
 * containing `actionHash`; before execution the executor recomputes the hash
 * from the stored action and re-evaluates policy. Any difference voids it.
 */

import { hashCanonical } from "./canonical";
import { evaluate, type Decision, type EvaluationContext, type ProposedAction } from "./policy/evaluate";
import type { PolicyDocument } from "./policy/schema";

export interface ApprovalBinding {
  action: ProposedAction;
  policyVersion: number;
  nonce: string;
  expiresAt: string; // ISO timestamp
}

export function actionHash(binding: ApprovalBinding): string {
  return hashCanonical({
    domain: "buffer.approval.v1",
    action: binding.action,
    policy_version: binding.policyVersion,
    nonce: binding.nonce,
    expires_at: binding.expiresAt,
  });
}

/** The exact message text the owner's wallet signs (NEP-413 `message`). */
export function approvalMessage(hash: string): string {
  return `Buffer approval\naction_hash:${hash}`;
}

export interface StoredApproval {
  binding: ApprovalBinding;
  actionHash: string;
  status: "pending" | "approved" | "rejected" | "expired" | "void";
  signerAccount: string | null;
  signatureVerified: boolean;
}

export type ExecutionCheck =
  | { ok: true; decision: Decision }
  | { ok: false; code: string; message: string; decision?: Decision };

/**
 * Called immediately before signing/submitting an approved action.
 * `ownerAccounts` is the set of accounts allowed to approve.
 */
export function checkApprovedForExecution(params: {
  approval: StoredApproval;
  actionToExecute: ProposedAction;
  currentPolicy: PolicyDocument;
  ctx: EvaluationContext;
  ownerAccounts: ReadonlySet<string>;
  now: Date;
}): ExecutionCheck {
  const { approval, actionToExecute, currentPolicy, ctx, ownerAccounts, now } = params;

  if (approval.status !== "approved") {
    return { ok: false, code: "NOT_APPROVED", message: `Approval status is ${approval.status}` };
  }
  if (!approval.signatureVerified || !approval.signerAccount || !ownerAccounts.has(approval.signerAccount)) {
    return { ok: false, code: "BAD_SIGNER", message: "Approval was not signed by an authorised owner" };
  }
  if (new Date(approval.binding.expiresAt).getTime() <= now.getTime()) {
    return { ok: false, code: "EXPIRED", message: "Approval has expired" };
  }
  if (actionHash(approval.binding) !== approval.actionHash) {
    return { ok: false, code: "HASH_MISMATCH", message: "Stored approval does not match its hash" };
  }
  const rebound = { ...approval.binding, action: actionToExecute };
  if (actionHash(rebound) !== approval.actionHash) {
    return { ok: false, code: "ACTION_CHANGED", message: "Action differs from what was approved" };
  }
  if (currentPolicy.version !== approval.binding.policyVersion) {
    return { ok: false, code: "POLICY_CHANGED", message: "Policy changed since approval; re-approval required" };
  }
  const decision = evaluate(currentPolicy, actionToExecute, ctx);
  if (decision.outcome === "deny") {
    return { ok: false, code: "DENIED_ON_REVALIDATION", message: "Policy now denies this action", decision };
  }
  return { ok: true, decision };
}
