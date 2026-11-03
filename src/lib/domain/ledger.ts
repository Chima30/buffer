/**
 * Ledger entry status. REAL requires chain evidence (a verified tx hash).
 * QUOTE and SIMULATED can never carry a tx hash — enforced here and by a
 * database check constraint.
 */
export const LEDGER_STATUSES = ["REAL", "QUOTE", "SIMULATED", "PENDING", "FAILED"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export interface LedgerEntryInput {
  eventType: string;
  status: LedgerStatus;
  txHash?: string | null;
  verifiedOnChain?: boolean;
}

export function validateLedgerEntry(e: LedgerEntryInput): void {
  if ((e.status === "QUOTE" || e.status === "SIMULATED") && e.txHash) {
    throw new Error(`${e.status} entries cannot carry a transaction hash`);
  }
  if (e.status === "REAL" && (!e.txHash || !e.verifiedOnChain)) {
    throw new Error("REAL entries require a transaction hash verified on-chain");
  }
}

/** Intents settlement ladder shown in the UI. Only the first two occur on testnet. */
export const INTENTS_STATUSES = [
  "QUOTE_RECEIVED",
  "SETTLEMENT_SIMULATED",
  "SETTLEMENT_SUBMITTED",
  "SETTLEMENT_CONFIRMED",
  "SETTLEMENT_FAILED",
] as const;
export type IntentsStatus = (typeof INTENTS_STATUSES)[number];
