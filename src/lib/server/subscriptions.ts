/**
 * Subscriptions: the customer prepays N issues into the contract once. When an
 * issue is due, the agent asks the contract to open it (`start_issue`), which
 * moves exactly one issue's price from the subscription escrow into a new
 * ordinary order. From there the issue runs the normal pipeline: policy,
 * TEE-signed inference, report hash, settlement and the reserve.
 *
 * The contract decides what is due; this module only asks and records what the
 * chain confirmed. Cancellation is signed by the customer or owner, never here.
 */
import { enqueue } from "./agent/runtime";
import { execContractCall } from "./agent/execute";
import { HaltError, loadBusinessAnchored } from "./business";
import { getSubscription, type OnchainSubscription } from "./contract";
import { db, must } from "./db";
import { nearConfig } from "./env";
import { audit, writeLedger } from "./ledger";

export interface SubscriptionRow {
  id: string;
  business_id: string;
  product_id: string;
  topic: string;
  customer_account: string | null;
  state: "AWAITING_PAYMENT" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  issues_total: number;
  issues_started: number;
  issue_price_units: string;
  onchain_subscription_id: string;
  access_token_hash: string;
  next_due_at: string | null;
  refund_units: string | null;
  refund_status: "Pending" | "Confirmed" | "Failed" | null;
}

const COLS = "id,business_id,product_id,topic,customer_account,state,issues_total,issues_started,issue_price_units,onchain_subscription_id,access_token_hash,next_due_at,refund_units,refund_status";
const nsToIso = (ns: number) => new Date(Math.floor(ns / 1e6)).toISOString();

/** The brief for issue `n`: the customer's topic plus what earlier issues covered, so each picks up where the last left off. */
export function issueBrief(topic: string, n: number, total: number, earlier: string[]): string {
  const history = earlier.length ? ` Earlier issues: ${earlier.map((t) => `"${t}"`).join("; ")}. Focus on what is new or changed since then and do not repeat them.` : "";
  return `${topic}\n\n(Issue ${n} of ${total} of a subscription.${history})`.slice(0, 4000);
}

/** Brings a subscription row in line with the contract (cancellations, refunds, completed issues). */
export async function reconcile(sub: SubscriptionRow, onchain: OnchainSubscription | null = null): Promise<SubscriptionRow> {
  const c = onchain ?? (await getSubscription(sub.onchain_subscription_id));
  if (!c) return sub;
  const patch: Partial<SubscriptionRow> = {};
  if (c.state === "Cancelled" && sub.state !== "CANCELLED") patch.state = "CANCELLED";
  if (c.state === "Completed" && sub.state === "ACTIVE" && sub.issues_started >= sub.issues_total) patch.state = "COMPLETED";
  if (c.refund && (c.refund.status !== sub.refund_status || c.refund.amount !== sub.refund_units)) {
    patch.refund_units = c.refund.amount;
    patch.refund_status = c.refund.status;
  }
  // Only follow the chain's due time once every issue it opened is recorded here.
  if (c.state === "Active" && c.issues_started <= sub.issues_started) patch.next_due_at = nsToIso(c.next_due_ns);
  if (Object.keys(patch).length === 0) return sub;
  await db().from("subscriptions").update(patch).eq("id", sub.id);
  if (patch.state === "CANCELLED") await audit(sub.business_id, "runtime", "subscription_cancelled", sub.id, { refund_units: c.refund?.amount ?? "0" });
  return { ...sub, ...patch };
}

