import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="flex items-center justify-between gap-4">
      <Link href="/" className="text-lg font-semibold tracking-tight">Buffer</Link>
      <nav className="flex items-center gap-4 text-sm text-ink-2">
        <Link href="/store" className="hover:text-ink">Store</Link>
        <Link href="/ledger" className="hover:text-ink">Ledger</Link>
        <span className="rounded-full border border-rule-strong px-2.5 py-0.5 font-mono text-xs">NEAR testnet</span>
      </nav>
    </header>
  );
}
