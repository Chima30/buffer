import Link from "next/link";
import { WalletButton } from "./wallet";

export function SiteHeader() {
  return (
    <header className="flex items-center justify-between gap-4">
      <Link href="/" className="text-lg font-semibold tracking-tight">Buffer</Link>
      <nav className="flex items-center gap-4 text-sm text-ink-2">
        <Link href="/store" className="hover:text-ink">Store</Link>
        <Link href="/ledger" className="hover:text-ink">Ledger</Link>
        <Link href="/security" className="hover:text-ink">Security</Link>
        <Link href="/app" className="hover:text-ink">Owner</Link>
        <Link href="/new" className="hover:text-ink">Start</Link>
        <span className="hidden rounded-full border border-rule-strong px-2.5 py-0.5 font-mono text-xs sm:inline">NEAR testnet</span>
        <WalletButton />
      </nav>
    </header>
  );
}
