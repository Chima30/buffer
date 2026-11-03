/**
 * GET /api/orders/:id?token=...  Order progress for the customer.
 * Without the token only public status is returned; the brief and report need it.
 */
import { db, must } from "@/lib/server/db";
import { nearConfig } from "@/lib/server/env";
import { json, tokenMatches } from "@/lib/server/http";

export async function GET(req: Request, ctx: RouteContext<"/api/orders/[id]">) {
  const { id } = await ctx.params;
  const token = new URL(req.url).searchParams.get("token");
  const order = must(await db().from("orders").select("id,state,price_units,onchain_order_id,brief,plan,access_token_hash,created_at,updated_at,failure_reason").eq("id", id).single(), "order");
  const authorised = tokenMatches(token, order.access_token_hash);

  const [transitions, ledger, approval] = await Promise.all([
    db().from("order_transitions").select("from_state,to_state,reason,at").eq("order_id", id).order("at"),
    db().from("ledger_entries").select("order_id,event_type,status,amount_units,counterparty,tx_hash,explorer_url,details,at").eq("order_id", id).order("at"),
    db().from("procurements").select("status,amount_units,onchain_index").eq("order_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  let report: unknown = null;
  let proofs: unknown[] = [];
  if (authorised) {
    const r = await db().from("reports").select("content,content_hash,created_at").eq("order_id", id).maybeSingle();
    report = r.data;
    const calls = await db().from("inference_calls").select("purpose,model,chat_id,signature_kind,signing_address,verification_level,request_hash,response_hash,tokens_in,tokens_out,cost_usd_micros").eq("order_id", id).order("created_at");
    proofs = calls.data ?? [];
  }

  return json({
    id: order.id,
    onchainOrderId: order.onchain_order_id,
    contractId: nearConfig().contractId,
    tokenContract: nearConfig().usdcTokenId,
    sku: "weekly-market-brief",
    state: order.state,
    priceUnits: order.price_units,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    authorised,
    brief: authorised ? order.brief : null,
    plan: authorised ? order.plan : null,
    transitions: transitions.data ?? [],
    ledger: ledger.data ?? [],
    purchase: approval.data ?? null,
    report,
    proofs,
  });
}
