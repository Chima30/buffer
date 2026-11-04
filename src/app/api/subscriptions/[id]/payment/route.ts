/**
 * POST /api/subscriptions/:id/payment { token, txHash, sender }
 * Activates a subscription only after confirming on NEAR testnet that the
 * contract emitted subscription_started for this exact id, amount and issue
 * count. Then opens the first issue straight away.
 */
import { after } from "next/server";
import { z } from "zod";
import { runDueJobs } from "@/lib/server/agent/runtime";
import { bufferEventsFromTx, getSubscription } from "@/lib/server/contract";
import { db, must } from "@/lib/server/db";
import { rateLimit } from "@/lib/server/rate-limit";
import { fail, json, tokenMatches } from "@/lib/server/http";
import { writeLedger } from "@/lib/server/ledger";
import { runSubscriptions } from "@/lib/server/subscriptions";

export const maxDuration = 300;

const body = z.object({
  token: z.string().min(10),
  txHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, "Not a NEAR transaction hash"),
  sender: z.string().min(2).max(64),
});

export async function POST(req: Request, ctx: RouteContext<"/api/subscriptions/[id]/payment">) {
  const limited = await rateLimit(req, "payment", 60, 3600);
  if (limited) return limited;
  const { id } = await ctx.params;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Invalid request");
  const { token, txHash, sender } = parsed.data;

  const sub = must(await db().from("subscriptions").select("id,business_id,state,issues_total,issue_price_units,onchain_subscription_id,access_token_hash").eq("id", id).single(), "subscription");
  if (!tokenMatches(token, sub.access_token_hash)) return fail(403, "Invalid subscription token");
  if (sub.state !== "AWAITING_PAYMENT") return json({ ok: true, state: sub.state, note: "Payment already processed" });
  const used = await db().from("subscriptions").select("id").eq("payment_tx", txHash).maybeSingle();
  if (used.data) return fail(409, "This transaction was already used for a payment");

  const v = await bufferEventsFromTx(txHash, sender);
  if (v.state === "PENDING") return fail(202, "Transaction not final yet; try again in a few seconds");
  if (v.state === "FAILED") return fail(400, "Transaction failed on-chain", v.reason);
  const started = v.events.find((e) => e.event === "subscription_started" && e.data.subscription_id === sub.onchain_subscription_id);
  const rejected = v.events.find((e) => e.event === "payment_rejected");
  if (!started) return fail(400, rejected ? `The contract returned the payment: ${String(rejected.data.reason)}` : "No payment for this subscription in that transaction");

  const total = BigInt(sub.issue_price_units) * BigInt(sub.issues_total);
  if (String(started.data.amount) !== total.toString() || Number(started.data.issues) !== sub.issues_total) return fail(400, "Paid amount or issue count does not match");
  // Double-check contract state, not just the log.
  const onchain = await getSubscription(sub.onchain_subscription_id);
  if (!onchain || onchain.escrow !== total.toString() || onchain.issues_total !== sub.issues_total) return fail(400, "Contract does not show this subscription as paid");

  const customer = String(started.data.customer ?? sender);
  const upd = await db()
    .from("subscriptions")
    .update({ state: "ACTIVE", payment_tx: txHash, customer_account: customer, next_due_at: new Date(Math.floor(onchain.next_due_ns / 1e6)).toISOString() })
    .eq("id", sub.id)
    .eq("state", "AWAITING_PAYMENT")
    .select("id");
  if (!upd.data?.length) return json({ ok: true, note: "Payment already processed" });
  // Held in the subscription escrow; each issue counts as revenue only when it opens.
  await writeLedger({ businessId: sub.business_id, eventType: "subscription_prepaid", status: "REAL", amountUnits: total, counterparty: customer, txHash, verifiedOnChain: true, details: { subscription: sub.onchain_subscription_id, issues: sub.issues_total } });

  after(async () => {
    await runSubscriptions().catch(() => null);
    await runDueJobs(250_000);
  });
  return json({ ok: true, state: "ACTIVE" });
}
