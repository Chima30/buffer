/**
 * POST /api/me/session { accountId, publicKey, signature, nonce }
 * Verifies the signed sign-in message and the key's full access on-chain,
 * then returns a session token. No transaction, no gas.
 */
import { z } from "zod";
import { rateLimit } from "@/lib/server/rate-limit";
import { fail, json } from "@/lib/server/http";
import { AuthError, completeSignIn } from "@/lib/server/wallet-auth";

const body = z.object({
  accountId: z.string().regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/).min(2).max(64),
  publicKey: z.string().min(10).max(120),
  signature: z.string().min(10).max(200),
  nonce: z.string().length(64),
});

export async function POST(req: Request) {
  const limited = await rateLimit(req, "signin", 30, 3600);
  if (limited) return limited;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, "Invalid sign-in");
  try {
    return json(await completeSignIn(parsed.data));
  } catch (e) {
    if (e instanceof AuthError) return fail(401, e.message);
    return fail(500, (e as Error).message);
  }
}
