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

describe("cross-chain purchases (policy v3)", async () => {
  const { withCrosschain } = await import("./defaults");
  const SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
  const EVM_VENDOR = "0x8fcf5415cc8c338d4523be5a04bb758b5437810f";
  const v3 = withCrosschain(policy, { agentId: "agent-1", vendorId: "vendor-evm", chainId: 11155111, token: SEPOLIA_USDC, evmVendor: EVM_VENDOR });
  const x = (over: Partial<ProposedAction> = {}): ProposedAction => ({
    tool: "request_crosschain_purchase",
    agentId: "agent-1",
    orderId: "o-1",
    amountUnits: toUnits("12"),
    tokenId: SEPOLIA_USDC,
    destination: "0x8FCF5415CC8c338D4523Be5a04bb758B5437810f",
    vendorId: "vendor-evm",
    ...over,
  });

  it("v2 hash is unchanged by the optional schema field", () => {
    expect(policyDocumentSchema.parse(policy)).toEqual(policy);
  });
  it("needs approval above 10 USDC, like NEAR purchases", () => {
    const d = evaluate(v3, x(), ctx);
    expect(d.outcome).toBe("needs_approval");
    expect(d.reasons.map((r) => r.ruleId)).toContain("A-1");
  });
  it("allows a small purchase to the approved address (any case)", () => {
    expect(evaluate(v3, x({ amountUnits: toUnits("5") }), ctx).outcome).toBe("allow");
  });
  it("blocks an attacker address absolutely", () => {
    const d = evaluate(v3, x({ destination: "0x00000000000000000000000000000000000000ee" }), ctx);
    expect(d).toMatchObject({ outcome: "deny", absolute: true });
  });
  it("blocks the NEAR token for a cross-chain purchase", () => {
    expect(evaluate(v3, x({ tokenId: TOKEN }), ctx).reasons[0].code).toBe("TOKEN_NOT_ALLOWED");
  });
  it("is not permitted under v2", () => {
    expect(evaluate(policy, x(), ctx).reasons[0].code).toBe("TOOL_NOT_PERMITTED");
  });
  it("hashes differently from v2", () => {
    expect(policyHash(v3)).not.toBe(policyHash(policy));
  });
});

describe("more EVM chains (policy v6)", async () => {
  const { withCrosschain, withMoreChains } = await import("./defaults");
  const SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
  const BASE_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
  const VENDOR = "0x8fcf5415cc8c338d4523be5a04bb758b5437810f";
  const v3 = withCrosschain(policy, { agentId: "agent-1", vendorId: "vendor-evm", chainId: 11155111, token: SEPOLIA_USDC, evmVendor: VENDOR });
  const v6 = withMoreChains(v3, [{ chainId: 84532, token: BASE_USDC, vendor: VENDOR, vendorId: "vendor-base" }]);
  const base = (over: Partial<ProposedAction> = {}): ProposedAction => ({
    tool: "request_crosschain_purchase",
    agentId: "agent-1",
    orderId: "o-1",
    amountUnits: toUnits("5"),
    tokenId: BASE_USDC,
    destination: VENDOR,
    vendorId: "vendor-base",
    chainId: 84532,
    ...over,
  });

  it("allows the approved vendor on Base in Base USDC", () => {
    expect(evaluate(v6, base(), ctx).outcome).toBe("allow");
  });
  it("refuses Sepolia USDC on Base", () => {
    expect(evaluate(v6, base({ tokenId: SEPOLIA_USDC }), ctx).reasons[0].code).toBe("TOKEN_NOT_ALLOWED");
  });
  it("refuses a chain the policy does not list", () => {
    expect(evaluate(v6, base({ chainId: 421614 }), ctx).reasons[0].code).toBe("CHAIN_NOT_ALLOWED");
  });
  it("refuses Base under v3", () => {
    expect(evaluate(v3, base(), ctx).reasons[0].code).toBe("CHAIN_NOT_ALLOWED");
  });
  it("keeps the original chain working without a chain id", () => {
    expect(evaluate(v6, base({ chainId: undefined, tokenId: SEPOLIA_USDC, vendorId: "vendor-evm" }), ctx).outcome).toBe("allow");
  });
  it("is idempotent", () => {
    expect(withMoreChains(v6, [{ chainId: 84532, token: BASE_USDC, vendor: VENDOR, vendorId: "vendor-base" }]).rules).toEqual(v6.rules);
  });
});
