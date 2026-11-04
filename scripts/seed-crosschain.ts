/**
 * Sets up the second product, whose dataset vendor is paid on Ethereum Sepolia
 * through Chain Signatures. Run after the 20261104020000_crosschain.sql migration.
 *
 *   npm run seed:crosschain -- 0xVendorAddress   -> adds the vendor and product (inactive),
 *                                                   saves policy v3 as a draft and prints
 *                                                   the owner commands to run
 *   npm run seed:crosschain -- --activate         -> after those commands: checks the chain,
 *                                                   then lists the product in the store
 * Signs nothing and holds no keys.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const SKU = "crosschain-brief";
const PRICE = "20000000";
const MAX_EXPENSE = "13000000";
const VENDOR_PRICE = "12000000";

async function main() {
  const { db, must } = await import("../src/lib/server/db");
  const { nearConfig } = await import("../src/lib/server/env");
  const { getConfig } = await import("../src/lib/server/contract");
  const { viewFunction } = await import("../src/lib/server/near-rpc");
  const { getEvmConfig } = await import("../src/lib/server/evm");
  const { withCrosschain } = await import("../src/lib/domain/policy/defaults");
  const { policyHash } = await import("../src/lib/domain/policy/hash");
  const { policyDocumentSchema } = await import("../src/lib/domain/policy/schema");
  const near = nearConfig();

  const business = must(await db().from("businesses").select("id,name").eq("contract_id", near.contractId).single(), "business");
  const agent = must(await db().from("agents").select("id").eq("business_id", business.id).limit(1).single(), "agent");
  const evm = await getEvmConfig();
  if (!evm) throw new Error("Run set_evm_config on the contract first");

  if (process.argv.includes("--activate")) {
    const products = await viewFunction<[string, { price: string; max_expense: string; active: boolean }][]>(near.contractId, "get_products", {});
    const onchain = products.find(([sku]) => sku === SKU)?.[1];
    if (!onchain?.active || onchain.price !== PRICE || onchain.max_expense !== MAX_EXPENSE) throw new Error(`Product ${SKU} is not set on-chain as expected. Run the set_product command first.`);
    const cfg = await getConfig();
    const active = must(await db().from("policies").select("rules,rules_hash").eq("business_id", business.id).eq("status", "active").single(), "active policy");
    if (cfg.policy_hash !== active.rules_hash || !active.rules?.crosschain) {
      throw new Error("Policy v3 is not active yet. Sign it in the owner console (/app) first, then open /app once so it activates.");
    }
    must(await db().from("products").update({ active: true, onchain_synced: true }).eq("business_id", business.id).eq("sku", SKU).select("id").single(), "activate product");
    console.log(`Product ${SKU} is live in the store.`);
    return;
  }

  const vendorAddress = (process.argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) ?? process.env.EVM_VENDOR_ADDRESS ?? "").toLowerCase();
  if (!vendorAddress) throw new Error("Pass the vendor's Sepolia address: npm run seed:crosschain -- 0x...");
  const approved = await viewFunction<[string, boolean][]>(near.contractId, "get_evm_vendors", {});
  if (!approved.some(([a, ok]) => a === vendorAddress && ok)) throw new Error(`${vendorAddress} is not approved on the contract. Run set_evm_vendor first.`);

  // The existing product keeps buying from the NEAR vendor.
  const nearVendor = must(await db().from("vendors").select("id").eq("business_id", business.id).eq("chain", "near").limit(1).single(), "NEAR vendor");
  await db().from("vendors").update({ description: "Reference notes on NEAR agent infrastructure (Intents, Chain Signatures, NEAR AI Cloud, OutLayer, NEP-141)." }).eq("id", nearVendor.id).is("description", null);
  await db().from("products").update({ vendor_id: nearVendor.id }).eq("business_id", business.id).eq("sku", "weekly-market-brief").is("vendor_id", null);

  const found = (await db().from("vendors").select("id").eq("business_id", business.id).eq("chain", "sepolia").eq("evm_address", vendorAddress).maybeSingle()).data;
  const evmVendor: { id: string } = found ?? must(
    await db().from("vendors").insert({ business_id: business.id, name: "Ethereum Data Desk", chain: "sepolia", evm_address: vendorAddress, near_account: null, category: "dataset", sku: "eth-reference-pack", unit_price_units: VENDOR_PRICE, approved: true, description: "Reference notes on Ethereum and cross-chain payments (Chain Signatures, EIP-1559, Sepolia USDC, ERC-20)." }).select("id").single(),
    "insert EVM vendor",
  );
  const existing = (await db().from("products").select("id").eq("business_id", business.id).eq("sku", SKU).maybeSingle()).data;
  if (!existing) {
    must(await db().from("products").insert({ business_id: business.id, sku: SKU, title: "Cross-chain Research Brief", description: "A sourced brief whose dataset is bought from a vendor on Ethereum Sepolia, paid by the business contract through NEAR Chain Signatures.", price_units: PRICE, max_expense_units: MAX_EXPENSE, active: false, vendor_id: evmVendor.id }).select("id").single(), "insert product");
  }

  const activeRow = must(await db().from("policies").select("version,rules,business_id").eq("business_id", business.id).eq("status", "active").single(), "active policy");
  const current = policyDocumentSchema.parse({ version: activeRow.version, business_id: activeRow.business_id, rules: activeRow.rules });
  const next = current.rules.crosschain ? null : withCrosschain(current, { agentId: agent.id, vendorId: evmVendor.id, chainId: evm.chain_id, token: evm.usdc, evmVendor: vendorAddress, sku: SKU, minPriceUnits: PRICE });
  if (next) {
    const hash = policyHash(next);
    await db().from("policies").delete().eq("business_id", business.id).in("status", ["draft", "pending_signature"]);
    must(await db().from("policies").insert({ business_id: business.id, version: next.version, source_text: "Also buy datasets from the approved vendor on Ethereum Sepolia, paid from the Chain Signatures treasury, under the same limits and approvals.", rules: next.rules, rules_hash: hash, status: "draft" }).select("id").single(), "save policy v3 draft");
    console.log(`Policy v${next.version} saved as a draft (sha256 ${hash}).`);
  }

  console.log("\nRun these as the owner (PowerShell):\n");
  console.log(`1) Register the product on the contract:`);
  console.log(`near --% contract call-function as-transaction ${near.contractId} set_product json-args "{\\"sku\\":\\"${SKU}\\",\\"price\\":\\"${PRICE}\\",\\"max_expense\\":\\"${MAX_EXPENSE}\\",\\"active\\":true}" prepaid-gas "30 Tgas" attached-deposit "0 NEAR" sign-as ${near.ownerAccountId} network-config testnet sign-with-keychain send\n`);
  console.log(`2) Open /app and sign "Anchor policy v${next?.version ?? current.version}" (or its near-cli fallback), then Record.\n`);
  console.log(`3) npm run seed:crosschain -- --activate\n`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
