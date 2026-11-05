/**
 * GET /api/owner/health  The survival engine's live view for the owner console:
 * actuals, forecast (with its assumptions), runway, obligations, risks,
 * interventions, and the audit trail of what was executed or proposed.
 * Read-only, like the rest of the console's data.
 */
import { connection } from "next/server";
import { db } from "@/lib/server/db";
import { currentHealth } from "@/lib/server/health";
import { nearConfig } from "@/lib/server/env";
import { fail, json } from "@/lib/server/http";

export async function GET() {
  await connection();
  try {
    const { health, businessId } = await currentHealth();
    const events = businessId
      ? ((await db().from("health_events").select("id,kind,code,severity,mode,status,title,detail,evidence,policy_check,tx_hash,order_id,created_at,resolved_at").eq("business_id", businessId).order("created_at", { ascending: false }).limit(40)).data ?? [])
      : [];
    return json({ health, events: events.map((e) => ({ ...e, explorer_url: e.tx_hash ? nearConfig().explorerTxUrl(e.tx_hash) : null })), readAt: new Date().toISOString() });
  } catch (e) {
    return fail(500, `Health check failed: ${(e as Error).message}`.slice(0, 300));
  }
}
