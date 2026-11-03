/**
 * POST /api/orders/:id/payment { token, txHash, sender }
 * Marks an order PAID only after confirming on NEAR testnet that the
 * transaction succeeded and the contract emitted payment_received for this
 * exact order and price. Then starts the agent.
 */
import { after } from "next/server";
import { z } from "zod";
import { runDueJobs, enqueue } from "@/lib/server/agent/runtime";
import { bufferEventsFromTx, getOrder } from "@/lib/server/contract";
import { db, must } from "@/lib/server/db";
import { nearConfig } from "@/lib/server/env";
import { fail, json, tokenMatches } from "@/lib/server/http";
import { writeLedger } from "@/lib/server/ledger";

export const maxDuration = 300;

const body = z.object({
  token: z.string().min(10),
  txHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, "Not a NEAR transaction hash"),
  sender: z.string().min(2).max(64),
});

export async function POST(req: Request, ctx: RouteContext<"/api/orders/[id]/payment">) {
  const { id } = await ctx.params;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Invalid request");
  const { token, txHash, sender } = parsed.data;

  const order = must(await db().from("orders").select("id,business_id,state,price_units,onchain_order_id,access_token_hash").eq("id", id).single(), "order");
  if (!tokenMatches(token, order.access_token_hash)) return fail(403, "Invalid order token");
  if (order.state !== "AWAITING_PAYMENT") return json({ ok: true, state: order.state, note: "Payment already processed" });

  const seen = await db().from("payments").select("id,order_id").eq("tx_hash", txHash).maybeSingle();
  if (seen.data) return fail(409, "This transaction was already used for a payment");

  const v = await bufferEventsFromTx(txHash, sender);
  if (v.state === "PENDING") return fail(202, "Transaction not final yet; try again in a few seconds");
  if (v.state === "FAILED") return fail(400, "Transaction failed on-chain", v.reason);

  const received = v.events.find((e) => e.event === "payment_received" && e.data.order_id === order.onchain_order_id);
  const rejected = v.events.find((e) => e.event === "payment_rejected");
  if (!received) {
    return fail(400, rejected ? `The contract returned the payment: ${String(rejected.data.reason)}` : "No payment for this order in that transaction");
  }
  if (String(received.data.amount) !== String(order.price_units)) return fail(400, "Paid amount does not match the price");

  // Double-check contract state, not just the log.
  const onchain = await getOrder(order.onchain_order_id);
  if (!onchain || onchain.gross !== String(order.price_units)) return fail(400, "Contract does not show this order as paid");

  must(
    await db().from("payments").insert({ order_id: order.id, status: "VERIFIED", token_id: nearConfig().usdcTokenId, amount_units: order.price_units, sender_account: String(received.data.customer ?? sender), tx_hash: txHash, verified_at: new Date().toISOString() }).select("id").single(),
    "record payment",
  );
  const upd = await db().from("orders").update({ state: "PAID", customer_account: String(received.data.customer ?? sender) }).eq("id", order.id).eq("state", "AWAITING_PAYMENT").select("id");
  if (!upd.data?.length) return json({ ok: true, note: "Payment already processed" });
  await db().from("order_transitions").insert({ order_id: order.id, from_state: "AWAITING_PAYMENT", to_state: "PAID", reason: "payment verified on-chain" });
  await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: "payment_received", status: "REAL", amountUnits: BigInt(order.price_units), counterparty: String(received.data.customer ?? sender), txHash, verifiedOnChain: true });
  await enqueue(order.id, "plan");

  after(async () => {
    await runDueJobs(270_000);
  });
  return json({ ok: true, state: "PAID" });
}
