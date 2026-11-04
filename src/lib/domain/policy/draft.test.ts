import { describe, expect, it } from "vitest";
import { toUnits } from "../money";
import { defaultResearchDeskPolicy } from "./defaults";
import { applyEdit, approvalThresholdUnits, describeChanges, editableValues, lintPolicy, policyEditSchema } from "./draft";
import { policyHash } from "./hash";

const current = defaultResearchDeskPolicy({
  businessId: "biz-1",
  agentId: "agent-1",
  tokenId: "usdc",
  vendorId: "vendor-1",
  vendorAccount: "buffer-vendor.testnet",
  contractAccount: "buffer-desk.testnet",
});
const CAP = toUnits("13");

describe("policy builder (deterministic half)", () => {
  it("reads the editable values", () => {
    expect(editableValues(current)).toMatchObject({ approval_above_usdc: "10", inference_daily_usd: "20", daily_spend_usdc: "50" });
  });

  it("applies an edit, bumps the version and changes the hash", () => {
    const next = applyEdit(current, policyEditSchema.parse({ approval_above_usdc: "5", inference_daily_usd: "10" }));
    expect(next.version).toBe(2);
    expect(approvalThresholdUnits(next)).toBe(toUnits("5"));
    expect(next.rules.approvals[0].description).toBe("Purchases above 5 USDC require owner approval");
    expect(policyHash(next)).not.toBe(policyHash(current));
    expect(describeChanges(current, next)).toEqual([
      { field: "approval_above_usdc", label: "Owner approval needed above", from: "10", to: "5" },
      { field: "inference_daily_usd", label: "Daily AI inference budget", from: "20", to: "10" },
    ]);
    expect(lintPolicy(current, next, CAP).errors).toEqual([]);
    // The original is untouched.
    expect(approvalThresholdUnits(current)).toBe(toUnits("10"));
  });

  it("has no field for wallets, vendors, permissions or prohibitions", () => {
    expect(policyEditSchema.safeParse({ allowlist: ["attacker.testnet"] }).success).toBe(false);
    expect(policyEditSchema.safeParse({ prohibitions: [] }).success).toBe(false);
    expect(policyEditSchema.safeParse({ approval_above_usdc: "-1" }).success).toBe(false);
    expect(policyEditSchema.safeParse({ approval_above_usdc: "1e9" }).success).toBe(false);
  });

  it("rejects inconsistent limits", () => {
    const next = applyEdit(current, policyEditSchema.parse({ per_transaction_usdc: "100", daily_spend_usdc: "60" }));
    expect(lintPolicy(current, next, CAP).errors).toContain("Maximum per transaction is above the daily limit.");
  });

  it("flags tampering with the structural parts", () => {
    const next = applyEdit(current, policyEditSchema.parse({}));
    next.rules.destinations.allowlist.push("attacker.testnet");
    next.rules.prohibitions = [];
    const { errors } = lintPolicy(current, next, CAP);
    expect(errors).toContain("Payment allowlist changed. The builder may not edit it.");
    expect(errors).toContain("The block on payments to unapproved wallets is missing.");
  });

  it("warns when no purchase would ever need approval", () => {
    const next = applyEdit(current, policyEditSchema.parse({ approval_above_usdc: "30" }));
    expect(lintPolicy(current, next, CAP).warnings.some((w) => w.includes("no purchase will ever need your approval"))).toBe(true);
  });
});
