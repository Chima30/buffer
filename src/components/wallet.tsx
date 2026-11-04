"use client";

import { NearProvider, useNearWallet } from "near-connect-hooks";

/** NEAR wallet connection for the whole app. Testnet only. */
export function WalletProvider({ children }: { children: React.ReactNode }) {
  return <NearProvider config={{ network: "testnet" }}>{children}</NearProvider>;
}

export function WalletButton() {
  const { signedAccountId, loading, signIn, signOut } = useNearWallet();
  if (loading) return <span className="block h-8 text-xs leading-8 text-ink-3">Wallet</span>;
  return signedAccountId ? (
    <button onClick={() => signOut()} title="Disconnect wallet" className="press block h-8 w-full truncate rounded-lg border border-rule-strong bg-surface px-3 text-left font-mono text-xs transition-colors duration-150 hover:bg-raised">
      {signedAccountId}
    </button>
  ) : (
    <button onClick={() => signIn()} className="press block h-8 w-full rounded-lg bg-ink px-3 text-xs font-medium text-paper transition-opacity duration-150 hover:opacity-90">
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