/** Opens one due issue. Returns the new order id, or null if nothing was opened. */
async function openIssue(sub: SubscriptionRow, agentAccount: string): Promise<string | null> {
  const n = sub.issues_started + 1;
  const res = await execContractCall({
    method: "start_issue",
    args: { subscription_id: sub.onchain_subscription_id },
    // Same key on every retry: OutLayer returns the same request, so an issue is never opened twice.
    idempotencyKey: `${sub.id}:issue:${n}`,
    agentAccount,
  });
  if (res.state === "PENDING") return null;
  if (res.state === "FAILED") {
    await db().from("subscriptions").update({ last_error: res.reason.slice(0, 500) }).eq("id", sub.id);
    // The chain is the judge of "due": refresh our copy so we do not retry early.
    await reconcile(sub);
    return null;
  }
  const ev = res.events.find((e) => e.event === "issue_started" && e.data.subscription_id === sub.onchain_subscription_id);
  if (!ev || Number(ev.data.issue) !== n) {
    await audit(sub.business_id, "runtime", "issue_event_missing", sub.id, { tx: res.txHash });
    return null;
  }
  const orderId = String(ev.data.order_id);
  const earlier = must<{ plan: { title?: string } | null }[]>(
    await db().from("orders").select("plan").eq("subscription_id", sub.id).order("issue_number"),
    "earlier issues",
  )
    .map((o) => o.plan?.title)
    .filter((t): t is string => !!t);

  const order = must(
    await db()
      .from("orders")
      .insert({
        business_id: sub.business_id,
        product_id: sub.product_id,
        brief: issueBrief(sub.topic, n, sub.issues_total, earlier),
        customer_account: sub.customer_account,
        state: "PAID",
        price_units: sub.issue_price_units,
        onchain_order_id: orderId,
        // The subscription's token opens every issue page.
        access_token_hash: sub.access_token_hash,
        deadline_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
        subscription_id: sub.id,
        issue_number: n,
      })
      .select("id")
      .single(),
    "create issue order",
  );
  await db().from("order_transitions").insert({ order_id: order.id, from_state: null, to_state: "PAID", reason: `issue ${n} of ${sub.issues_total} opened from the subscription escrow` });
  // The customer's prepayment becomes revenue for this order only now, one issue at a time.
  await db().from("payments").insert({ order_id: order.id, status: "VERIFIED", token_id: nearConfig().usdcTokenId, amount_units: sub.issue_price_units, sender_account: sub.customer_account ?? "subscription", tx_hash: res.txHash, verified_at: new Date().toISOString() });
  await writeLedger({ businessId: sub.business_id, orderId: order.id, eventType: "issue_started", status: "REAL", amountUnits: BigInt(sub.issue_price_units), counterparty: sub.customer_account, txHash: res.txHash, verifiedOnChain: true, details: { subscription: sub.onchain_subscription_id, issue: n, of: sub.issues_total } });
  await db()
    .from("subscriptions")
    .update({ issues_started: n, state: n >= sub.issues_total ? "COMPLETED" : "ACTIVE", next_due_at: nsToIso(Number(ev.data.next_due_ns)), last_error: null })
    .eq("id", sub.id);
  // If the customer cancelled after this issue opened, the chain wins.
  await reconcile({ ...sub, issues_started: n, state: n >= sub.issues_total ? "COMPLETED" : "ACTIVE" });
  await enqueue(order.id, "plan");
  return order.id;
}

/** Called every runtime tick: opens issues the contract says are due. */
export async function runSubscriptions(limit = 5): Promise<{ opened: number }> {
  const due = must<SubscriptionRow[]>(
    await db().from("subscriptions").select(COLS).eq("state", "ACTIVE").lte("next_due_at", new Date().toISOString()).order("next_due_at").limit(limit),
    "due subscriptions",
  );
  // Cancelled ones with a refund still in flight: keep their status current.
  const refunding = must<SubscriptionRow[]>(await db().from("subscriptions").select(COLS).eq("state", "CANCELLED").eq("refund_status", "Pending").limit(limit), "refunding");
  for (const s of refunding) await reconcile(s);
  if (due.length === 0) return { opened: 0 };

  let ctx;
  try {
    ctx = await loadBusinessAnchored();
  } catch (e) {
    if (e instanceof HaltError) return { opened: 0 }; // paused or policy not anchored: wait
    throw e;
  }
  let opened = 0;
  for (const s of due) {
    // Never open an issue the policy would not let the agent deliver: the prepayment stays in escrow.
    const product = ctx.products.find((p) => p.id === s.product_id);
    if (!product || ctx.policy.rules.pricing.min_price_units[product.sku] === undefined) {
      await db().from("subscriptions").update({ last_error: "Waiting: the active policy does not price this product yet" }).eq("id", s.id);
      continue;
    }
    const chain = await getSubscription(s.onchain_subscription_id);
    // An issue the chain opened but we never recorded: replay the same idempotent call to record it.
    const behind = !!chain && chain.issues_started > s.issues_started;
    const sub = await reconcile(s, chain);
    if (!behind) {
      if (sub.state !== "ACTIVE" || sub.issues_started >= sub.issues_total) continue;
      if (sub.next_due_at && new Date(sub.next_due_at).getTime() > Date.now()) continue;
    }
    if (await openIssue(s, ctx.agent.near_account)) opened++;
  }
  return { opened };
}
