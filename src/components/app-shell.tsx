"use client";

import { BookText, Menu, PlusSquare, ShieldCheck, ShoppingBag, SlidersHorizontal, X, History } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useState } from "react";
import { ThemeToggle } from "./theme-toggle";
import { WalletButton } from "./wallet";

const NAV = [
  { href: "/new", label: "Start", icon: PlusSquare },
  { href: "/store", label: "Store", icon: ShoppingBag },
  { href: "/me", label: "My orders", icon: History },
  { href: "/ledger", label: "Ledger", icon: BookText },
  { href: "/security", label: "Security", icon: ShieldCheck },
  { href: "/app", label: "Owner", icon: SlidersHorizontal },
] as const;

/** Buffer's mark: a value held between two rules. */
export function Mark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden className="shrink-0">
      <rect x="1" y="2" width="18" height="2" rx="1" className="fill-ink" />
      <rect x="1" y="16" width="18" height="2" rx="1" className="fill-ink" />
      <rect x="5" y="8" width="10" height="4" rx="1" className="fill-accent" />
    </svg>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  return <NavList active={path} onNavigate={onNavigate} />;
}

function NavList({ active, onNavigate }: { active: string | null; onNavigate?: () => void }) {
  return (
    <ul className="space-y-1">
      {NAV.map(({ href, label, icon: Icon }) => {
        const on = active === href || (href === "/store" && (active?.startsWith("/orders") || active?.startsWith("/subscriptions")));
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={on ? "page" : undefined}
              className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors duration-150 ${on ? "bg-raised text-ink shadow-[var(--highlight)]" : "text-ink-2 hover:bg-raised/60 hover:text-ink"}`}
            >
              <Icon size={16} strokeWidth={1.5} className={on ? "text-ink" : "text-ink-3"} />
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Network() {
  return (
    <div className="flex items-center gap-2 font-mono text-xs text-ink-3">
      <span className="h-1.5 w-1.5 rounded-full bg-real" aria-hidden />
      NEAR testnet
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-rule bg-sidebar lg:flex">
        <Link href="/" className="flex h-16 items-center gap-2.5 px-5">
          <Mark />
          <span className="text-[17px] font-medium tracking-tight">Buffer</span>
        </Link>
        {/* Wallet first: it decides what you can see and sign everywhere else. */}
        <div className="px-5 pb-4">
          <WalletButton />
        </div>
        <div className="px-3">
          <p className="px-2.5 pb-2 text-xs text-ink-3">Verified Research Desk</p>
          <Suspense fallback={<NavList active={null} />}>
            <NavLinks />
          </Suspense>
        </div>
        <div className="mt-auto border-t border-rule px-5 py-4">
          <Network />
        </div>
        {/* The theme switch sits on the sidebar's edge, half in and half out. */}
        <ThemeToggle className="absolute -right-4 top-20" />
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-rule bg-sidebar/95 px-4 backdrop-blur lg:hidden">
        <Link href="/" className="flex items-center gap-2">
          <Mark />
          <span className="font-medium tracking-tight">Buffer</span>
        </Link>
        <div className="flex items-center gap-2">
          <div className="w-36">
            <WalletButton />
          </div>
          <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="grid h-9 w-9 place-items-center rounded-lg text-ink-2 hover:bg-raised">
            <Menu size={18} strokeWidth={1.5} />
          </button>
        </div>
        <ThemeToggle className="absolute -bottom-4 right-6" />
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <button aria-label="Close menu" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/40" />
          <div className="enter absolute inset-y-0 left-0 flex w-72 flex-col border-r border-rule bg-sidebar p-4">
            <div className="flex h-10 items-center justify-between">
              <span className="flex items-center gap-2 font-medium"><Mark /> Buffer</span>
              <button onClick={() => setOpen(false)} aria-label="Close menu" className="grid h-9 w-9 place-items-center rounded-lg text-ink-2 hover:bg-raised">
                <X size={18} strokeWidth={1.5} />
              </button>
            </div>
            <div className="mt-4">
              <Suspense fallback={<NavList active={null} />}>
                <NavLinks onNavigate={() => setOpen(false)} />
              </Suspense>
            </div>
            <div className="mt-auto border-t border-rule pt-4">
              <Network />
            </div>
          </div>
        </div>
      )}

      <div className="lg:pl-60">
        <div className="mx-auto w-full max-w-[1200px] px-5 py-8 sm:px-8 lg:py-10">{children}</div>
      </div>
    </div>
  );
}
