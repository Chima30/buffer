/**
 * POST /api/policy/pricing-draft
 * Drafts the next policy version adding a minimum price for every product the
 * policy does not price yet (for example a newly added subscription). Deterministic,
 * no AI. A draft changes nothing until the owner anchors its hash on-chain.
 */
import { draftProductPricing } from "@/lib/server/policy-builder";
import { rateLimit } from "@/lib/server/rate-limit";
import { isOwnerSession } from "@/lib/server/wallet-auth";
import { fail, json } from "@/lib/server/http";

export async function POST(req: Request) {
  const limited = await rateLimit(req, "policy_draft", 10, 3600);
  if (limited) return limited;
  // Drafts change nothing until the owner signs on-chain, but only the owner may create or replace one.
  if (!(await isOwnerSession(req))) return fail(401, "Sign in as the owner to draft policy changes");
  try {
    const d = await draftProductPricing();
    return d ? json(d) : json({ note: "Every product is already priced in the policy" });
  } catch (e) {
    return fail(400, (e as Error).message);
  }
}
