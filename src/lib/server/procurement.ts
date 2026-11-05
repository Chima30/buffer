/**
 * Vendor competition. When an order needs data, the agent asks every approved
 * vendor for its price, adds what paying on that vendor's chain costs (live gas,
 * converted to USDC), drops any bid the owner's rules or the treasury cannot
 * cover, and picks the cheapest. The choice is deterministic code: the AI only
 * decided that a dataset is needed.
 *
 * Owner's constraints that apply here: which vendors and chains are approved
 * (policy and contract), the per-chain fee caps, the order's expense cap, the
 * spending limits and the approval threshold. Everything else is the agent's.
 */
import { createHash } from "node:crypto";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { evaluate } from "@/lib/domain/policy/evaluate";
import type { BusinessContext, VendorRow } from "./business";
import { evaluationContext } from "./business";
import { chainByKey, type GasToken } from "./chains";
import { viewFunction } from "./near-rpc";
import { nearConfig } from "./env";
import { clientFor, getEvmChainConfigs, getEvmVendorApprovals, offerFees, treasury, treasuryBalances, type OnchainEvmConfig } from "./evm";

export interface Bid {
  vendorId: string;
  vendor: string;
  chain: string;
  chainName: string;
  chainId: number | null;
  address: string;
  priceUnits: string;
  gasUnits: string;
  totalUnits: string;
  status: "eligible" | "skipped" | "won";
  reason: string | null;
  needsApproval: boolean;
}

export interface Competition {
  bids: Bid[];
  winner: Bid | null;
  ethUsd: number;
  ethUsdSource: string;
  /** Every gas token used in the bids, with its price and source. */
  gasPrices: { token: GasToken; usd: number; source: string }[];
  hour: string;
}

const USDC = 1_000_000n;

/**
 * Demo vendors publish a price list that changes every hour (within ±15% of
 * their base price), like a real data market. Deterministic per vendor and hour,
 * so anyone can recompute it. Rounded to 0.10 USDC.
 */
export function vendorPrice(vendor: { id: string; unit_price_units: string }, at = new Date()): bigint {
  const hour = at.toISOString().slice(0, 13);
  const h = createHash("sha256").update(`${vendor.id}:${hour}`).digest();
  const swingBps = BigInt((h.readUInt16BE(0) % 3001) - 1500); // -1500..+1500
  const base = BigInt(vendor.unit_price_units);
  const raw = (base * (10_000n + swingBps)) / 10_000n;
  return ((raw + 50_000n) / 100_000n) * 100_000n;
}

