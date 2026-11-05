/**
 * Custom research quotes.
 *
 *   customer's request --(NEAR AI, private TEE)--> scope (depth, sections, needs data)
 *   --(priceQuote, deterministic)--> price, expense cap, breakdown
 *   --(agent: create_quote on the contract)--> the contract checks the owner's rules
 *   --> customer pays exactly that amount before it expires; then a normal order.
 *
 * The AI never sees or sets a price. The contract refuses any price or expense
 * cap outside the owner's limits, so a manipulated request cannot change them.
 */
import { randomBytes } from "node:crypto";
import { priceQuote, type Depth } from "@/lib/domain/quote";
import { formatUnits } from "@/lib/domain/money";
import { execContractCall } from "./agent/execute";
import { runInference } from "./agent/inference";
import { parseScope, scopeMessages } from "./agent/prompts";
import { evaluationContext, loadBusinessAnchored, scopeFor } from "./business";
import { getQuoteRules } from "./contract";
import { db, must } from "./db";
import { hashToken, newToken } from "./http";
import { writeLedger } from "./ledger";

/** Target business margin on quoted work (owner's choice for the testnet demo). */
export const QUOTE_MARGIN_BPS = 4000;
/** Quotes are open for a little under the contract's 30-minute limit, so clock drift never trips it. */
const QUOTE_OPEN_MS = 29 * 60_000;

export interface OrderQuote {
  summary: string;
  sections: string[];
  depth: Depth;
  needs_dataset: boolean;
  dataset_reason: string;
  breakdown: { data_units: string; ai_units: string; work_units: string; margin_units: string; rounding_units: string };
  max_expense_units: string;
  expires_at: string;
  quote_tx: string | null;
  clamped: "min" | "max" | null;
}

export class QuoteError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export async function createQuote(request: string, customerAccount: string | null): Promise<{ orderId: string; accessToken: string }> {
  const base = await loadBusinessAnchored().catch((e: Error) => {
    throw new QuoteError(`The business is not taking requests right now: ${e.message}`, 409);
  });
  const product = base.products.find((p) => p.kind === "quote");
  if (!product) throw new QuoteError("Custom research is not offered", 404);
  const rules = new Map((await getQuoteRules()) ?? []).get(product.sku);
  if (!rules?.active) throw new QuoteError("Custom quotes are not switched on in the contract yet", 409);
  const minPolicy = base.policy.rules.pricing.min_price_units[product.sku];
  if (minPolicy === undefined) throw new QuoteError("The signed policy does not price custom research yet", 409);
  const ctx = { ...base, ...scopeFor(base, product.id) };

  // The order row exists first so the scoping inference and its proof attach to it.
  const onchainOrderId = `q-${randomBytes(6).toString("hex")}`;
  const accessToken = newToken();
  const order = must(
    await db()
      .from("orders")
      .insert({
        business_id: ctx.business.id,
        product_id: product.id,
        brief: request,
        customer_account: customerAccount,
        state: "AWAITING_PAYMENT",
        price_units: rules.min_price,
        onchain_order_id: onchainOrderId,
        access_token_hash: hashToken(accessToken),
        deadline_at: new Date(Date.now() + QUOTE_OPEN_MS).toISOString(),
      })
      .select("id")
      .single(),
    "create quote order",
  );
  await db().from("order_transitions").insert({ order_id: order.id, from_state: null, to_state: "AWAITING_PAYMENT", reason: "custom request received; scoping" });

  const fail = async (reason: string, status = 502): Promise<never> => {
    await db().from("orders").update({ state: "FAILED", failure_reason: reason.slice(0, 300) }).eq("id", order.id);
    await db().from("order_transitions").insert({ order_id: order.id, from_state: "AWAITING_PAYMENT", to_state: "FAILED", reason: reason.slice(0, 200) });
    throw new QuoteError(reason, status);
  };

  let scope;
  try {
    const out = await runInference({
      ctx,
      evalCtx: await evaluationContext(ctx),
      orderId: order.id,
      purpose: "quote",
      messages: scopeMessages(request, { name: ctx.vendor.name, description: ctx.vendor.description ?? "Reference notes on NEAR agent infrastructure." }),
      maxTokens: 900,
      json: true,
      idempotencyKey: `${order.id}:quote`,
    });
    scope = parseScope(out.content);
  } catch (e) {
    return fail(`The agent could not scope the request: ${(e as Error).message}`);
  }

  const price = priceQuote(
    { depth: scope.depth, needsDataset: scope.needs_dataset },
    BigInt(ctx.vendor.unit_price_units),
    { minUnits: BigInt(rules.min_price), maxUnits: BigInt(rules.max_price), maxExpenseBps: rules.max_expense_bps, marginBps: QUOTE_MARGIN_BPS },
  );
  if (price.priceUnits < BigInt(minPolicy)) return fail("The quote would be below the policy's minimum price", 409);

  const expiresMs = Date.now() + QUOTE_OPEN_MS;
  const res = await execContractCall({
    method: "create_quote",
    args: { order_id: onchainOrderId, sku: product.sku, amount: price.priceUnits.toString(), max_expense: price.maxExpenseUnits.toString(), expires_ns: expiresMs * 1_000_000 },
    idempotencyKey: `${order.id}:create_quote`,
    agentAccount: ctx.agent.near_account,
    maxWaitMs: 60_000,
  });
  if (res.state === "PENDING") return fail("The contract did not confirm the quote in time; please ask again");
  if (res.state === "FAILED") return fail(`The contract refused the quote: ${res.reason.slice(0, 200)}`);

  const quote: OrderQuote = {
    summary: scope.summary,
    sections: scope.sections,
    depth: scope.depth,
    needs_dataset: scope.needs_dataset,
    dataset_reason: scope.dataset_reason,
    breakdown: {
      data_units: price.breakdown.dataUnits.toString(),
      ai_units: price.breakdown.aiUnits.toString(),
      work_units: price.breakdown.workUnits.toString(),
      margin_units: price.breakdown.marginUnits.toString(),
      rounding_units: price.breakdown.roundingUnits.toString(),
    },
    max_expense_units: price.maxExpenseUnits.toString(),
    expires_at: new Date(expiresMs).toISOString(),
    quote_tx: res.txHash,
    clamped: price.clamped,
  };
  must(
    await db()
      .from("orders")
      .update({
        price_units: price.priceUnits.toString(),
        quote,
        // The accepted scope is the plan: no second planning call after payment.
        plan: { title: scope.title, angles: scope.sections, use_dataset: scope.needs_dataset, dataset_reason: scope.dataset_reason, injection_detected: scope.injection_detected },
        deadline_at: quote.expires_at,
      })
      .eq("id", order.id)
      .select("id")
      .single(),
    "save quote",
  );
  await writeLedger({
    businessId: ctx.business.id,
    orderId: order.id,
    eventType: "quote_created",
    status: "REAL",
    amountUnits: price.priceUnits,
    txHash: res.txHash,
    verifiedOnChain: true,
    details: { depth: scope.depth, max_expense: formatUnits(price.maxExpenseUnits), expires_at: quote.expires_at },
  });
  return { orderId: order.id, accessToken };
}
