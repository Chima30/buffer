import { describe, expect, it } from "vitest";
import { toUnits } from "../money";
import { defaultResearchDeskPolicy } from "./defaults";
import { evaluate, type EvaluationContext, type ProposedAction } from "./evaluate";
import { policyHash, assertPolicyAnchored } from "./hash";
import { policyDocumentSchema, type PolicyDocument } from "./schema";

const TOKEN = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const policy = defaultResearchDeskPolicy({
  businessId: "biz-1",
  agentId: "agent-1",
  tokenId: TOKEN,
  vendorId: "vendor-1",
  vendorAccount: "buffer-vendor.testnet",
  contractAccount: "buffer-desk.testnet",
});

const ctx: EvaluationContext = {
  businessStatus: "active",
  agentStatus: "running",
  spentTodayUnits: 0n,
  spentMonthUnits: 0n,
  inferenceTodayUsdMicros: 0n,
  inferenceMonthUsdMicros: 0n,
};

const purchase = (over: Partial<ProposedAction> = {}): ProposedAction => ({
  tool: "request_purchase",
  agentId: "agent-1",
  orderId: "o-1",
  amountUnits: toUnits("5"),
  tokenId: TOKEN,
  destination: "buffer-vendor.testnet",
  vendorId: "vendor-1",
  ...over,
});

const withRules = (patch: (p: PolicyDocument) => void): PolicyDocument => {
  const copy = structuredClone(policy);
  patch(copy);
  return copy;
};

describe("policy schema", () => {
  it("accepts the default policy", () => {
    expect(() => policyDocumentSchema.parse(policy)).not.toThrow();
  });
  it("rejects unknown fields", () => {
    expect(() => policyDocumentSchema.parse({ ...policy, extra: true })).toThrow();
  });
});

describe("evaluate", () => {
  it("allows a small purchase from an approved vendor", () => {
    expect(evaluate(policy, purchase(), ctx).outcome).toBe("allow");
  });

  it("requires approval above 10 USDC", () => {
    const d = evaluate(policy, purchase({ amountUnits: toUnits("12") }), ctx);
    expect(d.outcome).toBe("needs_approval");
    expect(d.reasons.some((r) => r.ruleId === "A-1")).toBe(true);
  });

  it("does not require approval at exactly 10 USDC", () => {
    expect(evaluate(policy, purchase({ amountUnits: toUnits("10") }), ctx).outcome).toBe("allow");
  });

  it("blocks unapproved destinations absolutely", () => {
    const d = evaluate(policy, purchase({ destination: "attacker.testnet", amountUnits: toUnits("50") }), ctx);
    expect(d.outcome).toBe("deny");
    expect(d.absolute).toBe(true);
    expect(d.reasons[0].ruleId).toBe("P-1");
  });

  it("blocks unapproved vendors", () => {
    expect(evaluate(policy, purchase({ vendorId: "vendor-x" }), ctx).reasons[0].code).toBe("VENDOR_NOT_APPROVED");
  });

  it("blocks the wrong token", () => {
    expect(evaluate(policy, purchase({ tokenId: "usdc.fakes.testnet" }), ctx).reasons[0].code).toBe("TOKEN_NOT_ALLOWED");
  });

  it("enforces per-transaction, daily and monthly limits", () => {
    expect(evaluate(policy, purchase({ amountUnits: toUnits("26") }), ctx).outcome).toBe("deny");
    expect(evaluate(policy, purchase(), { ...ctx, spentTodayUnits: toUnits("46") }).reasons[0].code).toBe("DAILY_LIMIT");
    expect(evaluate(policy, purchase(), { ...ctx, spentMonthUnits: toUnits("496") }).reasons[0].code).toBe("MONTHLY_LIMIT");
  });

  it("enforces the inference budget", () => {
    const a: ProposedAction = { tool: "run_inference", agentId: "agent-1", orderId: "o-1", inferenceUsdMicros: toUnits("1") };
    expect(evaluate(policy, a, ctx).outcome).toBe("allow");
    expect(evaluate(policy, a, { ...ctx, inferenceTodayUsdMicros: toUnits("19.5") }).reasons[0].code).toBe("INFERENCE_DAILY_BUDGET");
  });

  it("denies tools the agent is not permitted to use", () => {
    const p = withRules((d) => (d.rules.agent_permissions["agent-1"] = ["run_inference"]));
    expect(evaluate(p, purchase(), ctx).reasons[0].code).toBe("TOOL_NOT_PERMITTED");
    expect(evaluate(policy, purchase({ agentId: "rogue" }), ctx).reasons[0].code).toBe("TOOL_NOT_PERMITTED");
  });

  it("emergency shutdown and pauses override everything", () => {
    const p = withRules((d) => (d.rules.emergency.shutdown = true));
    expect(evaluate(p, purchase(), ctx).reasons[0].code).toBe("EMERGENCY_SHUTDOWN");
    expect(evaluate(policy, purchase(), { ...ctx, businessStatus: "paused" }).outcome).toBe("deny");
    expect(evaluate(policy, purchase(), { ...ctx, agentStatus: "frozen" }).outcome).toBe("deny");
  });

  it("prohibitions win over approval rules", () => {
    const p = withRules((d) => {
      d.rules.prohibitions.push({ id: "P-2", description: "No purchases over 20", when: { tools: ["request_purchase"], amount_above_units: toUnits("20").toString() } });
    });
    const d = evaluate(p, purchase({ amountUnits: toUnits("21") }), ctx);
    expect(d.outcome).toBe("deny");
    expect(d.absolute).toBe(true);
  });

  it("an empty match condition never applies", () => {
    const p = withRules((d) => d.rules.prohibitions.push({ id: "P-9", description: "bad rule", when: {} }));
    expect(evaluate(p, purchase(), ctx).outcome).toBe("allow");
  });

  it("enforces minimum price", () => {
    const sale: ProposedAction = { tool: "deliver_report", agentId: "agent-1", orderId: "o-1", sku: "weekly-market-brief", priceUnits: toUnits("19") };
    expect(evaluate(policy, sale, ctx).reasons[0].code).toBe("BELOW_MIN_PRICE");
    expect(evaluate(policy, { ...sale, priceUnits: toUnits("20") }, ctx).outcome).toBe("allow");
  });
});

describe("policy hash", () => {
  it("is stable regardless of key order", () => {
    const reordered = JSON.parse(JSON.stringify({ rules: policy.rules, business_id: policy.business_id, version: policy.version }));
    expect(policyHash(reordered)).toBe(policyHash(policy));
  });
  it("changes when a rule changes and anchoring detects it", () => {
    const changed = withRules((d) => (d.rules.limits.daily_units = toUnits("500").toString()));
    expect(policyHash(changed)).not.toBe(policyHash(policy));
    expect(() => assertPolicyAnchored(changed, policyHash(policy))).toThrow(/mismatch/);
    expect(() => assertPolicyAnchored(policy, policyHash(policy))).not.toThrow();
    expect(() => assertPolicyAnchored(policy, null)).toThrow();
  });
});
