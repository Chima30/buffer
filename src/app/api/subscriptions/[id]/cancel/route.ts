/**
 * POST /api/subscriptions/:id/cancel { token, txHash, sender }
 * Records a cancellation the customer or owner signed themselves. Verifies the
 * contract emitted subscription_cancelled for this id in that transaction, then
 * records the refund the contract sent. This route moves no money.
 */
import { z } from "zod";
import { bufferEventsFromTx } from "@/lib/server/contract";
import { db, must } from "@/lib/server/db";
import { rateLimit } from "@/lib/server/rate-limit";
import { fail, json, tokenMatches } from "@/lib/server/http";
import { writeLedger } from "@/lib/server/ledger";
import { reconcile, type SubscriptionRow } from "@/lib/server/subscriptions";

const body = z.object({
  token: z.string().min(10),
  txHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, "Not a NEAR transaction hash"),
  sender: z.string().min(2).max(64),
});

export async function POST(req: Request, ctx: RouteContext<"/api/subscriptions/[id]/cancel">) {
  const limited = await rateLimit(req, "payment", 60, 3600);
  if (limited) return limited;
  const { id } = await ctx.params;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Invalid request");
  const { token, txHash, sender } = parsed.data;

  const sub = must<SubscriptionRow & { cancel_tx: string | null }>(
    await db().from("subscriptions").select("id,business_id,product_id,topic,customer_account,state,issues_total,issues_started,issue_price_units,onchain_subscription_id,access_token_hash,next_due_at,refund_units,refund_status,cancel_tx").eq("id", id).single(),
    "subscription",
  );
  if (!tokenMatches(token, sub.access_token_hash)) return fail(403, "Invalid subscription token");
  if (sub.cancel_tx) return json({ ok: true, note: "Cancellation already recorded" });

  const v = await bufferEventsFromTx(txHash, sender);
  if (v.state === "PENDING") return fail(202, "Transaction not final yet; try again in a few seconds");
  if (v.state === "FAILED") return fail(400, "Transaction failed on-chain", v.reason);
  const cancelled = v.events.find((e) => e.event === "subscription_cancelled" && e.data.subscription_id === sub.onchain_subscription_id);
  if (!cancelled) return fail(400, "No cancellation of this subscription in that transaction");
  const refunded = v.events.find((e) => e.event === "subscription_refunded" && e.data.subscription_id === sub.onchain_subscription_id);

  const claim = await db().from("subscriptions").update({ cancel_tx: txHash }).eq("id", sub.id).is("cancel_tx", null).select("id");
  if (!claim.data?.length) return json({ ok: true, note: "Cancellation already recorded" });
  await reconcile(sub);
  const amount = BigInt(String(cancelled.data.refund ?? "0"));
  if (amount > 0n) {
    await writeLedger({
      businessId: sub.business_id,
      eventType: "subscription_refunded",
      status: refunded ? "REAL" : "PENDING",
      amountUnits: amount,
      counterparty: sub.customer_account,
      txHash: refunded ? txHash : null,
      verifiedOnChain: !!refunded,
      details: { subscription: sub.onchain_subscription_id, cancelled_by: String(cancelled.data.by ?? sender), issues_unstarted: Number(cancelled.data.issues_unstarted ?? 0) },
    });
  }
  return json({ ok: true, state: "CANCELLED", refundUnits: amount.toString(), refunded: !!refunded });
}
