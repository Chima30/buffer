/**
 * POST /api/verify { order }  (an order URL from this site, its id, or its on-chain id like o-91336486ee60)
 * Runs the same checks as `npm run verify` and returns them. Every check reads
 * public chains (NEAR testnet, the EVM testnets, the NEAR MPC contract, NVIDIA's
 * keys), not our database, except the order's public page used to find the
 * transactions. For a check that doesn't trust this server at all, run the CLI.
 */
import { z } from "zod";
import { db } from "@/lib/server/db";
import { fail, json } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { verifyOrder } from "@/lib/verify/order";

export const maxDuration = 120;

const body = z.object({ order: z.string().trim().min(3).max(400) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const limited = await rateLimit(req, "verify", 30, 3600);
  if (limited) return limited;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, "Paste an order link or id");

  // Only orders of this site: the base is always our own origin, never a URL from the request.
  let ref = parsed.data.order;
  let token: string | undefined;
  if (/^https?:\/\//i.test(ref)) {
    try {
      const u = new URL(ref);
      ref = u.pathname.split("/").filter(Boolean).pop() ?? "";
      token = new URLSearchParams(u.hash.slice(1)).get("t") ?? undefined;
    } catch {
      return fail(400, "That link could not be read");
    }
  }
  let id = ref;
  if (!UUID.test(ref)) {
    const row = (await db().from("orders").select("id").eq("onchain_order_id", ref).maybeSingle()).data;
    if (!row) return fail(404, `No order ${ref}`);
    id = row.id;
  }

  try {
    const checks = await verifyOrder({ base: new URL(req.url).origin, orderId: id, token });
    return json({ orderId: id, checks });
  } catch (e) {
    return fail(502, (e as Error).message || "Verification could not finish");
  }
}
