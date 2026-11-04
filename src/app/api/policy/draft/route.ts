/**
 * POST /api/policy/draft { text }
 * Turns the owner's plain-English rules into a policy draft: NEAR AI translates,
 * deterministic code applies, checks and hashes it. A draft does nothing until
 * the owner anchors its hash on-chain, so this endpoint cannot change the rules
 * by itself. It is capped per day because each draft spends inference credit.
 */
import { z } from "zod";
import { draftPolicy } from "@/lib/server/policy-builder";
import { rateLimit } from "@/lib/server/rate-limit";
import { fail, json } from "@/lib/server/http";

export const maxDuration = 60;

const body = z.object({ text: z.string().trim().min(5, "Describe at least one rule").max(1000, "Keep it under 1000 characters") });

export async function POST(req: Request) {
  const limited = await rateLimit(req, "policy_draft", 10, 3600);
  if (limited) return limited;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Invalid request");
  try {
    return json(await draftPolicy(parsed.data.text));
  } catch (e) {
    return fail(400, (e as Error).message);
  }
}
