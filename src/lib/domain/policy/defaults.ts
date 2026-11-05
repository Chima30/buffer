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

/**
 * Policy v3: the same rules plus cross-chain purchases through Chain Signatures.
 * Adds the tool to the agent, the EVM vendor allowlist, and extends the approval
 * rule A-1 and the prohibition P-1 to cross-chain purchases. Everything else is kept.
 */
export function withCrosschain(current: PolicyDocument, params: { agentId: string; vendorId: string; chainId: number; token: string; evmVendor: string; sku?: string; minPriceUnits?: string }): PolicyDocument {
  const next: PolicyDocument = structuredClone(current);
  next.version = current.version + 1;
  const r = next.rules;
  const tools = r.agent_permissions[params.agentId] ?? [];
  if (!tools.includes("request_crosschain_purchase")) tools.push("request_crosschain_purchase");
  r.agent_permissions[params.agentId] = tools;
  if (!r.procurement.approved_vendor_ids.includes(params.vendorId)) r.procurement.approved_vendor_ids.push(params.vendorId);
  if (params.sku && params.minPriceUnits) r.pricing.min_price_units[params.sku] = params.minPriceUnits;
  r.crosschain = { chain_id: params.chainId, token: params.token.toLowerCase(), approved_vendors: [params.evmVendor.toLowerCase()] };
  for (const rule of [...r.approvals, ...r.prohibitions]) {
    if (rule.when.tools?.includes("request_purchase") && !rule.when.tools.includes("request_crosschain_purchase")) rule.when.tools.push("request_crosschain_purchase");
  }
  return next;
}

/**
 * Next policy version allowing purchases on more EVM chains: each chain's USDC,
 * its approved vendor addresses, and the vendor rows those purchases come from.
 * Returns the rules unchanged (same version) when nothing is new.
 */
export function withMoreChains(current: PolicyDocument, chains: { chainId: number; token: string; vendor: string; vendorId: string }[]): PolicyDocument {
  const next: PolicyDocument = structuredClone(current);
  const r = next.rules;
  let changed = false;
  for (const c of chains) {
    const list = (r.crosschain_chains ??= []);
    const token = c.token.toLowerCase();
    const vendor = c.vendor.toLowerCase();
    let entry = list.find((x) => x.chain_id === c.chainId);
    if (!entry) {
      entry = { chain_id: c.chainId, token, approved_vendors: [] };
      list.push(entry);
      changed = true;
    }
    if (!entry.approved_vendors.includes(vendor)) {
      entry.approved_vendors.push(vendor);
      changed = true;
    }
    if (!r.procurement.approved_vendor_ids.includes(c.vendorId)) {
      r.procurement.approved_vendor_ids.push(c.vendorId);
      changed = true;
    }
  }
  if (!changed) return current;
  next.version = current.version + 1;
  return next;
}
