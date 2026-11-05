/**
 * GET /api/owner/overview  Business status for the owner console.
 * Read-only and limited to data that is already public on-chain or in the
 * public ledger (no customer briefs, no report content). Every owner ACTION is
 * a wallet-signed transaction, so this route grants no admin power.
 */
import { connection } from "next/server";
import { getConfig, getQuoteRules, getSubscriptionPlans, getTreasury } from "@/lib/server/contract";
import { viewFunction } from "@/lib/server/near-rpc";
import { editableValues } from "@/lib/domain/policy/draft";
import type { PolicyDocument } from "@/lib/domain/policy/schema";
import { promoteAnchoredDraft } from "@/lib/server/business";
import { db } from "@/lib/server/db";
import { openDraft, ownerCommands } from "@/lib/server/policy-builder";
import { treasuryBalances } from "@/lib/server/evm";
import { nearBalance } from "@/lib/server/near-rpc";
import { sepoliaConfig } from "@/lib/server/env";
import { nearConfig } from "@/lib/server/env";
import { fail, json } from "@/lib/server/http";

const sum = (rows: { v: string | null }[] | null) => (rows ?? []).reduce((a, r) => a + BigInt(r.v ?? 0), 0n);

export async function GET() {
  await connection(); // live data: never prerender at build time
  try {
    return await overview();
  } catch (e) {
    // Say what failed instead of an empty 500.
    console.error("owner overview failed", e);
    return fail(500, `Owner overview failed: ${(e as Error).message}`.slice(0, 400));
  }
}

