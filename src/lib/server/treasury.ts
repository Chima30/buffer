/**
 * Self-funding treasury, server side. After the runtime finishes its jobs, the
 * agent checks its own gas and asks the contract for a refill when it runs low.
 * The contract enforces the size and the weekly cap; this code only decides when
 * to ask, records the result, and never moves money any other way.
 */
import type { Decision } from "@/lib/domain/policy/evaluate";
import { loadBusinessAnchored } from "./business";
import { getTreasury, type OnchainTreasury } from "./contract";
import { db } from "./db";
import { execContractCall } from "./agent/execute";
import { recordAction } from "./agent/actions";
import { writeLedger } from "./ledger";
import { nearBalance } from "./near-rpc";

const YOCTO = 10n ** 24n;
/** Ask for a refill when the agent's spendable NEAR drops below this. */
export const GAS_LOW_YOCTO = YOCTO;
const WEEK_NS = 7n * 24n * 3600n * 1_000_000_000n;

export interface GasPlan {
  needed: boolean;
  reason: string;
}

/** Pure: would the contract accept a refill now, and is one needed? */
export function planGasRefill(t: OnchainTreasury | null, agentSpendable: bigint | null, nowNs: bigint): GasPlan {
  if (!t) return { needed: false, reason: "Treasury upgrade not deployed" };
  const amount = BigInt(t.gas_refill_amount);
  if (amount === 0n) return { needed: false, reason: "Gas refills are not enabled" };
  if (agentSpendable === null) return { needed: false, reason: "Could not read the agent's balance" };
  if (agentSpendable >= GAS_LOW_YOCTO) return { needed: false, reason: "Agent has enough gas" };
  if (BigInt(t.gas_reserve) < amount) return { needed: false, reason: "Gas reserve is too low; the owner must fund it" };
  const weekOver = nowNs - BigInt(t.gas_week_start_ns) >= WEEK_NS;
  const spent = weekOver ? 0n : BigInt(t.gas_spent_week);
  if (spent + amount > BigInt(t.gas_week_cap)) return { needed: false, reason: "Weekly gas refill cap reached" };
  return { needed: true, reason: "Agent gas is below 1 NEAR" };
}

export async function maintainTreasury(): Promise<{ gas: string }> {
  const ctx = await loadBusinessAnchored().catch(() => null);
  if (!ctx) return { gas: "Business is paused or not anchored" };
  // At most one attempt every 10 minutes, across all runtime instances.
  const recent = await db().from("audit_logs").select("id").eq("action", "gas_refill_attempt").gte("at", new Date(Date.now() - 10 * 60_000).toISOString()).limit(1);
  if (recent.data?.length) return { gas: "Checked recently" };

  const [t, bal] = await Promise.all([getTreasury(), nearBalance(ctx.agent.near_account)]);
  const plan = planGasRefill(t, bal?.spendable ?? null, BigInt(Date.now()) * 1_000_000n);
  if (!plan.needed) return { gas: plan.reason };

  await db().from("audit_logs").insert({ business_id: ctx.business.id, actor: "agent", action: "gas_refill_attempt", target: ctx.agent.near_account, details: {} });
  const key = `gas-refill:${Math.floor(Date.now() / 600_000)}`;
  const decision: Decision = { outcome: "allow", reasons: [{ code: "CONTRACT_RULE", message: "Within the owner's on-chain gas refill rules" }], policyVersion: ctx.policy.version, absolute: false };
  await recordAction({ agentId: ctx.agent.id, orderId: null, tool: "refill_agent_gas", args: { amount_yocto: t?.gas_refill_amount }, decision, idempotencyKey: key });
  const res = await execContractCall({ method: "refill_agent_gas", args: {}, idempotencyKey: key, agentAccount: ctx.agent.near_account });
  if (res.state !== "CONFIRMED") return { gas: `Refill ${res.state.toLowerCase()}${res.state === "FAILED" ? `: ${res.reason}` : ""}` };
  const ev = res.events.find((e) => e.event === "gas_refilled");
  await writeLedger({ businessId: ctx.business.id, eventType: "gas_refilled", status: "REAL", txHash: res.txHash, verifiedOnChain: true, counterparty: ctx.agent.near_account, details: { amount_yocto: String(ev?.data.amount ?? t?.gas_refill_amount), gas_reserve_yocto: String(ev?.data.gas_reserve ?? "") } });
  return { gas: "Refilled" };
}
