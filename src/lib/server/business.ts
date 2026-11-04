/**
 * Loads everything the runtime needs about the business and refuses to act if
 * the active policy does not match the hash anchored on-chain.
 */
import { approvalThresholdUnits } from "@/lib/domain/policy/draft";
import { assertPolicyAnchored } from "@/lib/domain/policy/hash";
import { policyDocumentSchema, type PolicyDocument } from "@/lib/domain/policy/schema";
import type { EvaluationContext } from "@/lib/domain/policy/evaluate";
import { getConfig, type OnchainConfig } from "./contract";
import { db, must } from "./db";
import { nearConfig } from "./env";

export interface BusinessContext {
  business: { id: string; name: string; contract_id: string; status: "active" | "paused" };
  agent: { id: string; near_account: string; status: "running" | "paused" | "frozen" };
  product: { id: string; sku: string; title: string; description: string | null; price_units: string; max_expense_units: string };
  vendor: { id: string; name: string; near_account: string; sku: string; unit_price_units: string };
  policy: PolicyDocument;
  contributorBps: number;
}

export async function loadBusiness(): Promise<BusinessContext> {
  const { contractId } = nearConfig();
  const business = must(await db().from("businesses").select("id,name,contract_id,status").eq("contract_id", contractId).single(), "business");
  const agent = must(await db().from("agents").select("id,near_account,status").eq("business_id", business.id).limit(1).single(), "agent");
  const product = must(
    await db().from("products").select("id,sku,title,description,price_units,max_expense_units").eq("business_id", business.id).eq("active", true).limit(1).single(),
    "product",
  );
  const vendor = must(await db().from("vendors").select("id,name,near_account,sku,unit_price_units").eq("business_id", business.id).eq("approved", true).limit(1).single(), "vendor");
  const policyRow = must(await db().from("policies").select("rules,version,business_id").eq("business_id", business.id).eq("status", "active").single(), "active policy");
  const cfg = must(await db().from("business_config").select("contributor_bps").eq("business_id", business.id).single(), "business config");
  const policy = policyDocumentSchema.parse({ version: policyRow.version, business_id: policyRow.business_id, rules: policyRow.rules });
  return { business, agent, product, vendor, policy, contributorBps: cfg.contributor_bps };
}

/** The runtime calls this before every effectful step. */
export async function loadBusinessAnchored(): Promise<BusinessContext> {
  let ctx = await loadBusiness();
  const onchain = await getConfig();
  // The owner may have just anchored a new policy draft: follow the chain.
  if (onchain.policy_version > ctx.policy.version && (await promoteAnchoredDraft(ctx.business.id, onchain)) !== null) ctx = await loadBusiness();
  if (onchain.paused) throw new HaltError("Business contract is paused");
  // Frozen or paused agents wait; their orders resume when the owner lifts it.
  if (ctx.agent.status !== "running") throw new HaltError(`Agent is ${ctx.agent.status}`);
  if (ctx.business.status !== "active") throw new HaltError("Business is paused");
  try {
    assertPolicyAnchored(ctx.policy, onchain.policy_hash);
  } catch (e) {
    throw new HaltError((e as Error).message);
  }
  if (onchain.policy_version !== ctx.policy.version) throw new HaltError("Policy version on-chain differs from the active policy");
  // The contract enforces the approval threshold itself; both must agree.
  if (BigInt(onchain.purchase_approval_above) !== approvalThresholdUnits(ctx.policy)) {
    throw new HaltError("The contract's approval threshold differs from the policy; the owner must set it on-chain");
  }
  return ctx;
}

export class HaltError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HaltError";
  }
}

const startOfDay = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};
const startOfMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
};

const sum = (rows: { v: string | number | null }[] | null) => (rows ?? []).reduce((a, r) => a + BigInt(r.v ?? 0), 0n);

/** Spend counters for the policy engine, from confirmed records only. */
export async function evaluationContext(ctx: BusinessContext): Promise<EvaluationContext> {
  const spentStates = ["approved", "submitted", "confirmed", "awaiting_approval"];
  const [pd, pm, idy, imo] = await Promise.all([
    db().from("procurements").select("v:amount_units").in("status", spentStates).gte("created_at", startOfDay()),
    db().from("procurements").select("v:amount_units").in("status", spentStates).gte("created_at", startOfMonth()),
    db().from("inference_calls").select("v:cost_usd_micros").gte("created_at", startOfDay()),
    db().from("inference_calls").select("v:cost_usd_micros").gte("created_at", startOfMonth()),
  ]);
  return {
    businessStatus: ctx.business.status,
    agentStatus: ctx.agent.status,
    spentTodayUnits: sum(pd.data as { v: string }[] | null),
    spentMonthUnits: sum(pm.data as { v: string }[] | null),
    inferenceTodayUsdMicros: sum(idy.data as { v: string }[] | null),
    inferenceMonthUsdMicros: sum(imo.data as { v: string }[] | null),
  };
}

/**
 * If the owner anchored a draft's hash on-chain, make that draft the active
 * policy. Safe to call any time: it only follows what the contract already says.
 */
export async function promoteAnchoredDraft(businessId: string, onchain: OnchainConfig, txHash?: string): Promise<number | null> {
  if (!onchain.policy_hash) return null;
  const draft = await db().from("policies").select("id,version").eq("business_id", businessId).eq("version", onchain.policy_version).eq("rules_hash", onchain.policy_hash).in("status", ["draft", "pending_signature"]).maybeSingle();
  if (!draft.data) return null;
  const now = new Date().toISOString();
  must(await db().from("policies").update({ status: "superseded" }).eq("business_id", businessId).eq("status", "active").select("id"), "supersede old policy");
  must(await db().from("policies").update({ status: "active", signed_by: onchain.owner, activated_at: now, onchain_tx: txHash ?? null }).eq("id", draft.data.id).select("id").single(), "activate policy");
  must(await db().from("businesses").update({ active_policy_version: draft.data.version }).eq("id", businessId).select("id").single(), "business policy version");
  return draft.data.version;
}
