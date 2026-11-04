/** POST /api/me/challenge -> a one-time nonce for the wallet to sign (NEP-413). */
import { rateLimit } from "@/lib/server/rate-limit";
import { fail, json } from "@/lib/server/http";
import { createChallenge } from "@/lib/server/wallet-auth";

export async function POST(req: Request) {
  const limited = await rateLimit(req, "signin", 30, 3600);
  if (limited) return limited;
  try {
    return json(await createChallenge());
  } catch (e) {
    return fail(500, (e as Error).message);
  }
}
