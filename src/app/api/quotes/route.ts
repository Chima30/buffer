/**
 * POST /api/quotes { request, customerAccount? }
 * The agent scopes a custom request with private inference, code prices it, and
 * the agent registers the quote on the contract, which checks the owner's limits.
 * Returns the order to pay. Takes about half a minute.
 */
import { z } from "zod";
import { db } from "@/lib/server/db";
import { rateLimit } from "@/lib/server/rate-limit";
import { fail, json } from "@/lib/server/http";
import { createQuote, QuoteError } from "@/lib/server/quotes";

export const maxDuration = 120;

const body = z.object({
  request: z.string().trim().min(20, "Describe what you need (at least 20 characters)").max(4000),
  customerAccount: z
    .string()
    .trim()
    .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "Not a valid NEAR account id")
    .max(64)
    .optional(),
});

export async function POST(req: Request) {
  // Each quote spends inference and an on-chain call, paid or not: keep it tight.
  const limited = await rateLimit(req, "quotes", 8, 3600);
  if (limited) return limited;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Invalid request");
  const today = await db().from("orders").select("id", { count: "exact", head: true }).not("quote", "is", null).gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString());
  if ((today.count ?? 0) >= 150) return fail(503, "Too many quotes today; please try again tomorrow");
  try {
    return json(await createQuote(parsed.data.request, parsed.data.customerAccount ?? null));
  } catch (e) {
    if (e instanceof QuoteError) return fail(e.status, e.message);
    return fail(500, (e as Error).message);
  }
}
