/**
 * Creates the Verified Research Desk business in Supabase and prepares its
 * first policy for on-chain anchoring.
 *
 *   npm run seed                 -> inserts business, config, product, vendor,
 *                                   agent (paused) and policy v1; prints the
 *                                   near-cli command that anchors its hash
 *   npm run seed -- --activate   -> after you ran that command: checks the
 *                                   on-chain hash, activates the policy and
 *                                   sets the agent to running
 *
 * Safe to run twice: it reuses existing rows.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db, must } = await import("../src/lib/server/db");
  const { nearConfig } = await import("../src/lib/server/env");
  const { getConfig } = await import("../src/lib/server/contract");
  const { defaultResearchDeskPolicy } = await import("../src/lib/domain/policy/defaults");
  const { policyHash } = await import("../src/lib/domain/policy/hash");
  const { toUnits } = await import("../src/lib/domain/money");

  const near = nearConfig();
  const agentAccount = process.env.AGENT_ACCOUNT_ID?.trim();
  if (!agentAccount || agentAccount.includes("<")) throw new Error("AGENT_ACCOUNT_ID is not set (run npm run outlayer:register first)");
  const onchain = await getConfig();
  if (onchain.agent !== agentAccount) throw new Error(`Contract agent is ${onchain.agent}, but AGENT_ACCOUNT_ID is ${agentAccount}`);

  const upsertOne = async (table: string, match: Record<string, unknown>, values: Record<string, unknown>) => {
    let q = db().from(table).select("*");
    for (const [k, v] of Object.entries(match)) q = q.eq(k, v as string);
    const found = await q.maybeSingle();
    if (found.error) throw new Error(`${table}: ${found.error.message}`);
    if (found.data) return found.data as Record<string, string>;
    return must(await db().from(table).insert({ ...match, ...values }).select("*").single(), `insert ${table}`) as Record<string, string>;
  };

  const business = await upsertOne("businesses", { contract_id: near.contractId }, { name: "Verified Research Desk", template: "research_desk", status: "active" });
  await upsertOne("business_config", { business_id: business.id }, {
    token_id: near.usdcTokenId,
    owner_payout_account: onchain.owner_payout,
    contributor_account: onchain.contributor,
    agent_account: agentAccount,
    contributor_bps: onchain.contributor_bps,
    purchase_approval_above_units: onchain.purchase_approval_above,
  });
  await upsertOne("products", { business_id: business.id, sku: "weekly-market-brief" }, {
    title: "Weekly Market Brief",
    description: "A short, sourced research brief on the topic you choose, written by the agent with private, attested inference.",
    price_units: toUnits("20").toString(),
    max_expense_units: toUnits("13").toString(),
    active: true,
    onchain_synced: true,
  });
  const vendor = await upsertOne("vendors", { business_id: business.id, near_account: near.vendorAccountId }, {
    name: "Demo Data Vendor",
    category: "dataset",
    sku: "market-dataset",
    unit_price_units: toUnits("12").toString(),
    approved: true,
  });
  const agent = await upsertOne("agents", { business_id: business.id, near_account: agentAccount }, {
    name: "Research Agent",
    role: "research",
    outlayer_wallet_id: process.env.OUTLAYER_WALLET_ID ?? null,
    status: "paused",
  });

  const doc = defaultResearchDeskPolicy({
    businessId: business.id,
    agentId: agent.id,
    tokenId: near.usdcTokenId,
    vendorId: vendor.id,
    vendorAccount: near.vendorAccountId,
    contractAccount: near.contractId,
  });
  const hash = policyHash(doc);
  const existing = await db().from("policies").select("*").eq("business_id", business.id).eq("version", doc.version).maybeSingle();
  if (!existing.data) {
    must(await db().from("policies").insert({
      business_id: business.id,
      version: doc.version,
      source_text: "Do not allow the research agent to spend more than $20 per day on AI inference. Purchases above $10 require my approval. Payments to unapproved wallets must always be blocked.",
      rules: doc.rules,
      rules_hash: hash,
      status: "pending_signature",
    }).select("id").single(), "insert policy");
  } else if (existing.data.rules_hash !== hash) {
    throw new Error("Stored policy v1 differs from the default; refusing to overwrite. Create a new version instead.");
  }

  if (process.argv.includes("--activate")) {
    const live = await getConfig();
    if (live.policy_hash !== hash || live.policy_version !== doc.version) {
      throw new Error(`On-chain policy is v${live.policy_version} ${live.policy_hash ?? "(none)"}; expected v${doc.version} ${hash}. Run the set_policy_hash command first.`);
    }
    must(await db().from("policies").update({ status: "active", signed_by: live.owner, activated_at: new Date().toISOString() }).eq("business_id", business.id).eq("version", doc.version).select("id").single(), "activate policy");
    must(await db().from("businesses").update({ active_policy_version: doc.version }).eq("id", business.id).select("id").single(), "business policy version");
    must(await db().from("agents").update({ status: "running" }).eq("id", agent.id).select("id").single(), "agent running");
    console.log(`\nPolicy v${doc.version} matches the on-chain anchor and is active. Agent is running.\n`);
    return;
  }

  console.log(`\nBusiness "${business.name}" is set up (id ${business.id}). Agent is paused until the policy is anchored.\n`);
  console.log(`Policy v${doc.version} hash: ${hash}\n`);
  console.log("Anchor it on-chain (signed by your owner account):\n");
  console.log(
    `near --% contract call-function as-transaction ${near.contractId} set_policy_hash json-args "{\\"version\\":${doc.version},\\"hash\\":\\"${hash}\\"}" prepaid-gas "30 Tgas" attached-deposit "0 NEAR" sign-as ${near.ownerAccountId} network-config testnet sign-with-keychain send`,
  );
  console.log("\nThen run:  npm run seed -- --activate\n");
}

main().catch((e) => {
  console.error(`Seed failed: ${(e as Error).message}`);
  process.exit(1);
});
