/** GET /api/ledger  Public activity ledger (read from the safe public view). */
import { db } from "@/lib/server/db";
import { json } from "@/lib/server/http";

export async function GET(req: Request) {
  const limit = Math.min(200, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 100)));
  const { data, error } = await db()
    .from("public_ledger")
    .select("id,order_id,event_type,status,amount_units,counterparty,tx_hash,explorer_url,at")
    .order("at", { ascending: false })
    .limit(limit);
  if (error) return json({ error: error.message }, 500);
  return json({ entries: data ?? [] });
}
