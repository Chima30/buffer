/**
 * POST /api/runtime/tick  (header: Authorization: Bearer <RUNTIME_SECRET>)
 * Safety net called by Supabase Cron: runs any due jobs (e.g. a purchase that
 * was just approved, or a step that is being retried), then the treasury check.
 */
import { runDueJobs } from "@/lib/server/agent/runtime";
import { maintainTreasury } from "@/lib/server/treasury";
import { runtimeConfig } from "@/lib/server/env";
import { fail, json, secretMatches } from "@/lib/server/http";

export const maxDuration = 300;

export async function POST(req: Request) {
  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretMatches(auth, runtimeConfig().runtimeSecret)) return fail(401, "Unauthorised");
  const result = await runDueJobs(240_000);
  // The business pays its own gas: refill the agent if it is low (contract-capped).
  const treasury = await maintainTreasury().catch((e: Error) => ({ gas: `error: ${e.message.slice(0, 200)}` }));
  return json({ ok: true, ...result, treasury });
}
