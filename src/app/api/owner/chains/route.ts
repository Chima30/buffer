/**
 * GET /api/owner/chains  Vendor competition setup for the owner console: each
 * EVM chain's contract config, treasury balances, vendors (with this hour's
 * price) and the owner transactions still needed. Read-only; loaded on demand
 * because it calls several chains.
 */
import { connection } from "next/server";
import { evmChains } from "@/lib/server/chains";
import { db } from "@/lib/server/db";
import { sepoliaConfig } from "@/lib/server/env";
import { getEvmChainConfigs, getEvmVendorApprovals, treasury as treasuryAddress, treasuryBalancesAll } from "@/lib/server/evm";
import { fail, json } from "@/lib/server/http";
import { vendorPrice } from "@/lib/server/procurement";
import type { PolicyDocument } from "@/lib/domain/policy/schema";

export async function GET() {
  await connection();
  try {
    const policy = await db().from("policies").select("version,rules,business_id").eq("status", "active").maybeSingle();
    const activeDoc = policy.data ? ({ version: policy.data.version, business_id: policy.data.business_id, rules: policy.data.rules } as PolicyDocument) : null;
    // Vendor competition: each chain's contract config, treasury balances, vendors and what is left to switch on.
    const [chainConfigs, chainApprovals, balances, vendorRows, tAddr] = await Promise.all([
      getEvmChainConfigs().catch(() => []),
      getEvmVendorApprovals().catch(() => new Map<number, Set<string>>()),
      treasuryBalancesAll().catch(() => []),
      db().from("vendors").select("id,name,chain,near_account,evm_address,unit_price_units,approved").eq("approved", true).order("chain"),
      treasuryAddress().catch(() => null),
    ]);
    const originalChain = chainConfigs[0]?.chain_id;
    const policyChains = new Set([...(activeDoc?.rules.crosschain ? [activeDoc.rules.crosschain.chain_id] : []), ...(activeDoc?.rules.crosschain_chains ?? []).map((c) => c.chain_id)]);
    const vendors = (vendorRows.data ?? []).map((v) => ({ id: v.id, name: v.name, chain: v.chain, address: v.chain === "near" ? v.near_account : v.evm_address, priceNowUnits: vendorPrice({ id: v.id, unit_price_units: String(v.unit_price_units) }).toString(), basePriceUnits: String(v.unit_price_units) }));
    const chainsSetup = {
      treasuryAddress: tAddr,
      policyCoversVendors: (vendorRows.data ?? []).every((v) => v.chain === "near" || (activeDoc?.rules.procurement.approved_vendor_ids.includes(v.id) ?? false)),
      chains: evmChains().map((c) => {
        const cfg = chainConfigs.find((x) => x.chain_id === c.chainId);
        const bal = balances.find((b) => b.chain.chainId === c.chainId);
        const onChainVendors = vendors.filter((v) => v.chain === c.key && v.address);
        const approved = chainApprovals.get(c.chainId) ?? new Set<string>();
        const isOriginal = originalChain === c.chainId;
        return {
          key: c.key,
          name: c.name,
          chainId: c.chainId,
          configured: !!cfg,
          inPolicy: policyChains.has(c.chainId),
          eth: bal ? bal.eth.toString() : null,
          usdc: bal ? bal.usdc.toString() : null,
          explorerAddress: tAddr ? `${c.explorer}/address/${tAddr}` : null,
          vendors: onChainVendors.map((v) => ({ ...v, approvedOnChain: approved.has((v.address ?? "").toLowerCase()) })),
          steps: [
            ...(!cfg && !isOriginal
              ? [{ label: `Switch on ${c.name}`, method: "set_evm_chain", args: { config: { mpc_contract: sepoliaConfig().mpcContract, chain_id: c.chainId, usdc: c.usdc, max_fee_per_gas_cap: c.defaults.maxFeePerGasCapWei, gas_limit: c.defaults.gasLimit } } }]
              : []),
            ...(isOriginal
              ? []
              : onChainVendors
                  .filter((v) => !approved.has((v.address ?? "").toLowerCase()))
                  .map((v) => ({ label: `Approve ${v.name} on ${c.name}`, method: "set_evm_chain_vendor", args: { chain_id: c.chainId, vendor: v.address, approved: true } }))),
          ],
        };
      }),
      nearVendors: vendors.filter((v) => v.chain === "near"),
    };
    return json(chainsSetup);
  } catch (e) {
    return fail(500, `Could not read the chains: ${(e as Error).message}`.slice(0, 300));
  }
}
