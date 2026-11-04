/** GET /api/me/orders (header x-buffer-session) -> orders and subscriptions paid from the signed-in account. */
import { connection } from "next/server";
import { db, must } from "@/lib/server/db";
import { fail, json } from "@/lib/server/http";
import { sessionFrom } from "@/lib/server/wallet-auth";

export async function GET(req: Request) {
  await connection();
  const account = await sessionFrom(req);
  if (!account) return fail(401, "Sign in with your wallet");
  const [orders, subs] = await Promise.all([
    db().from("orders").select("id,onchain_order_id,state,price_units,plan,created_at,subscription_id,issue_number,products(title)").eq("customer_account", account).order("created_at", { ascending: false }).limit(100),
    db().from("subscriptions").select("id,onchain_subscription_id,state,issues_total,issues_started,issue_price_units,topic,created_at,products(title)").eq("customer_account", account).order("created_at", { ascending: false }).limit(50),
  ]);
  type O = { id: string; onchain_order_id: string; state: string; price_units: string; plan: { title?: string } | null; created_at: string; subscription_id: string | null; issue_number: number | null; products: { title: string } | null };
  type S = { id: string; onchain_subscription_id: string; state: string; issues_total: number; issues_started: number; issue_price_units: string; topic: string; created_at: string; products: { title: string } | null };
  return json({
    account,
    orders: must<O[]>(orders, "orders").map((o) => ({
      id: o.id,
      onchainId: o.onchain_order_id,
      state: o.state,
      priceUnits: String(o.price_units),
      title: o.plan?.title ?? o.products?.title ?? "Research brief",
      createdAt: o.created_at,
      subscriptionId: o.subscription_id,
      issue: o.issue_number,
    })),
    subscriptions: must<S[]>(subs, "subscriptions").map((s) => ({
      id: s.id,
      onchainId: s.onchain_subscription_id,
      state: s.state,
      issuesTotal: s.issues_total,
      issuesStarted: s.issues_started,
      totalUnits: (BigInt(s.issue_price_units) * BigInt(s.issues_total)).toString(),
      title: s.products?.title ?? "Subscription",
      topic: s.topic,
      createdAt: s.created_at,
    })),
  });
}
