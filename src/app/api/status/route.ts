/**
 * GET /api/status  Live health for the sidebar: is the contract taking orders,
 * is the agent running, does the active policy match the on-chain anchor, and
 * when did the agent last move an order. Public, cheap, read-only.
 */
import { connection } from "next/server";
import { getConfig } from "@/lib/server/contract";
import { db } from "@/lib/server/db";
import { json } from "@/lib/server/http";

export async function GET() {
  await connection();
  const [onchain, agent, policy, last, ordersToday] = await Promise.all([
    getConfig().catch(() => null),
    db().from("agents").select("status").limit(1).maybeSingle(),
    db().from("policies").select("version,rules_hash").eq("status", "active").maybeSingle(),
    db().from("order_transitions").select("at").order("at", { ascending: false }).limit(1).maybeSingle(),
    db().from("orders").select("id", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString()),
  ]);
  return json({
    contract: onchain ? (onchain.paused ? "paused" : "live") : "unreachable",
    agent: agent.data?.status ?? "unknown",
    policy: onchain && policy.data ? (policy.data.rules_hash === onchain.policy_hash && policy.data.version === onchain.policy_version ? "anchored" : "mismatch") : "unknown",
    policyVersion: policy.data?.version ?? null,
    lastActivity: last.data?.at ?? null,
    orders24h: ordersToday.count ?? 0,
  });
}
