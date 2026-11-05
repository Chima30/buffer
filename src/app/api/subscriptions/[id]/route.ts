/**
 * GET /api/subscriptions/:id?token=...  The subscription and its issues.
 * Without the token only public status is returned; the topic needs it.
 */
import { connection } from "next/server";
import { getSubscription } from "@/lib/server/contract";
import { db, must } from "@/lib/server/db";
import { nearConfig } from "@/lib/server/env";
import { json, tokenMatches } from "@/lib/server/http";
import { sessionFrom } from "@/lib/server/wallet-auth";
import { reconcile, type SubscriptionRow } from "@/lib/server/subscriptions";

export async function GET(req: Request, ctx: RouteContext<"/api/subscriptions/[id]">) {
  await connection();
  const { id } = await ctx.params;
  const token = new URL(req.url).searchParams.get("token");
  const row = must<SubscriptionRow & { created_at: string; products: { sku: string; title: string } | null }>(
    await db().from("subscriptions").select("id,business_id,product_id,topic,customer_account,state,issues_total,issues_started,issue_price_units,onchain_subscription_id,access_token_hash,next_due_at,refund_units,refund_status,created_at,products(sku,title)").eq("id", id).single(),
    "subscription",
  );
  const authorised = tokenMatches(token, row.access_token_hash) || (!!row.customer_account && (await sessionFrom(req)) === row.customer_account);
  const chain = row.state === "AWAITING_PAYMENT" ? null : await getSubscription(row.onchain_subscription_id);
  const sub = chain ? await reconcile(row, chain) : row;
  const issues = must<{ id: string; issue_number: number; state: string; onchain_order_id: string; plan: { title?: string } | null; created_at: string }[]>(
    await db().from("orders").select("id,issue_number,state,onchain_order_id,plan,created_at").eq("subscription_id", id).order("issue_number"),
    "issues",
  );
  const near = nearConfig();
  return json({
    id: sub.id,
    onchainSubscriptionId: sub.onchain_subscription_id,
    contractId: near.contractId,
    tokenContract: near.usdcTokenId,
    sku: row.products?.sku ?? "brief-subscription",
    productTitle: row.products?.title ?? "Brief subscription",
    state: sub.state,
    issuesTotal: sub.issues_total,
    issuesStarted: sub.issues_started,
    issuePriceUnits: String(sub.issue_price_units),
    totalUnits: (BigInt(sub.issue_price_units) * BigInt(sub.issues_total)).toString(),
    escrowUnits: chain?.escrow ?? null,
    intervalSeconds: chain ? Math.round(chain.interval_ns / 1e9) : null,
    nextDueAt: sub.state === "ACTIVE" ? sub.next_due_at : null,
    customer: chain?.customer ?? sub.customer_account,
    refund: sub.refund_units ? { units: sub.refund_units, status: sub.refund_status } : null,
    createdAt: row.created_at,
    authorised,
    topic: authorised ? sub.topic : null,
    issues: issues.map((o) => ({ id: o.id, number: o.issue_number, state: o.state, onchainOrderId: o.onchain_order_id, title: authorised ? (o.plan?.title ?? null) : null, createdAt: o.created_at })),
  });
}
