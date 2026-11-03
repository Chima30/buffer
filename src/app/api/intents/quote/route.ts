/**
 * POST /api/intents/quote { orderId, origin } -> live NEAR Intents price for
 * paying this order from another token. dry: true only; no funds move.
 * Recorded as a QUOTE, plus a SIMULATED settlement entry when requested, both
 * labelled so they can never be mistaken for a transaction.
 */
import { z } from "zod";
import { db, must } from "@/lib/server/db";
import { fail, json } from "@/lib/server/http";
import { writeLedger } from "@/lib/server/ledger";
import { listTokens, previewQuote } from "@/lib/server/oneclick";

const ORIGINS = { SOL: { blockchain: "sol", symbol: "SOL" }, ETH: { blockchain: "eth", symbol: "ETH" }, BTC: { blockchain: "btc", symbol: "BTC" } } as const;
const body = z.object({ orderId: z.uuid(), origin: z.enum(["SOL", "ETH", "BTC"]), simulate: z.boolean().optional() });

export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, "Invalid request");
  const order = must(await db().from("orders").select("id,business_id,price_units").eq("id", parsed.data.orderId).single(), "order");

  const tokens = await listTokens();
  const o = ORIGINS[parsed.data.origin];
  const origin = tokens.find((t) => t.blockchain === o.blockchain && t.symbol === o.symbol);
  // Mainnet USDC on NEAR is the closest real asset to our testnet price; this is a price preview only.
  const usdc = tokens.find((t) => t.blockchain === "near" && t.symbol === "USDC");
  if (!origin || !usdc) return fail(502, "Token not available from 1Click");

  const q = await previewQuote({ originAsset: origin.assetId, destinationAsset: usdc.assetId, amountOut: String(order.price_units) });
  const amountIn = q.amountIn ?? q.maxAmountIn;
  await db().from("intents_records").insert({ order_id: order.id, kind: "QUOTE", origin_asset: origin.assetId, destination_asset: usdc.assetId, amount_in: amountIn, amount_out: q.amountOut, raw: q.raw });
  await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: "intents_quote", status: "QUOTE", details: { origin: o.symbol, amount_in: amountIn, decimals: origin.decimals, note: "Live mainnet price via 1Click dry quote. No funds moved." } });

  if (parsed.data.simulate) {
    await db().from("intents_records").insert({ order_id: order.id, kind: "SIMULATED", origin_asset: origin.assetId, destination_asset: usdc.assetId, amount_in: amountIn, amount_out: q.amountOut });
    await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: "intents_settlement", status: "SIMULATED", details: { origin: o.symbol, note: "NEAR Intents has no testnet. In production the customer would deposit this amount and 1Click would deliver USDC to the contract. Nothing happened on-chain." } });
  }
  return json({ kind: "QUOTE", origin: o.symbol, decimals: origin.decimals, amountIn, amountOut: q.amountOut, fetchedAt: q.fetchedAt, simulated: !!parsed.data.simulate });
}
