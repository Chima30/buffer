"use client";

import { Activity, BookText, Boxes, Gauge, Landmark, History, Home, Menu, Network as NetworkIcon, PlusSquare, Scale, ShieldCheck, ShoppingBag, SlidersHorizontal, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useState, useSyncExternalStore } from "react";
import { SystemStatus } from "./system-status";
import { ThemeSwitch } from "./theme-toggle";
import { WalletButton } from "./wallet";

type Item = { href: string; label: string; icon: typeof Home };
const GROUPS: { title: string; items: Item[] }[] = [
  { title: "Main", items: [{ href: "/", label: "Overview", icon: Home }, { href: "/new", label: "Start a business", icon: PlusSquare }] },
  { title: "Sell", items: [{ href: "/store", label: "Store", icon: ShoppingBag }, { href: "/me", label: "My orders", icon: History }] },
  { title: "Proof", items: [{ href: "/ledger", label: "Ledger", icon: BookText }, { href: "/security", label: "Security", icon: ShieldCheck }] },
  {
    title: "Operate",
    items: [
      { href: "/app", label: "Owner console", icon: SlidersHorizontal },
      { href: "/app#rules", label: "Rules", icon: Scale },
      { href: "/app#treasury", label: "Treasury", icon: Landmark },
      { href: "/app#products", label: "Products", icon: Boxes },
      { href: "/app#vendors", label: "Vendors and chains", icon: NetworkIcon },
      { href: "/app#activity", label: "Agent activity", icon: Activity },
    ],
  },
];

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

const subscribeHash = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

function isActive(href: string, path: string | null, hash: string) {
  if (!path) return false;
  const [base, h] = href.split("#");
  if (base === "/app") return path === "/app" && (h ?? "") === (hash === "overview" ? "" : hash);
  if (base === "/store") return path === "/store" || path.startsWith("/orders") || path.startsWith("/subscriptions");
  return path === base;
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash.slice(1), () => "");
  return <NavList path={path} hash={hash} onNavigate={onNavigate} />;
}

function NavList({ path, hash, onNavigate }: { path: string | null; hash: string; onNavigate?: () => void }) {
  return (
    <nav className="space-y-5">
      {GROUPS.map((g) => (
        <div key={g.title}>
          <p className="px-2.5 pb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{g.title}</p>
          <ul className="space-y-0.5">
            {g.items.map(({ href, label, icon: Icon }) => {
              const on = isActive(href, path, hash);
              const sub = href.includes("#");
              // Console sections show only inside the console.
              if (sub && path !== "/app") return null;
              return (
                <li key={href}>
                  {(() => {
                    const cls = `group relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors duration-150 ${sub ? "pl-7" : ""} ${on ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-raised hover:text-ink"}`;
                    const inner = (
                      <>
                        <span aria-hidden className={`absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent transition-transform duration-300 ${on ? "scale-y-100" : "scale-y-0"}`} />
                        <Icon size={sub ? 14 : 16} strokeWidth={1.6} className={on ? "text-accent" : "text-ink-3 group-hover:text-ink-2"} />
                        {label}
                      </>
                    );
                    // Console sections are plain hash links: the browser fires hashchange, which the console's tabs follow.
                    return sub ? (
                      <a href={href.slice(href.indexOf("#"))} onClick={onNavigate} aria-current={on ? "page" : undefined} className={cls}>
                        {inner}
                      </a>
                    ) : (
                      <Link href={href} onClick={onNavigate} aria-current={on ? "page" : undefined} className={cls}>
                        {inner}
                      </Link>
                    );
                  })()}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Network() {
  return (
    <div className="flex items-center gap-2 font-mono text-[11px] text-ink-3">
      <Gauge size={12} strokeWidth={1.6} />
      NEAR testnet + 6 EVM testnets
    </div>
  );
}

/** Wallet on top, sections in the middle, live status and theme at the bottom. */
function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      {/* On phones the wallet lives in the drawer too; on desktop it sits top right. */}
      <div className="px-4 pb-4 lg:hidden">
        <WalletButton />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <Suspense fallback={<NavList path={null} hash="" />}>
          <NavLinks onNavigate={onNavigate} />
        </Suspense>
      </div>
      <div className="space-y-3 border-t border-rule px-4 py-4">
        <SystemStatus />
        <ThemeSwitch />
        <Network />
      </div>
    </>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-rule bg-sidebar lg:flex">
        <Link href="/" className="flex h-16 shrink-0 items-center gap-2.5 px-5">
          <Mark />
          <span className="text-[17px] font-medium tracking-tight">Buffer</span>
          <span className="ml-auto rounded-md border border-rule px-1.5 py-0.5 font-mono text-[10px] text-ink-3">testnet</span>
        </Link>
        <SidebarBody />
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
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <button aria-label="Close menu" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />
          <div className="drawer absolute inset-y-0 left-0 flex w-72 flex-col border-r border-rule bg-sidebar pt-3">
            <div className="flex h-10 items-center justify-between px-4 pb-3">
              <span className="flex items-center gap-2 font-medium"><Mark /> Buffer</span>
              <button onClick={() => setOpen(false)} aria-label="Close menu" className="grid h-9 w-9 place-items-center rounded-lg text-ink-2 hover:bg-raised">
                <X size={18} strokeWidth={1.5} />
              </button>
            </div>
            <SidebarBody onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}

      <div className="lg:pl-64">
        {/* Desktop top bar: the wallet, top right, on every page. */}
        <div className="sticky top-0 z-20 hidden h-16 items-center justify-end border-b border-rule bg-paper/85 px-8 backdrop-blur lg:flex">
          <div className="w-56">
            <WalletButton />
          </div>
        </div>
        <div className="mx-auto w-full max-w-[1240px] px-5 py-8 sm:px-8 lg:py-8">{children}</div>
      </div>
    </div>
  );
}
