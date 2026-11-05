import { ArrowRight, BookText, ShieldCheck, Terminal } from "lucide-react";
import Link from "next/link";
import { MoneyFlow } from "@/components/money-flow";
import { StatusBadge } from "@/components/status-badge";
import { LEDGER_STATUSES } from "@/lib/domain/ledger";

// A real, settled order (o-91336486ee60). Every figure below is on NEAR testnet and
// Ethereum Sepolia; `npm run verify` re-derives each one from the chains.
const ORDER = "o-91336486ee60";
const FLOW = [
  {
    label: "Costs",
    leaves: [
      { label: "Data vendor", units: 12_000_000n, color: "chain" as const, note: "Paid on Sepolia via Chain Signatures" },
      { label: "AI inference", units: 3_045n, color: "ai" as const, note: "TEE-signed, GPU verified by NVIDIA" },
    ],
  },
  {
    label: "Net revenue",
    leaves: [
      { label: "Owner, 70%", units: 5_597_869n, color: "owner" as const },
      { label: "Contributor, 30%", units: 2_399_086n, color: "contrib" as const },
    ],
  },
];

const STEPS = [
  ["Order", "A customer pays the price (fixed, quoted or a prepaid subscription) into the business contract, not to the agent"],
  ["Plan", "The agent plans with private inference and decides whether data would help"],
  ["Buy", "Vendors on NEAR and five EVM chains compete; the contract pays the cheapest, within the owner's cap"],
  ["Deliver", "The report's hash is recorded on-chain, with the TEE signature behind it"],
  ["Settle", "Costs come off first, then the contract splits net revenue 70/30"],
] as const;

const PROOF = [
  { href: "/ledger", icon: BookText, title: "Public ledger", body: "Every payment, purchase and payout, each with its transaction" },
  { href: "/security", icon: ShieldCheck, title: "7 of 7 attacks blocked", body: "Prompt injection, hijacked agent, rewritten rules, all run live" },
  { href: "https://github.com/Chima30/buffer#check-it-in-five-minutes", icon: Terminal, title: "npm run verify", body: "Re-check any order from public chains, no keys needed" },
] as const;

export default function Home() {
  return (
    <main className="enter space-y-16">
      <section className="grid items-center gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div>
          <p className="text-sm text-ink-3">Verified Research Desk, live on NEAR testnet</p>
          <h1 className="mt-4 text-4xl font-medium leading-[1.05] tracking-[-0.03em] sm:text-[52px]">Humans set the rules. Agents run the business.</h1>
          <p className="mt-5 max-w-[34rem] text-lg leading-[1.6] text-ink-2">
            An AI agent sells research briefs, buys the data it needs and pays its team. A NEAR contract holds the money and enforces the owner&apos;s limits on every payment.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/store" className="press inline-flex h-11 items-center gap-2 rounded-lg bg-ink px-5 text-sm font-medium text-paper transition-opacity duration-150 hover:opacity-90">
              Order a brief <ArrowRight size={16} strokeWidth={1.5} />
            </Link>
            <Link href="/new" className="press inline-flex h-11 items-center rounded-lg border border-rule-strong bg-surface px-5 text-sm transition-colors duration-150 hover:bg-raised">
              Start your own business
            </Link>
          </div>
        </div>

        <MoneyFlow
          title="Where one order's 20 USDC went"
          sourceLabel="Customer paid"
          caption={<>Order <span className="font-mono">{ORDER}</span>, settled on-chain. Every line is a real transaction</>}
          groups={FLOW}
        />
      </section>

      <section>
        <h2 className="text-sm text-ink-3">How an order runs</h2>
        <ol className="mt-4 grid gap-px overflow-hidden rounded-[var(--radius-card)] border border-rule bg-rule sm:grid-cols-5">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="bg-surface p-5">
              <span className="font-mono text-xs text-ink-3">0{i + 1}</span>
              <p className="mt-2 font-medium">{title}</p>
              <p className="mt-1 text-sm leading-[1.5] text-ink-2">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <div>
          <h2 className="text-sm text-ink-3">Check it yourself</h2>
          <ul className="mt-4 space-y-3">
            {PROOF.map(({ href, icon: Icon, title, body }) => (
              <li key={title}>
                <Link href={href} className="group flex items-center gap-4 rounded-[var(--radius-card)] border border-rule bg-surface p-4 transition-colors duration-150 hover:bg-raised">
                  <Icon size={18} strokeWidth={1.5} className="shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{title}</span>
                    <span className="block text-sm text-ink-2">{body}</span>
                  </span>
                  <ArrowRight size={16} strokeWidth={1.5} className="shrink-0 text-ink-3 transition-transform duration-150 group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="text-sm text-ink-3">Every record says what it is</h2>
          <ul className="mt-4 space-y-3 rounded-[var(--radius-card)] border border-rule bg-surface p-5">
            {LEDGER_STATUSES.map((s) => (
              <li key={s} className="grid grid-cols-[96px_1fr] items-start gap-3 text-sm">
                <span><StatusBadge status={s} /></span>
                <span className="text-ink-2">
                  {{
                    REAL: "Confirmed on NEAR testnet or Ethereum Sepolia, with a link",
                    QUOTE: "A live NEAR Intents price. No funds moved",
                    SIMULATED: "Shown, not performed: NEAR Intents has no testnet",
                    PENDING: "Submitted, waiting for confirmation",
                    FAILED: "Did not complete. Nothing is assumed",
                  }[s]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <footer className="border-t border-rule pt-6 text-sm text-ink-3">Testnet only. No real funds.</footer>
    </main>
  );
}