async function overview() {
  const near = nearConfig();
  // Slow chain reads start at once and run in parallel with everything else.
  const pEvmTreasury = treasuryBalances().catch(() => null);
  const pTreasury = getTreasury();
  const pPlans = getSubscriptionPlans();
  const pQuoteRules = getQuoteRules();
  const pChainProducts = viewFunction<[string, { price: string; max_expense: string; active: boolean }][]>(near.contractId, "get_products").catch(() => []);
  const pContractNear = nearBalance(near.contractId);
  // Daily series for the KPI cards: the last 14 days, oldest first.
  const since = new Date(Date.now() - 13 * 86400_000);
  since.setUTCHours(0, 0, 0, 0);
  const pSeries = Promise.all([
    db().from("payments").select("amount_units,verified_at").eq("status", "VERIFIED").gte("verified_at", since.toISOString()),
    db().from("order_transitions").select("at").eq("to_state", "SETTLED").gte("at", since.toISOString()),
    db().from("orders").select("id", { count: "exact", head: true }).eq("state", "SETTLED"),
  ]);
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

  const t = await pEvmTreasury;
  const [onchainTreasury, gasRefills, agentGas] = await Promise.all([
    pTreasury,
    db().from("ledger_entries").select("tx_hash,explorer_url,details,at").eq("event_type", "gas_refilled").order("at", { ascending: false }).limit(5),
    agent.data?.near_account ? nearBalance(agent.data.near_account) : Promise.resolve(null),
  ]);
  const evmVendorPrice = (await db().from("vendors").select("unit_price_units").eq("chain", "sepolia").eq("approved", true).limit(1).maybeSingle()).data?.unit_price_units;
  const evmPrice = evmVendorPrice ? BigInt(evmVendorPrice) : null;
  const business_treasury = onchainTreasury
    ? {
        ...onchainTreasury,
        agentGasYocto: agentGas?.spendable.toString() ?? null,
        refills: gasRefills.data ?? [],
        ethereumShortfall: t && evmPrice && t.usdc < evmPrice ? (evmPrice - t.usdc).toString() : "0",
      }
    : null;
  const treasury = t ? { address: t.address, eth: t.eth.toString(), usdc: t.usdc.toString(), explorerUrl: sepoliaConfig().explorerAddressUrl(t.address) } : null;

  // Subscriptions: what the contract allows, what the owner still has to switch on, and recent ones.
  const [plans, chainProducts, subProduct, subs] = await Promise.all([
    pPlans,
    pChainProducts,
    db().from("products").select("sku,title,price_units,max_expense_units").eq("kind", "subscription").limit(1).maybeSingle(),
    db().from("subscriptions").select("id,onchain_subscription_id,state,issues_total,issues_started,issue_price_units,customer_account,next_due_at,refund_units,refund_status,created_at").neq("state", "AWAITING_PAYMENT").order("created_at", { ascending: false }).limit(8),
  ]);
  const sp = subProduct.data;
  const onchainProduct = sp ? chainProducts.find(([sku]) => sku === sp.sku)?.[1] : undefined;
  const plan = sp ? (plans ?? []).find(([sku]) => sku === sp.sku)?.[1] : undefined;
  const subscriptionSetup = sp
    ? {
        sku: sp.sku,
        title: sp.title,
        contractSupports: plans !== null,
        // The policy must price a product before the agent may deliver it.
        policyAllows: !!activeDoc && activeDoc.rules.pricing.min_price_units[sp.sku] !== undefined,
        product: onchainProduct ? { price: onchainProduct.price, maxExpense: onchainProduct.max_expense, active: onchainProduct.active } : null,
        plan: plan ?? null,
        // Testnet demo pace: one issue an hour, 2 to 8 issues.
        steps: [
          ...(!onchainProduct || onchainProduct.price !== String(sp.price_units) || !onchainProduct.active
            ? [{ label: `List ${sp.title} at ${Number(sp.price_units) / 1e6} USDC an issue`, method: "set_product", args: { sku: sp.sku, price: String(sp.price_units), max_expense: String(sp.max_expense_units), active: true } }]
            : []),
          ...(!plan?.active ? [{ label: "Switch on subscriptions: 2 to 8 issues, one an hour", method: "set_subscription_plan", args: { sku: sp.sku, interval_ns: 3_600_000_000_000, min_issues: 2, max_issues: 8, active: true } }] : []),
        ],
      }
    : null;

  // Custom quotes: the owner's limits in the contract and what is still to switch on.
  const [ruleList, quoteProduct] = await Promise.all([pQuoteRules, db().from("products").select("sku,title,price_units,max_expense_units").eq("kind", "quote").limit(1).maybeSingle()]);
  const qp = quoteProduct.data;
  const qProductOnchain = qp ? chainProducts.find(([sku]) => sku === qp.sku)?.[1] : undefined;
  const qRules = qp ? (ruleList ?? []).find(([sku]) => sku === qp.sku)?.[1] : undefined;
  const QUOTE_RULES = qp ? { sku: qp.sku, min_price: "5000000", max_price: "50000000", max_expense_bps: 6000, max_ttl_ns: 1_800_000_000_000, active: true } : null;
  const quoteSetup = qp
    ? {
        sku: qp.sku,
        title: qp.title,
        contractSupports: ruleList !== null,
        policyAllows: !!activeDoc && activeDoc.rules.pricing.min_price_units[qp.sku] !== undefined,
        rules: qRules ?? null,
        steps: [
          ...(!qProductOnchain || !qProductOnchain.active
            ? [{ label: `List ${qp.title}`, method: "set_product", args: { sku: qp.sku, price: String(qp.price_units), max_expense: String(qp.max_expense_units), active: true } }]
            : []),
          ...(!qRules?.active ? [{ label: "Switch on quotes: 5 to 50 USDC, expenses at most 60% of the price, open 30 minutes", method: "set_quote_rules", args: QUOTE_RULES! }] : []),
        ],
      }
    : null;


  // Low balances that would stall the business during judging.
  const YOCTO = 10n ** 24n;
  const alerts: string[] = [];
  const [agentNear, contractNear] = await Promise.all([agent.data?.near_account ? nearBalance(agent.data.near_account) : null, pContractNear]);
  if (agentNear && agentNear.spendable < YOCTO / 2n) alerts.push(`Agent wallet has ${(Number(agentNear.spendable / 10n ** 21n) / 1000).toFixed(3)} NEAR for gas; top it up above 0.5 NEAR or it cannot call the contract.`);
  if (contractNear && contractNear.spendable < YOCTO) alerts.push(`Business contract has ${(Number(contractNear.spendable / 10n ** 21n) / 1000).toFixed(3)} NEAR free; new orders need storage. Send it at least 1 NEAR.`);
  if (t && t.eth < 10n ** 16n) alerts.push("Ethereum treasury has under 0.01 Sepolia ETH for gas; cross-chain purchases will not broadcast.");
  if (t && evmVendorPrice && t.usdc < BigInt(evmVendorPrice)) alerts.push("Ethereum treasury holds less Sepolia USDC than one dataset costs; cross-chain purchases will fail. Top it up from faucet.circle.com.");

  const [seriesPay, seriesSettled, settledCount] = await pSeries;
  const days = Array.from({ length: 14 }, (_, i) => new Date(since.getTime() + i * 86400_000).toISOString().slice(0, 10));
  const revenueByDay = days.map((d) => (seriesPay.data ?? []).filter((p) => (p.verified_at ?? "").slice(0, 10) === d).reduce((a, p) => a + Number(p.amount_units) / 1e6, 0));
  const settledByDay = days.map((d) => (seriesSettled.data ?? []).filter((t) => t.at.slice(0, 10) === d).length);

  return json({
    kpis: { days, revenueByDay, settledByDay, settledOrders: settledCount.count ?? 0, readAt: new Date().toISOString() },
    alerts,
    refunds,
    businessTreasury: business_treasury,
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
      reserveKept: paid("reserve"),
    },
    subscriptionSetup,
    quoteSetup,
    subscriptions: subs.data ?? [],
    pendingApprovals: pending.data ?? [],
    orders: orders.data ?? [],
    recentActions: actions.data ?? [],
  });
}
