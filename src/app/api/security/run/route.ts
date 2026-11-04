/**
 * POST /api/security/run  (header: Authorization: Bearer <RUNTIME_SECRET>)
 * Runs the red-team suite against the live testnet business and stores the result.
 * Secret-gated because attacks 2 and 4 send real (failing) transactions and
 * attack 1 spends a little inference credit.
 */
import { runRedteam } from "@/lib/server/redteam";
import { runtimeConfig } from "@/lib/server/env";
import { fail, json, secretMatches } from "@/lib/server/http";

export const maxDuration = 300;

export async function POST(req: Request) {
  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secretMatches(auth, runtimeConfig().runtimeSecret)) return fail(401, "Unauthorised");
  try {
    return json({ ok: true, run: await runRedteam() });
  } catch (e) {
    return fail(500, (e as Error).message);
  }
}
