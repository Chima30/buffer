/**
 * POST /api/orders  { brief, customerAccount? } -> creates an order awaiting payment.
 * Returns the order id, a private access token for the order page, and the
 * exact payment the customer must send (ft_transfer_call to the contract).
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { loadBusiness } from "@/lib/server/business";
import { db, must } from "@/lib/server/db";
import { nearConfig } from "@/lib/server/env";
import { fail, hashToken, json, newToken } from "@/lib/server/http";

const body = z.object({
  brief: z.string().trim().min(10, "Describe what you want researched (at least 10 characters)").max(4000),
  customerAccount: z
    .string()
    .trim()
    .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "Not a valid NEAR account id")
    .max(64)
    .optional(),
});

export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Invalid request");

  const ctx = await loadBusiness();
  if (ctx.business.status !== "active") return fail(409, "The business is paused and not taking orders");

  const near = nearConfig();
  const onchainOrderId = `o-${randomBytes(6).toString("hex")}`;
  const accessToken = newToken();
  const order = must(
    await db()
      .from("orders")
      .insert({
        business_id: ctx.business.id,
        product_id: ctx.product.id,
        brief: parsed.data.brief,
        customer_account: parsed.data.customerAccount ?? null,
        state: "AWAITING_PAYMENT",
        price_units: ctx.product.price_units,
        onchain_order_id: onchainOrderId,
        access_token_hash: hashToken(accessToken),
        deadline_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
      })
      .select("id")
      .single(),
    "create order",
  );
  await db().from("order_transitions").insert({ order_id: order.id, from_state: null, to_state: "AWAITING_PAYMENT", reason: "order created" });

  const msg = JSON.stringify({ order_id: onchainOrderId, sku: ctx.product.sku });
  const payer = parsed.data.customerAccount ?? "<your-account>.testnet";
  const escapedMsg = msg.replace(/"/g, '\\\\\\"');
  return json({
    orderId: order.id,
    accessToken,
    onchainOrderId,
    payment: {
      tokenContract: near.usdcTokenId,
      method: "ft_transfer_call",
      args: { receiver_id: near.contractId, amount: ctx.product.price_units, msg },
      attachedDeposit: "1 yoctoNEAR",
      gas: "100 Tgas",
    },
    // For testnet users paying from near-cli in Windows PowerShell (the --% keeps quotes intact).
    nearCliCommand: `near --% contract call-function as-transaction ${near.usdcTokenId} ft_transfer_call json-args "{\\"receiver_id\\":\\"${near.contractId}\\",\\"amount\\":\\"${ctx.product.price_units}\\",\\"msg\\":\\"${escapedMsg}\\"}" prepaid-gas "100 Tgas" attached-deposit "1 yoctoNEAR" sign-as ${payer} network-config testnet sign-with-keychain send`,
  });
}
