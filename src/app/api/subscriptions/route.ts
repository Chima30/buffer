/**
 * POST /api/subscriptions  { topic, issues, customerAccount? }
 * Creates a subscription awaiting payment and returns the exact single payment
 * (ft_transfer_call) that prepays every issue into the contract.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { loadBusiness } from "@/lib/server/business";
import { getSubscriptionPlans } from "@/lib/server/contract";
import { db, must } from "@/lib/server/db";
import { rateLimit } from "@/lib/server/rate-limit";
import { fail, hashToken, json, newToken } from "@/lib/server/http";

const body = z.object({
  topic: z.string().trim().min(10, "Describe the topic (at least 10 characters)").max(2000),
  issues: z.number().int().min(1).max(52),
  customerAccount: z
    .string()
    .trim()
    .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "Not a valid NEAR account id")
    .max(64)
    .optional(),
  sku: z.string().trim().max(64).optional(),
});

export async function POST(req: Request) {
  const limited = await rateLimit(req, "subscriptions", 20, 3600);
  if (limited) return limited;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Invalid request");

  const ctx = await loadBusiness();
  if (ctx.business.status !== "active") return fail(409, "The business is paused and not taking subscriptions");
  const product = ctx.products.find((p) => p.kind === "subscription" && (!parsed.data.sku || p.sku === parsed.data.sku));
  if (!product) return fail(404, "No subscription product");
  const plan = new Map((await getSubscriptionPlans()) ?? []).get(product.sku);
  if (!plan?.active) return fail(409, "Subscriptions are not switched on in the contract yet");
  const { issues } = parsed.data;
  if (issues < plan.min_issues || issues > plan.max_issues) return fail(400, `Choose ${plan.min_issues} to ${plan.max_issues} issues`);

  const onchainId = `s-${randomBytes(6).toString("hex")}`;
  const accessToken = newToken();
  const total = BigInt(product.price_units) * BigInt(issues);
  const sub = must(
    await db()
      .from("subscriptions")
      .insert({
        business_id: ctx.business.id,
        product_id: product.id,
        topic: parsed.data.topic,
        customer_account: parsed.data.customerAccount ?? null,
        issues_total: issues,
        issue_price_units: product.price_units,
        onchain_subscription_id: onchainId,
        access_token_hash: hashToken(accessToken),
      })
      .select("id")
      .single(),
    "create subscription",
  );
  return json({ subscriptionId: sub.id, accessToken, onchainSubscriptionId: onchainId, totalUnits: total.toString() });
}
