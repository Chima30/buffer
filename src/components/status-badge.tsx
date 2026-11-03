import type { LedgerStatus } from "@/lib/domain/ledger";

const STYLES: Record<LedgerStatus, { label: string; icon: string; className: string; hint: string }> = {
  REAL: { label: "Real", icon: "●", className: "bg-real-soft text-real", hint: "Confirmed on NEAR testnet" },
  QUOTE: { label: "Quote", icon: "◇", className: "bg-quote-soft text-quote", hint: "Live price only. No funds moved" },
  SIMULATED: { label: "Simulated", icon: "◌", className: "bg-simulated-soft text-simulated hatched", hint: "No testnet settlement exists. Nothing happened on-chain" },
  PENDING: { label: "Pending", icon: "◐", className: "bg-pending-soft text-pending", hint: "Waiting for confirmation" },
  FAILED: { label: "Failed", icon: "✕", className: "bg-failed-soft text-failed", hint: "Did not complete" },
};

export function StatusBadge({ status }: { status: LedgerStatus }) {
  const s = STYLES[status];
  return (
    <span
      title={s.hint}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${s.className}`}
    >
      <span aria-hidden>{s.icon}</span>
      {s.label}
      <span className="sr-only">: {s.hint}</span>
    </span>
  );
}
