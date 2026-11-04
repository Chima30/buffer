/**
 * GET /api/owner/overview  Business status for the owner console.
 * Read-only and limited to data that is already public on-chain or in the
 * public ledger (no customer briefs, no report content). Every owner ACTION is
 * a wallet-signed transaction, so this route grants no admin power.
 */
import { connection } from "next/server";
import { getConfig } from "@/lib/server/contract";
import { db } from "@/lib/server/db";
import { nearConfig } from "@/lib/server/env";
import { json } from "@/lib/server/http";

const sum = (rows: { v: string | null }[] | null) => (rows ?? []).reduce((a, r) => a + BigInt(r.v ?? 0), 0n);

export async function GET() {
  await connection(); // live data: never prerender at build time
  const near = nearConfig();
  const [onchain, business, agent, policy, payments, vendorSpend, inferenceSpend, payouts, pending, orders, actions] = await Promise.all([
    getConfig(),
    db().from("businesses").select("id,name,status").eq("contract_id", near.contractId).single(),
    db().from("agents").select("id,name,role,near_account,status,outlayer_wallet_id").limit(1).single(),
    db().from("policies").select("version,rules_hash,source_text,activated_at").eq("status", "active").maybeSingle(),
    db().from("payments").select("v:amount_units").eq("status", "VERIFIED"),
    db().from("procurements").select("v:amount_units").eq("status", "confirmed"),
    db().from("inference_calls").select("v:cost_usd_micros").not("order_id", "is", null),
    db().from("distributions").select("leg,amount_units,status"),
    db().from("procurements").select("id,amount_units,onchain_index,created_at,orders!inner(onchain_order_id,state),vendors!inner(name,near_account)").eq("status", "awaiting_approval"),
    db().from("orders").select("id,onchain_order_id,state,price_units,created_at,updated_at").order("created_at", { ascending: false }).limit(10),
    db().from("agent_actions").select("tool,decision,reasons,policy_version,at").order("at", { ascending: false }).limit(12),
  ]);

  const paid = (leg: string) => (payouts.data ?? []).filter((d) => d.leg === leg && d.status === "CONFIRMED").reduce((a, d) => a + BigInt(d.amount_units), 0n);
  const revenue = sum(payments.data as { v: string }[] | null);
  const vendor = sum(vendorSpend.data as { v: string }[] | null);
  const inference = sum(inferenceSpend.data as { v: string }[] | null);

  return json({
    business: business.data,
    contract: {
      id: near.contractId,
      paused: onchain.paused,
      owner: onchain.owner,
      policyVersion: onchain.policy_version,
      policyHash: onchain.policy_hash,
      approvalAboveUnits: onchain.purchase_approval_above,
      contributor: onchain.contributor,
      contributorBps: onchain.contributor_bps,
    },
    policy: policy.data,
    policyAnchored: !!policy.data && policy.data.rules_hash === onchain.policy_hash && policy.data.version === onchain.policy_version,
    agent: agent.data ? { ...agent.data, walletPubkey: agent.data.near_account ? `ed25519:${agent.data.near_account}` : null } : null,
    totals: {
      revenue,
      vendorSpend: vendor,
      inferenceSpend: inference,
      net: revenue - vendor - inference,
      ownerPaid: paid("owner") + paid("reimb_owner"),
      contributorPaid: paid("contributor"),
    },
    pendingApprovals: pending.data ?? [],
    orders: orders.data ?? [],
    recentActions: actions.data ?? [],
  });
}
