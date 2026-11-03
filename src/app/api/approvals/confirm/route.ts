/**
 * POST /api/approvals/confirm { txHash }
 * Records the owner's on-chain purchase approval in the ledger. Anyone may
 * submit a hash: it is only accepted if the transaction was signed by the
 * owner and the contract emitted purchase_approved and purchase_paid.
 */
import { z } from "zod";
import { after } from "next/server";
import { runDueJobs } from "@/lib/server/agent/runtime";
import { bufferEventsFromTx } from "@/lib/server/contract";
import { db } from "@/lib/server/db";
import { nearConfig } from "@/lib/server/env";
import { fail, json } from "@/lib/server/http";
import { writeLedger } from "@/lib/server/ledger";

export const maxDuration = 300;

const body = z.object({ txHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, "Not a NEAR transaction hash") });

export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Invalid request");
  const { txHash } = parsed.data;
  const near = nearConfig();

  const dup = await db().from("ledger_entries").select("id").eq("tx_hash", txHash).eq("event_type", "vendor_paid").maybeSingle();
  if (dup.data) return json({ ok: true, note: "Already recorded" });

  const v = await bufferEventsFromTx(txHash, near.ownerAccountId);
  if (v.state !== "SUCCESS") return fail(400, v.state === "PENDING" ? "Transaction not final yet" : `Transaction failed: ${v.reason}`);
  const approved = v.events.find((e) => e.event === "purchase_approved");
  const paid = v.events.find((e) => e.event === "purchase_paid");
  if (!approved) return fail(400, "No purchase approval by the owner in that transaction");

  const order = await db().from("orders").select("id,business_id").eq("onchain_order_id", String(approved.data.order_id)).maybeSingle();
  if (!order.data) return fail(404, "Order not found");

  await writeLedger({ businessId: order.data.business_id, orderId: order.data.id, eventType: "purchase_approved", status: "REAL", txHash, verifiedOnChain: true, counterparty: near.ownerAccountId });
  if (paid) {
    await writeLedger({ businessId: order.data.business_id, orderId: order.data.id, eventType: "vendor_paid", status: "REAL", amountUnits: BigInt(String(paid.data.amount)), counterparty: String(paid.data.vendor), txHash, verifiedOnChain: true });
  }
  after(async () => {
    await runDueJobs(270_000);
  });
  return json({ ok: true, paid: !!paid });
}
