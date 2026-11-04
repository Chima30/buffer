/**
 * GET /api/owner/overview  Business status for the owner console.
 * Read-only and limited to data that is already public on-chain or in the
 * public ledger (no customer briefs, no report content). Every owner ACTION is
 * a wallet-signed transaction, so this route grants no admin power.
 */
import { connection } from "next/server";
import { getConfig } from "@/lib/server/contract";
import { editableValues } from "@/lib/domain/policy/draft";
import type { PolicyDocument } from "@/lib/domain/policy/schema";
import { promoteAnchoredDraft } from "@/lib/server/business";
import { db } from "@/lib/server/db";
import { openDraft, ownerCommands } from "@/lib/server/policy-builder";
import { treasuryBalances } from "@/lib/server/evm";
import { nearBalance } from "@/lib/server/near-rpc";
import { sepoliaConfig } from "@/lib/server/env";
import { nearConfig } from "@/lib/server/env";
import { json } from "@/lib/server/http";

const sum = (rows: { v: string | null }[] | null) => (rows ?? []).reduce((a, r) => a + BigInt(r.v ?? 0), 0n);

export async function GET() {
  await connection(); // live data: never prerender at build time
  const near = nearConfig();
  // Catch up if the owner anchored a draft since the last view.
  const biz0 = await db().from("businesses").select("id").eq("contract_id", near.contractId).maybeSingle();
  if (biz0.data) await promoteAnchoredDraft(biz0.data.id, await getConfig());
  const [onchain, business, agent, policy, payments, vendorSpend, inferenceSpend, payouts, pending, orders, actions] = await Promise.all([
    getConfig(),
    db().from("businesses").select("id,name,status").eq("contract_id", near.contractId).single(),
    db().from("agents").select("id,name,role,near_account,status,outlayer_wallet_id").limit(1).single(),
    db().from("policies").select("version,rules,rules_hash,business_id,source_text,activated_at").eq("status", "active").maybeSingle(),
    db().from("payments").select("v:amount_units").eq("status", "VERIFIED"),
    db().from("procurements").select("v:amount_units").eq("status", "confirmed"),
    db().from("inference_calls").select("v:cost_usd_micros").not("order_id", "is", null),
    db().from("distributions").select("leg,amount_units,status"),
    db().from("procurements").select("id,amount_units,onchain_index,created_at,chain,orders!inner(onchain_order_id,state),vendors!inner(name,near_account,evm_address)").eq("status", "awaiting_approval"),
    db().from("orders").select("id,onchain_order_id,state,price_units,created_at,updated_at").order("created_at", { ascending: false }).limit(10),
    db().from("agent_actions").select("tool,decision,reasons,policy_version,at").order("at", { ascending: false }).limit(12),
  ]);

  const paid = (leg: string) => (payouts.data ?? []).filter((d) => d.leg === leg && d.status === "CONFIRMED").reduce((a, d) => a + BigInt(d.amount_units), 0n);
  const revenue = sum(payments.data as { v: string }[] | null);
  const vendor = sum(vendorSpend.data as { v: string }[] | null);
  const inference = sum(inferenceSpend.data as { v: string }[] | null);

  const activeDoc = policy.data ? ({ version: policy.data.version, business_id: policy.data.business_id, rules: policy.data.rules } as PolicyDocument) : null;
  const draft = business.data ? await openDraft(business.data.id, onchain) : null;
  // Owner transactions still needed: the open draft's, or a contract value that lags the active policy.
  const pendingPolicy = draft ?? (activeDoc && policy.data ? (() => {
    const commands = ownerCommands(activeDoc, policy.data.rules_hash, onchain);
    return commands.length ? { version: activeDoc.version, hash: policy.data.rules_hash, sourceText: policy.data.source_text, createdAt: policy.data.activated_at, commands } : null;
  })() : null);

  // Orders the owner can still refund, with the NEAR vendor spend a full refund must top up.
  const REFUNDABLE = ["PAID", "PLANNING", "PROCURING", "AWAITING_APPROVAL", "DRAFTING", "DELIVERED", "REFUND_PENDING"];
  const refundable = (orders.data ?? []).filter((o) => REFUNDABLE.includes(o.state));
  const spent = refundable.length
    ? ((await db().from("procurements").select("order_id,amount_units").in("order_id", refundable.map((o) => o.id)).eq("chain", "near").eq("status", "confirmed")).data ?? [])
    : [];
  const refunds = refundable.map((o) => ({
    id: o.id,
    onchain_order_id: o.onchain_order_id,
    state: o.state,
    price_units: o.price_units,
    topUpUnits: spent.filter((p) => p.order_id === o.id).reduce((a, p) => a + BigInt(p.amount_units), 0n).toString(),
  }));

  const t = await treasuryBalances().catch(() => null);
  const treasury = t ? { address: t.address, eth: t.eth.toString(), usdc: t.usdc.toString(), explorerUrl: sepoliaConfig().explorerAddressUrl(t.address) } : null;

  // Low balances that would stall the business during judging.
  const YOCTO = 10n ** 24n;
  const alerts: string[] = [];
  const [agentNear, contractNear] = await Promise.all([agent.data?.near_account ? nearBalance(agent.data.near_account) : null, nearBalance(near.contractId)]);
  if (agentNear && agentNear.spendable < YOCTO / 2n) alerts.push(`Agent wallet has ${(Number(agentNear.spendable / 10n ** 21n) / 1000).toFixed(3)} NEAR for gas; top it up above 0.5 NEAR or it cannot call the contract.`);
  if (contractNear && contractNear.spendable < YOCTO) alerts.push(`Business contract has ${(Number(contractNear.spendable / 10n ** 21n) / 1000).toFixed(3)} NEAR free; new orders need storage. Send it at least 1 NEAR.`);
  if (t && t.eth < 10n ** 16n) alerts.push("Ethereum treasury has under 0.01 Sepolia ETH for gas; cross-chain purchases will not broadcast.");
  const evmVendorPrice = (await db().from("vendors").select("unit_price_units").eq("chain", "sepolia").eq("approved", true).limit(1).maybeSingle()).data?.unit_price_units;
  if (t && evmVendorPrice && t.usdc < BigInt(evmVendorPrice)) alerts.push("Ethereum treasury holds less Sepolia USDC than one dataset costs; cross-chain purchases will fail. Top it up from faucet.circle.com.");

  return json({
    alerts,
    refunds,
    treasury,
    tokenId: near.usdcTokenId,
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
    policy: policy.data ? { version: policy.data.version, rules_hash: policy.data.rules_hash, source_text: policy.data.source_text, activated_at: policy.data.activated_at, values: activeDoc ? editableValues(activeDoc) : null } : null,
    pendingPolicy,
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
