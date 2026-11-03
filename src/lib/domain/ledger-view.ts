/**
 * The ledger is append-only, so a PENDING entry is never edited. For display we
 * mark it resolved when a later entry for the same order closes it.
 */
const RESOLVES: Record<string, string[]> = {
  purchase_awaiting_approval: ["purchase_approved", "vendor_paid", "purchase_rejected", "purchase_rejected_by_owner", "purchase_failed"],
};

export interface LedgerLike {
  order_id?: string | null;
  event_type: string;
  status: string;
  at: string;
}

export function resolutionOf<T extends LedgerLike>(entry: T, all: T[]): T | null {
  if (entry.status !== "PENDING") return null;
  const closers = RESOLVES[entry.event_type];
  if (!closers) return null;
  return (
    all
      .filter((e) => e.order_id === entry.order_id && closers.includes(e.event_type) && e.at >= entry.at)
      .sort((a, b) => a.at.localeCompare(b.at))[0] ?? null
  );
}
