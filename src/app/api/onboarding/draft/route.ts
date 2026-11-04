/**
 * POST /api/onboarding/draft  -> a complete plan for a new Buffer business.
 * Creates nothing and signs nothing: it returns the starting policy and its hash,
 * the contract's init arguments and the owner's launch checklist. If the owner
 * wrote rules in English, private TEE inference translates them first (capped per day).
 */
import { baselinePolicy, buildBusinessDraft, businessDraftInput } from "@/lib/domain/business-draft";
import { fail, json } from "@/lib/server/http";
import { translateRules } from "@/lib/server/policy-builder";
import { rateLimit } from "@/lib/server/rate-limit";

export const maxDuration = 60;

export async function POST(req: Request) {
  const limited = await rateLimit(req, "onboarding", 30, 3600);
  if (limited) return limited;
  const parsed = businessDraftInput.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return fail(400, `${i?.path.join(".") || "form"}: ${i?.message ?? "invalid"}`);
  }
  try {
    let edit = null;
    let translation: { verification: string; unsupported: string[] } | null = null;
    if (parsed.data.rules) {
      const t = await translateRules(parsed.data.rules, baselinePolicy(parsed.data), "onboarding_draft");
      if (!t.edit) return fail(400, t.error ?? "Could not translate the rules");
      edit = t.edit;
      translation = { verification: t.verification, unsupported: t.edit.unsupported };
    }
    return json({ ...buildBusinessDraft(parsed.data, edit), translation });
  } catch (e) {
    return fail(400, (e as Error).message);
  }
}
