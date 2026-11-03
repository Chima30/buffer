import { toUnits } from "../money";
import type { PolicyDocument } from "./schema";

/**
 * Starting policy for the Verified Research Desk demo. Mirrors the owner's
 * example rule: "Do not allow the research agent to spend more than $20 per day
 * on AI inference. Purchases above $10 require my approval. Payments to
 * unapproved wallets must always be blocked."
 */
export function defaultResearchDeskPolicy(params: {
  businessId: string;
  agentId: string;
  tokenId: string;
  vendorId: string;
  vendorAccount: string;
  contractAccount: string;
}): PolicyDocument {
  return {
    version: 1,
    business_id: params.businessId,
    rules: {
      emergency: { shutdown: false },
      token_id: params.tokenId,
      limits: {
        per_transaction_units: toUnits("25").toString(),
        daily_units: toUnits("50").toString(),
        monthly_units: toUnits("500").toString(),
      },
      inference: {
        daily_usd_micros: toUnits("20").toString(),
        monthly_usd_micros: toUnits("200").toString(),
      },
      procurement: {
        max_per_purchase_units: toUnits("25").toString(),
        approved_vendor_ids: [params.vendorId],
      },
      destinations: { allowlist: [params.vendorAccount, params.contractAccount] },
      pricing: { min_price_units: { "weekly-market-brief": toUnits("20").toString() } },
      revenue: { basis: "net", contributor_bps: 3000 },
      agent_permissions: {
        [params.agentId]: [
          "get_vendor_catalog",
          "run_inference",
          "request_purchase",
          "deliver_report",
          "request_settlement",
        ],
      },
      approvals: [
        {
          id: "A-1",
          description: "Purchases above 10 USDC require owner approval",
          when: { tools: ["request_purchase"], amount_above_units: toUnits("10").toString() },
        },
      ],
      prohibitions: [
        {
          id: "P-1",
          description: "Payments to unapproved wallets are always blocked",
          when: { tools: ["request_purchase"], destination_not_in_allowlist: true },
        },
      ],
    },
  };
}
