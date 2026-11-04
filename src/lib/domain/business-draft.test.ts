import { describe, expect, it } from "vitest";
import { baselinePolicy, buildBusinessDraft, businessDraftInput } from "./business-draft";
import { policyEditSchema } from "./policy/draft";
import { evaluate } from "./policy/evaluate";
import { policyDocumentSchema } from "./policy/schema";

const form = {
  businessName: "Lagos Price Watch",
  owner: "ada.testnet",
  contributor: "tunde.testnet",
  contributorPercent: 20,
  productTitle: "Weekly food price report",
  productSku: "food-prices",
  price: "15",
  maxExpense: "9",
  vendorName: "Market Data Co",
  vendorChain: "near" as const,
  vendorAccount: "marketdata.testnet",
  vendorPrice: "6",
  rules: "",
};
const ctx = { businessStatus: "active" as const, agentStatus: "running" as const, spentTodayUnits: 0n, spentMonthUnits: 0n, inferenceTodayUsdMicros: 0n, inferenceMonthUsdMicros: 0n };

describe("start-a-business draft", () => {
  it("validates the form", () => {
    expect(businessDraftInput.safeParse(form).success).toBe(true);
    expect(businessDraftInput.safeParse({ ...form, maxExpense: "16" }).success).toBe(false);
    expect(businessDraftInput.safeParse({ ...form, vendorChain: "sepolia" }).success).toBe(false);
    expect(businessDraftInput.safeParse({ ...form, contributor: "ada.testnet" }).success).toBe(false);
  });

  it("defaults the approval threshold to half the spending cap, so it always applies", () => {
    const p = baselinePolicy(businessDraftInput.parse(form));
    expect(p.rules.approvals[0].when.amount_above_units).toBe("4500000");
    expect(BigInt(p.rules.approvals[0].when.amount_above_units!)).toBeLessThan(BigInt(p.rules.procurement.max_per_purchase_units));
  });

  it("builds a valid policy with the same safety rules as the Research Desk", () => {
    const p = baselinePolicy(businessDraftInput.parse(form));
    expect(policyDocumentSchema.parse(p)).toEqual(p);
    expect(p.rules.revenue.contributor_bps).toBe(2000);
    expect(evaluate(p, { tool: "request_purchase", agentId: "agent", orderId: "o", amountUnits: 4_000_000n, tokenId: p.rules.token_id, destination: "marketdata.testnet", vendorId: "vendor-1" }, ctx).outcome).toBe("allow");
    expect(evaluate(p, { tool: "request_purchase", agentId: "agent", orderId: "o", amountUnits: 6_000_000n, tokenId: p.rules.token_id, destination: "marketdata.testnet", vendorId: "vendor-1" }, ctx).outcome).toBe("needs_approval");
    expect(evaluate(p, { tool: "request_purchase", agentId: "agent", orderId: "o", amountUnits: 6_000_000n, tokenId: p.rules.token_id, destination: "mallory.testnet", vendorId: "vendor-1" }, ctx)).toMatchObject({ outcome: "deny", absolute: true });
  });

  it("applies translated rules and lays out a launch checklist with the policy hash", () => {
    const d = buildBusinessDraft(businessDraftInput.parse(form), policyEditSchema.parse({ approval_above_usdc: "5" }));
    expect(d.errors).toEqual([]);
    expect(d.changes.map((c) => c.field)).toEqual(["approval_above_usdc"]);
    expect(d.initArgs.purchase_approval_above).toBe("5000000");
    // Wallet-signable steps carry the call; account creation and deploy do not.
    expect(d.checklist.filter((c) => c.call).map((c) => c.call?.method)).toEqual(["set_product", "set_vendor", "set_policy_hash"]);
    expect(JSON.stringify(d.checklist)).not.toMatch(/audited/i);
    expect(d.contractId).toBe("food-prices.ada.testnet");
    expect(d.checklist.at(-1)?.command).toContain(d.policyHash);
    expect(d.policy.version).toBe(1);
  });

  it("supports a vendor paid on Ethereum", () => {
    const d = buildBusinessDraft(businessDraftInput.parse({ ...form, vendorChain: "sepolia", vendorAccount: "0x8FCF5415CC8c338D4523Be5a04bb758B5437810f" }), null);
    expect(d.policy.rules.crosschain?.approved_vendors).toEqual(["0x8fcf5415cc8c338d4523be5a04bb758b5437810f"]);
    expect(d.checklist.some((s) => s.command?.includes("set_evm_vendor"))).toBe(true);
  });
});
