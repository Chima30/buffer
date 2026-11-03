import { describe, expect, it } from "vitest";
import { actionHash, checkApprovedForExecution, type StoredApproval } from "./approval";
import { toUnits } from "./money";
import { defaultResearchDeskPolicy } from "./policy/defaults";
import type { EvaluationContext, ProposedAction } from "./policy/evaluate";
import { assertTransition, canTransition, toolsAvailable } from "./order-machine";
import { validateLedgerEntry } from "./ledger";

const TOKEN = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const policy = defaultResearchDeskPolicy({
  businessId: "biz-1", agentId: "agent-1", tokenId: TOKEN, vendorId: "vendor-1",
  vendorAccount: "buffer-vendor.testnet", contractAccount: "buffer-desk.testnet",
});
const ctx: EvaluationContext = {
  businessStatus: "active", agentStatus: "running", spentTodayUnits: 0n, spentMonthUnits: 0n,
  inferenceTodayUsdMicros: 0n, inferenceMonthUsdMicros: 0n,
};
const action: ProposedAction = {
  tool: "request_purchase", agentId: "agent-1", orderId: "o-1", amountUnits: toUnits("12"),
  tokenId: TOKEN, destination: "buffer-vendor.testnet", vendorId: "vendor-1",
};
const now = new Date("2026-11-10T12:00:00Z");
const binding = { action, policyVersion: 1, nonce: "n-1", expiresAt: "2026-11-10T12:30:00Z" };
const approved = (over: Partial<StoredApproval> = {}): StoredApproval => ({
  binding, actionHash: actionHash(binding), status: "approved", signerAccount: "owner.testnet", signatureVerified: true, ...over,
});
const owners = new Set(["owner.testnet"]);
const run = (a: StoredApproval, act: ProposedAction = action, p = policy, t = now) =>
  checkApprovedForExecution({ approval: a, actionToExecute: act, currentPolicy: p, ctx, ownerAccounts: owners, now: t });

describe("approval binding", () => {
  it("passes for the exact approved action", () => {
    expect(run(approved()).ok).toBe(true);
  });
  it("rejects a changed amount or destination", () => {
    expect(run(approved(), { ...action, amountUnits: toUnits("13") })).toMatchObject({ ok: false, code: "ACTION_CHANGED" });
    expect(run(approved(), { ...action, destination: "x.testnet" })).toMatchObject({ ok: false, code: "ACTION_CHANGED" });
  });
  it("rejects pending, unsigned, foreign-signed and expired approvals", () => {
    expect(run(approved({ status: "pending" }))).toMatchObject({ code: "NOT_APPROVED" });
    expect(run(approved({ signatureVerified: false }))).toMatchObject({ code: "BAD_SIGNER" });
    expect(run(approved({ signerAccount: "agent.testnet" }))).toMatchObject({ code: "BAD_SIGNER" });
    expect(run(approved(), action, policy, new Date("2026-11-10T13:00:00Z"))).toMatchObject({ code: "EXPIRED" });
  });
  it("is void after a policy version change", () => {
    expect(run(approved(), action, { ...policy, version: 2 })).toMatchObject({ code: "POLICY_CHANGED" });
  });
  it("re-evaluates policy before execution", () => {
    const shut = structuredClone(policy);
    shut.rules.emergency.shutdown = true;
    expect(run(approved(), action, shut)).toMatchObject({ code: "DENIED_ON_REVALIDATION" });
  });
});

describe("order state machine", () => {
  it("permits the happy path and refuses skips", () => {
    expect(canTransition("PAID", "PLANNING")).toBe(true);
    expect(() => assertTransition("PAID", "SETTLED")).toThrow();
    expect(() => assertTransition("SETTLED", "SETTLING")).toThrow();
  });
  it("exposes tools only in their states", () => {
    expect(toolsAvailable("DRAFTING")).not.toContain("request_purchase");
    expect(toolsAvailable("PROCURING")).toEqual(["request_purchase"]);
    expect(toolsAvailable("SETTLED")).toEqual([]);
  });
});

describe("ledger validation", () => {
  it("forbids tx hashes on QUOTE/SIMULATED and requires verification for REAL", () => {
    expect(() => validateLedgerEntry({ eventType: "x", status: "SIMULATED", txHash: "abc" })).toThrow();
    expect(() => validateLedgerEntry({ eventType: "x", status: "REAL", txHash: "abc" })).toThrow();
    expect(() => validateLedgerEntry({ eventType: "x", status: "REAL", txHash: "abc", verifiedOnChain: true })).not.toThrow();
  });
});
