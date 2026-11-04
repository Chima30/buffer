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
  const order = must(await db().from("orders").select("id,state,price_units,onchain_order_id,brief,plan,access_token_hash,created_at,updated_at,failure_reason,products(sku,title)").eq("id", id).single(), "order");
  const authorised = tokenMatches(token, order.access_token_hash);

  const [transitions, ledger, approval] = await Promise.all([
    db().from("order_transitions").select("from_state,to_state,reason,at").eq("order_id", id).order("at"),
    db().from("ledger_entries").select("order_id,event_type,status,amount_units,counterparty,tx_hash,explorer_url,details,at").eq("order_id", id).order("at"),
    db().from("procurements").select("status,amount_units,onchain_index,chain,evm_tx_hash").eq("order_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  let report: unknown = null;
  if (authorised) {
    const r = await db().from("reports").select("content,content_hash,created_at").eq("order_id", id).maybeSingle();
    report = r.data;
  }
  // Proofs are public: they hold hashes and signatures, never the brief or the report.
  const calls = await db().from("inference_calls").select("purpose,model,chat_id,signature_kind,signing_address,signature,signature_text,verification_level,gpu_attestation,gpu_attestation_detail,request_hash,response_hash,tokens_in,tokens_out,cost_usd_micros").eq("order_id", id).order("created_at");
  const proofs = calls.data ?? [];

  return json({
    id: order.id,
    onchainOrderId: order.onchain_order_id,
    contractId: nearConfig().contractId,
    tokenContract: nearConfig().usdcTokenId,
    sku: (order.products as { sku: string } | null)?.sku ?? "weekly-market-brief",
    productTitle: (order.products as { title: string } | null)?.title ?? "Weekly Market Brief",
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
