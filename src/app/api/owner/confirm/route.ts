/**
 * POST /api/owner/confirm { txHash }
 * Records an owner action AFTER verifying it on NEAR testnet. Accepted only if
 * the transaction was signed by the contract owner and emitted one of:
 *   buffer: purchase_approved (+ purchase_paid), purchase_rejected, paused, unpaused,
 *           policy_anchored, approval_threshold_set
 *   near-outlayer: WalletFrozenChanged for this agent's wallet
 * Anyone may submit a hash; a hash only ever proves what the owner already did.
 */
import { after } from "next/server";
import { z } from "zod";
import { runDueJobs } from "@/lib/server/agent/runtime";
import { db } from "@/lib/server/db";
import { nearConfig } from "@/lib/server/env";
import { fail, json } from "@/lib/server/http";
import { promoteAnchoredDraft } from "@/lib/server/business";
import { getConfig } from "@/lib/server/contract";
import { audit, writeLedger } from "@/lib/server/ledger";
import { parseEvents, verifyTransaction } from "@/lib/server/near-rpc";

export const maxDuration = 300;

const body = z.object({ txHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, "Not a NEAR transaction hash") });

export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Invalid request");
  const { txHash } = parsed.data;
  const near = nearConfig();

  const v = await verifyTransaction(txHash, near.ownerAccountId);
  if (v.state === "PENDING") return fail(202, "Transaction not final yet");
  if (v.state === "FAILED") return fail(400, `Transaction failed: ${v.reason}`);
  if (v.signerId !== near.ownerAccountId) return fail(403, "Transaction was not signed by the owner");

  const events = parseEvents(v.logs);
  const buffer = events.filter((e) => e.standard === "buffer").map((e) => ({ event: e.event, data: (Array.isArray(e.data) ? e.data[0] : e.data) as Record<string, unknown> }));
  const business = (await db().from("businesses").select("id").eq("contract_id", near.contractId).single()).data;
  if (!business) return fail(500, "Business not found");
  const already = await db().from("ledger_entries").select("id").eq("tx_hash", txHash).limit(1);
  if (already.data?.length) return json({ ok: true, note: "Already recorded" });

  const recorded: string[] = [];
  for (const e of buffer) {
    const orderRow = e.data.order_id ? (await db().from("orders").select("id").eq("onchain_order_id", String(e.data.order_id)).maybeSingle()).data : null;
    if (e.event === "purchase_approved") {
      await writeLedger({ businessId: business.id, orderId: orderRow?.id, eventType: "purchase_approved", status: "REAL", txHash, verifiedOnChain: true, counterparty: near.ownerAccountId });
      recorded.push(e.event);
    } else if (e.event === "purchase_paid") {
      await writeLedger({ businessId: business.id, orderId: orderRow?.id, eventType: "vendor_paid", status: "REAL", amountUnits: BigInt(String(e.data.amount)), counterparty: String(e.data.vendor), txHash, verifiedOnChain: true });
      recorded.push(e.event);
    } else if (e.event === "purchase_rejected") {
      await writeLedger({ businessId: business.id, orderId: orderRow?.id, eventType: "purchase_rejected_by_owner", status: "REAL", txHash, verifiedOnChain: true, counterparty: near.ownerAccountId });
      recorded.push(e.event);
    } else if (e.event === "policy_anchored") {
      const promoted = await promoteAnchoredDraft(business.id, await getConfig(), txHash);
      await writeLedger({ businessId: business.id, eventType: "policy_anchored", status: "REAL", txHash, verifiedOnChain: true, counterparty: near.ownerAccountId, details: { version: e.data.version, hash: e.data.hash, activated: promoted !== null } });
      recorded.push(e.event);
    } else if (e.event === "approval_threshold_set") {
      await writeLedger({ businessId: business.id, eventType: "approval_threshold_set", status: "REAL", amountUnits: BigInt(String(e.data.above)), txHash, verifiedOnChain: true, counterparty: near.ownerAccountId });
      recorded.push(e.event);
    } else if (e.event === "paused" || e.event === "unpaused") {
      await db().from("businesses").update({ status: e.event === "paused" ? "paused" : "active" }).eq("id", business.id);
      await writeLedger({ businessId: business.id, eventType: e.event === "paused" ? "business_paused" : "business_resumed", status: "REAL", txHash, verifiedOnChain: true, counterparty: near.ownerAccountId });
      recorded.push(e.event);
    }
  }

  const agent = (await db().from("agents").select("id,near_account").limit(1).single()).data;
  for (const e of events.filter((x) => x.standard === "near-outlayer")) {
    const changed = (Array.isArray(e.data) ? e.data[0] : e.data) as { WalletFrozenChanged?: { wallet_pubkey: string; frozen: boolean; owner: string } };
    const w = changed?.WalletFrozenChanged;
    if (!w || !agent || w.wallet_pubkey !== `ed25519:${agent.near_account}` || w.owner !== near.ownerAccountId) continue;
    await db().from("agents").update({ status: w.frozen ? "frozen" : "running" }).eq("id", agent.id);
    await writeLedger({ businessId: business.id, eventType: w.frozen ? "agent_wallet_frozen" : "agent_wallet_unfrozen", status: "REAL", txHash, verifiedOnChain: true, counterparty: near.ownerAccountId });
    recorded.push(w.frozen ? "agent_wallet_frozen" : "agent_wallet_unfrozen");
  }

  if (recorded.length === 0) return fail(400, "No owner action this app recognises in that transaction");
  await audit(business.id, near.ownerAccountId, "owner_action_recorded", txHash, { events: recorded });
  after(async () => {
    await runDueJobs(270_000);
  });
  return json({ ok: true, recorded });
}
