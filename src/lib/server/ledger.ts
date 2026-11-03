/**
 * The only way the app writes to the activity ledger. Validates the honesty
 * rules before insert (the database enforces them again).
 */
import { validateLedgerEntry, type LedgerStatus } from "@/lib/domain/ledger";
import { db } from "./db";
import { nearConfig } from "./env";

export interface LedgerWrite {
  businessId: string;
  orderId?: string | null;
  eventType: string;
  status: LedgerStatus;
  amountUnits?: bigint | null;
  counterparty?: string | null;
  txHash?: string | null;
  verifiedOnChain?: boolean;
  details?: Record<string, unknown>;
}

export async function writeLedger(e: LedgerWrite): Promise<void> {
  validateLedgerEntry({ eventType: e.eventType, status: e.status, txHash: e.txHash, verifiedOnChain: e.verifiedOnChain });
  const cfg = nearConfig();
  const { error } = await db()
    .from("ledger_entries")
    .insert({
      business_id: e.businessId,
      order_id: e.orderId ?? null,
      event_type: e.eventType,
      status: e.status,
      amount_units: e.amountUnits === undefined || e.amountUnits === null ? null : e.amountUnits.toString(),
      token_id: e.amountUnits === undefined || e.amountUnits === null ? null : cfg.usdcTokenId,
      counterparty: e.counterparty ?? null,
      tx_hash: e.txHash ?? null,
      explorer_url: e.txHash ? cfg.explorerTxUrl(e.txHash) : null,
      details: e.details ?? {},
    });
  if (error) throw new Error(`ledger insert failed: ${error.message}`);
}

export async function audit(businessId: string | null, actor: string, action: string, target: string | null, details: Record<string, unknown> = {}) {
  await db().from("audit_logs").insert({ business_id: businessId, actor, action, target, details });
}
