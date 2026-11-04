/** GET /api/products: active products with how their dataset vendor is paid. Public data only. */
import { connection } from "next/server";
import { loadBusiness, scopeFor } from "@/lib/server/business";
import { fail, json } from "@/lib/server/http";

export async function GET() {
  await connection();
  try {
    const ctx = await loadBusiness();
    return json({
      products: ctx.products.map((p) => {
        const { vendor } = scopeFor(ctx, p.id);
        return { sku: p.sku, title: p.title, description: p.description, priceUnits: p.price_units, vendor: { name: vendor.name, chain: vendor.chain } };
      }),
    });
  } catch (e) {
    return fail(500, (e as Error).message);
  }
}
