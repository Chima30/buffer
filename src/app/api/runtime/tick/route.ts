/**
 * POST /api/runtime/tick  (header: Authorization: Bearer <RUNTIME_SECRET>)
 * Safety net called by Supabase Cron: runs any due jobs (e.g. a purchase that
 * was just approved, or a step that is being retried).
 */
import { runDueJobs } from "@/lib/server/agent/runtime";
import { runtimeConfig } from "@/lib/server/env";
import { fail, json, secretMatches } from "@/lib/server/http";

export const maxDuration = 300;

export async function POST(req: Request) {
  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretMatches(auth, runtimeConfig().runtimeSecret)) return fail(401, "Unauthorised");
  const result = await runDueJobs(270_000);
  return json({ ok: true, ...result });
}
