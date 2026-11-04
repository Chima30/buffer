import Link from "next/link";
import { Money } from "@/components/money";
import { SiteHeader } from "@/components/site-header";
import { StatusBadge } from "@/components/status-badge";
import { LEDGER_STATUSES } from "@/lib/domain/ledger";
import { toUnits } from "@/lib/domain/money";
import { computeSettlement } from "@/lib/domain/revenue";

// A worked example computed by the same engine the contract mirrors. Labelled as an example, not activity.
const example = computeSettlement({
  gross: toUnits("20"),
  maxExpense: toUnits("13"),
  contributorBps: 3000,
  expenses: [
    { id: "dataset", category: "supplier", amount: toUnits("12"), status: "PAID", evidenceRef: "tx" },
    { id: "inference", category: "inference", amount: toUnits("0.4"), status: "METERED", evidenceRef: "chat" },
  ],
});

const steps = [
  ["Order", "A customer orders a research report and writes a brief."],
  ["Payment", "Testnet USDC goes straight to the business contract, not to the agent."],
  ["Work", "The agent plans and has the contract pay an approved vendor, on NEAR or on Ethereum through Chain Signatures."],
  ["Delivery", "The report ships with the TEE's signature and NVIDIA's verdict on the GPU that produced it."],
  ["Settlement", "The contract deducts expenses, then splits net revenue 70/30."],
] as const;

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10 sm:py-16">
      <SiteHeader />

      <section className="mt-14 max-w-3xl">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Humans set the rules. Agents run the business.</h1>
        <p className="mt-5 text-lg leading-relaxed text-ink-2">
          Buffer lets an AI agent operate a business on NEAR, selling, buying, delivering and paying out revenue,
          while code it cannot change enforces the owner&apos;s limits on every transaction.
        </p>
        <p className="mt-3 text-ink-3">First business: the Verified Research Desk.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/store" className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper">Order a research brief</Link>
          <Link href="/ledger" className="rounded-md border border-rule-strong px-4 py-2 text-sm">View the public ledger</Link>
          <Link href="/security" className="rounded-md border border-rule-strong px-4 py-2 text-sm">See the attacks we block</Link>
          <Link href="/new" className="rounded-md border border-rule-strong px-4 py-2 text-sm">Start your own business</Link>
        </div>
      </section>

      <section className="mt-14 grid gap-px overflow-hidden rounded-[var(--radius-card)] border border-rule bg-rule sm:grid-cols-5">
        {steps.map(([title, body], i) => (
          <div key={title} className="bg-surface p-4">
            <div className="font-mono text-xs text-ink-3">0{i + 1}</div>
            <div className="mt-1 font-medium">{title}</div>
            <p className="mt-1 text-sm leading-snug text-ink-2">{body}</p>
          </div>
        ))}
      </section>

      <section className="mt-14 grid gap-8 lg:grid-cols-[1.2fr_1fr]">
        <div className="rounded-[var(--radius-card)] border border-rule bg-surface">
          <div className="border-b border-rule px-5 py-3">
            <h2 className="font-medium">How revenue is split</h2>
            <p className="text-sm text-ink-3">Worked example, computed by the settlement engine. Not live activity.</p>
          </div>
          <dl className="divide-y divide-rule text-sm">
            {[
              ["Gross paid by customer", example.gross],
              ["Approved expenses (capped)", example.expensesCounted],
              ["Distributable (net)", example.distributable],
              ["Owner, 70%", example.ownerShare],
              ["Contributor, 30%", example.contributorShare],
              ["Paid to vendor from escrow (dataset)", example.paidToVendors],
              ["Reimbursed to owner (inference credits)", example.reimbOwner],
            ].map(([label, units]) => (
              <div key={label as string} className="flex items-center justify-between px-5 py-2.5">
                <dt className="text-ink-2">{label as string}</dt>
                <dd><Money units={units as bigint} /></dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="rounded-[var(--radius-card)] border border-rule bg-surface p-5">
          <h2 className="font-medium">Every record says what it is</h2>
          <p className="mt-1 text-sm text-ink-3">Buffer never presents a quote or a simulation as a transaction.</p>
          <ul className="mt-4 space-y-3">
            {LEDGER_STATUSES.map((s) => (
              <li key={s} className="flex items-center gap-3 text-sm">
                <StatusBadge status={s} />
                <span className="text-ink-2">
                  {{
                    REAL: "Confirmed on NEAR testnet or Ethereum Sepolia, with an explorer link.",
                    QUOTE: "A live NEAR Intents price. No funds moved.",
                    SIMULATED: "NEAR Intents has no testnet, so an Intents settlement is shown, not performed.",
                    PENDING: "Submitted, waiting for confirmation.",
                    FAILED: "Did not complete. Nothing is assumed.",
                  }[s]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <footer className="mt-16 border-t border-rule pt-6 text-sm text-ink-3">
        Built at NEAR HACKATHON 2026. Testnet only. No real funds.
      </footer>
    </main>
  );
}
