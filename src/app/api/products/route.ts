/** GET /api/products: active products with how their dataset vendor is paid, and the subscription plan if one is live. Public data only. */
import { connection } from "next/server";
import { loadBusiness, scopeFor } from "@/lib/server/business";
import { getSubscriptionPlans } from "@/lib/server/contract";
import { fail, json } from "@/lib/server/http";

export async function GET() {
  await connection();
  try {
    const ctx = await loadBusiness();
    const plans = new Map((await getSubscriptionPlans()) ?? []);
    return json({
      products: ctx.products
        .filter((p) => p.kind !== "subscription")
        .map((p) => {
          const { vendor } = scopeFor(ctx, p.id);
          return { sku: p.sku, title: p.title, description: p.description, priceUnits: p.price_units, vendor: { name: vendor.name, chain: vendor.chain } };
        }),
      // A subscription is offered only once the owner has switched its plan on in the contract.
      subscriptions: ctx.products
        .filter((p) => p.kind === "subscription" && plans.get(p.sku)?.active)
        .map((p) => {
          const plan = plans.get(p.sku)!;
          return { sku: p.sku, title: p.title, description: p.description, issuePriceUnits: p.price_units, intervalSeconds: Math.round(plan.interval_ns / 1e9), minIssues: plan.min_issues, maxIssues: plan.max_issues };
        }),
    });
  } catch (e) {
    return fail(500, (e as Error).message);
  }
}
