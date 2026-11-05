/**
 * GET /api/orders/:id?token=...  Order progress for the customer. :id may also be the on-chain id (o-…).
 * Without the token only public status is returned; the brief and report need it.
 */
import { db, must } from "@/lib/server/db";
import { nearConfig } from "@/lib/server/env";
import { json, tokenMatches } from "@/lib/server/http";
import { sessionFrom } from "@/lib/server/wallet-auth";

export async function GET(req: Request, ctx: RouteContext<"/api/orders/[id]">) {
  const { id: ref } = await ctx.params;
  // Accepts the order's id or its on-chain id (o-…), so `npm run verify -- o-…` works too.
  const id = /^[0-9a-f-]{36}$/i.test(ref) ? ref : ((await db().from("orders").select("id").eq("onchain_order_id", ref).maybeSingle()).data?.id ?? ref);
  const token = new URL(req.url).searchParams.get("token");
  const order = must(await db().from("orders").select("id,state,price_units,onchain_order_id,brief,plan,access_token_hash,customer_account,quote,created_at,updated_at,failure_reason,issue_number,products(sku,title),subscriptions(id,issues_total)").eq("id", id).single(), "order");
  // The private link, or a wallet session for the account that paid.
  const authorised = tokenMatches(token, order.access_token_hash) || (!!order.customer_account && (await sessionFrom(req)) === order.customer_account);

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
    priceUnits: String(order.price_units),
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    authorised,
    // Price, expiry and breakdown are public like the price; the scope is the customer's.
    quote: order.quote
      ? (() => {
          const q = order.quote as { summary: string; sections: string[]; depth: string; needs_dataset: boolean; breakdown: Record<string, string>; max_expense_units: string; expires_at: string; quote_tx: string | null; clamped: string | null };
          return { depth: q.depth, needsDataset: q.needs_dataset, breakdown: q.breakdown, maxExpenseUnits: q.max_expense_units, expiresAt: q.expires_at, quoteTx: q.quote_tx, clamped: q.clamped, summary: authorised ? q.summary : null, sections: authorised ? q.sections : null };
        })()
      : null,
    subscription: order.subscriptions ? { id: (order.subscriptions as { id: string }).id, issue: order.issue_number, of: (order.subscriptions as { issues_total: number }).issues_total } : null,
    brief: authorised ? order.brief : null,
    plan: authorised ? order.plan : null,
    transitions: transitions.data ?? [],
    ledger: ledger.data ?? [],
    purchase: approval.data ?? null,
    report,
    proofs,
  });
}
