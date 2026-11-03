"use client";

import { NearProvider, useNearWallet } from "near-connect-hooks";

/** NEAR wallet connection for the whole app. Testnet only. */
export function WalletProvider({ children }: { children: React.ReactNode }) {
  return <NearProvider config={{ network: "testnet" }}>{children}</NearProvider>;
}

export function WalletButton() {
  const { signedAccountId, loading, signIn, signOut } = useNearWallet();
  if (loading) return <span className="text-xs text-ink-3">Wallet…</span>;
  return signedAccountId ? (
    <button onClick={() => signOut()} title="Disconnect wallet" className="max-w-[11rem] truncate rounded-full border border-rule-strong px-2.5 py-0.5 font-mono text-xs">
      {signedAccountId}
    </button>
  ) : (
    <button onClick={() => signIn()} className="rounded-full bg-ink px-3 py-1 text-xs font-medium text-paper">
      Connect wallet
    </button>
  );
}

export { useNearWallet };

/** The transaction hash from a wallet result, across wallet implementations. */
export function txHashOf(outcome: unknown): string | null {
  const o = outcome as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | null;
  return o?.transaction?.hash ?? o?.transaction_outcome?.id ?? null;
}