const PYTH_IDS: Partial<Record<GasToken, string>> = { ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" };
const FALLBACK_USD: Record<GasToken, number> = { ETH: 3000, POL: 0.25, AVAX: 25 };
const priceCache = new Map<GasToken, { usd: number; at: number; source: string }>();

async function fromPyth(token: GasToken): Promise<number> {
  const id = PYTH_IDS[token];
  if (!id) throw new Error("no feed");
  const res = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids%5B%5D=${id}&parsed=true`, { signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { parsed?: { price: { price: string; expo: number } }[] };
  const p = j.parsed?.[0]?.price;
  const usd = p ? Number(p.price) * 10 ** p.expo : NaN;
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("no price in reply");
  return usd;
}

async function fromCoinbase(token: GasToken): Promise<number> {
  const res = await fetch(`https://api.coinbase.com/v2/prices/${token}-USD/spot`, { signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { data?: { amount?: string } };
  const usd = Number(j.data?.amount);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("no price in reply");
  return usd;
}

/** USD price of a gas token, to value testnet gas as if it were real: Pyth, then Coinbase, then a labelled fallback. */
export async function gasTokenUsd(token: GasToken): Promise<{ usd: number; source: string }> {
  const hit = priceCache.get(token);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit;
  const errors: string[] = [];
  for (const [name, get] of [["Pyth", fromPyth], ["Coinbase", fromCoinbase]] as const) {
    try {
      const v = { usd: await get(token), at: Date.now(), source: `${name} ${token}/USD` };
      priceCache.set(token, v);
      return v;
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message.slice(0, 40)}`);
    }
  }
  // Short-lived: the feeds are tried again on the next order.
  const v = { usd: FALLBACK_USD[token], at: Date.now() - 4 * 60_000, source: `fallback ${FALLBACK_USD[token]} USD (${errors.join("; ")})` };
  priceCache.set(token, v);
  return v;
}

/** Kept for callers that only need ETH. */
export const ethUsd = () => gasTokenUsd("ETH");

const weiToUsdcUnits = (wei: bigint, usd: number) => (wei * BigInt(Math.round(usd * 1e6))) / 10n ** 18n;

/** Gas units a USDC transfer from the treasury needs on a chain (estimated live; conservative fallback). */
async function transferGas(cfg: OnchainEvmConfig, to: string, amount: bigint, from: `0x${string}`): Promise<bigint> {
  try {
    const g = await clientFor(cfg.chain_id).estimateGas({ account: from, to: cfg.usdc as Hex, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as Hex, amount] }) });
    return g < BigInt(cfg.gas_limit) ? g : BigInt(cfg.gas_limit);
  } catch {
    return BigInt(Math.min(cfg.gas_limit, 65_000));
  }
}

export async function runCompetition(ctx: BusinessContext, orderId: string, capLeftUnits: bigint): Promise<Competition> {
  const now = new Date();
  const tokens = [...new Set(ctx.vendors.map((v) => chainByKey(v.chain)?.gasToken).filter((t): t is GasToken => !!t))];
  const [configs, approvals, nearVendors, from, evalCtx, ...prices] = await Promise.all([
    getEvmChainConfigs(),
    getEvmVendorApprovals(),
    viewFunction<[string, boolean][]>(nearConfig().contractId, "get_vendors").catch(() => [] as [string, boolean][]),
    treasury(),
    evaluationContext(ctx),
    ...tokens.map((t) => gasTokenUsd(t)),
  ]);
  const priceOf = new Map(tokens.map((t, i) => [t, prices[i]]));
  const eth = priceOf.get("ETH") ?? (await gasTokenUsd("ETH"));
  const nearApproved = new Set(nearVendors.filter(([, ok]) => ok).map(([a]) => a));

  const bids = await Promise.all(
    ctx.vendors.map(async (v: VendorRow): Promise<Bid> => {
      const price = vendorPrice(v, now);
      const chain = v.chain === "near" ? null : chainByKey(v.chain);
      const base: Bid = {
        vendorId: v.id,
        vendor: v.name,
        chain: v.chain,
        chainName: chain?.name ?? "NEAR",
        chainId: chain?.chainId ?? null,
        address: v.chain === "near" ? (v.near_account ?? "") : (v.evm_address ?? ""),
        priceUnits: price.toString(),
        gasUnits: "0",
        totalUnits: price.toString(),
        status: "eligible",
        reason: null,
        needsApproval: false,
      };
      const skip = (reason: string): Bid => ({ ...base, status: "skipped", reason });
      if (price > capLeftUnits) return skip(`Price is above what this order may still spend (${Number(capLeftUnits) / 1e6} USDC)`);

      if (v.chain === "near") {
        if (!nearApproved.has(base.address)) return skip("Not approved in the contract");
        const d = evaluate(ctx.policy, { tool: "request_purchase", agentId: ctx.agent.id, orderId, amountUnits: price, tokenId: nearConfig().usdcTokenId, destination: base.address, vendorId: v.id }, evalCtx);
        if (d.outcome === "deny") return skip(`Policy: ${d.reasons[0]?.message ?? "denied"}`);
        return { ...base, needsApproval: d.outcome === "needs_approval" };
      }

      if (!chain) return skip("Unknown chain");
      const cfg = configs.find((c) => c.chain_id === chain.chainId);
      if (!cfg) return skip(`${chain.name} is not switched on in the contract`);
      if (!approvals.get(chain.chainId)?.has(base.address.toLowerCase())) return skip(`Not approved in the contract on ${chain.name}`);
      const d = evaluate(ctx.policy, { tool: "request_crosschain_purchase", agentId: ctx.agent.id, orderId, amountUnits: price, tokenId: cfg.usdc, destination: base.address, vendorId: v.id, chainId: chain.chainId }, evalCtx);
      if (d.outcome === "deny") return skip(`Policy: ${d.reasons[0]?.message ?? "denied"}`);
      try {
        const [fees, bal, gas] = await Promise.all([offerFees(BigInt(cfg.max_fee_per_gas_cap), chain.chainId), treasuryBalances(chain.chainId), transferGas(cfg, base.address, price, from)]);
        if (!bal || bal.usdc < price) return skip(`Treasury holds ${bal ? Number(bal.usdc) / 1e6 : 0} USDC on ${chain.name}`);
        if (bal.eth < BigInt(cfg.gas_limit) * fees.maxFeePerGas) return skip(`Treasury has too little ${chain.gasToken} for gas on ${chain.name}`);
        // Expected cost: estimated gas at the offered fee (an upper bound for EIP-1559).
        const gasUnits = weiToUsdcUnits(gas * fees.maxFeePerGas, (priceOf.get(chain.gasToken) ?? eth).usd);
        return { ...base, gasUnits: gasUnits.toString(), totalUnits: (price + gasUnits).toString(), needsApproval: d.outcome === "needs_approval" };
      } catch (e) {
        return skip(`${chain.name} could not be reached: ${(e as Error).message.slice(0, 80)}`);
      }
    }),
  );

  // Cheapest total wins; on a tie NEAR first (no bridge, no gas), then the lower price.
  const eligible = bids.filter((b) => b.status === "eligible");
  eligible.sort((a, b) => {
    const d = BigInt(a.totalUnits) - BigInt(b.totalUnits);
    if (d !== 0n) return d < 0n ? -1 : 1;
    if ((a.chain === "near") !== (b.chain === "near")) return a.chain === "near" ? -1 : 1;
    return BigInt(a.priceUnits) < BigInt(b.priceUnits) ? -1 : 1;
  });
  const winner = eligible[0] ? { ...eligible[0], status: "won" as const } : null;
  return {
    bids: bids.map((b) => (winner && b.vendorId === winner.vendorId ? winner : b)),
    winner,
    ethUsd: eth.usd,
    ethUsdSource: eth.source,
    gasPrices: tokens.map((t) => ({ token: t, usd: priceOf.get(t)!.usd, source: priceOf.get(t)!.source })),
    hour: now.toISOString().slice(0, 13) + ":00Z",
  };
}

export const usdc = (units: bigint | string) => (Number(units) / Number(USDC)).toFixed(2);
