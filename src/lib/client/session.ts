"use client";

/**
 * Browser-side memory for "My orders":
 *  - the wallet session (from a signed NEP-413 message), sent as x-buffer-session
 *  - the private links of orders and subscriptions created in this browser
 * Both live in localStorage, which can be unavailable; every access is guarded.
 */
import { useSyncExternalStore } from "react";

const SESSION_KEY = "buffer-session";
const HISTORY_KEY = "buffer-history";
const EVENT = "buffer-storage";

export interface Session { token: string; accountId: string; expiresAt: string }
export interface LocalItem { kind: "order" | "subscription"; id: string; token: string; title: string; at: string }

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* storage unavailable: features degrade to the private link only */
  }
}

export function getSession(): Session | null {
  const s = read<Session>(SESSION_KEY);
  return s && new Date(s.expiresAt).getTime() > Date.now() ? s : null;
}
export const setSession = (s: Session | null) => write(SESSION_KEY, s);

/** Headers that let the server recognise the signed-in account. */
export function sessionHeaders(): Record<string, string> {
  const s = typeof window === "undefined" ? null : getSession();
  return s ? { "x-buffer-session": s.token } : {};
}

export function rememberLocal(item: Omit<LocalItem, "at">) {
  const list = (read<LocalItem[]>(HISTORY_KEY) ?? []).filter((i) => i.id !== item.id);
  write(HISTORY_KEY, [{ ...item, at: new Date().toISOString() }, ...list].slice(0, 50));
}

const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
};

// Snapshots must be stable between renders: cache by the raw string.
let sessionRaw: string | null = null;
let sessionVal: Session | null = null;
let historyRaw: string | null = null;
let historyVal: LocalItem[] = [];
const EMPTY: LocalItem[] = [];

function sessionSnapshot(): Session | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SESSION_KEY);
  } catch {
    raw = null;
  }
  if (raw !== sessionRaw) {
    sessionRaw = raw;
    sessionVal = getSession();
  }
  return sessionVal;
}
function historySnapshot(): LocalItem[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(HISTORY_KEY);
  } catch {
    raw = null;
  }
  if (raw !== historyRaw) {
    historyRaw = raw;
    historyVal = read<LocalItem[]>(HISTORY_KEY) ?? [];
  }
  return historyVal;
}

export const useSession = () => useSyncExternalStore(subscribe, sessionSnapshot, () => null);
export const useLocalHistory = () => useSyncExternalStore(subscribe, historySnapshot, () => EMPTY);

/** Proves the connected wallet owns its account (NEP-413 message, no transaction) and stores the session. */
export async function signInWithWallet(wallet: {
  signedAccountId: string;
  signNEP413Message: (p: { message: string; recipient: string; nonce: Uint8Array }) => Promise<{ accountId: string; publicKey: string; signature: string } | undefined | null>;
}): Promise<Session> {
  const c = await (await fetch("/api/me/challenge", { method: "POST" })).json();
  if (!c.nonce) throw new Error(c.error ?? "Could not start sign-in");
  const signed = await wallet.signNEP413Message({ message: c.message, recipient: c.recipient, nonce: Uint8Array.from((c.nonce as string).match(/../g)!.map((h) => parseInt(h, 16))) });
  if (!signed) throw new Error("The wallet did not sign the message");
  const res = await fetch("/api/me/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: signed.accountId || wallet.signedAccountId, publicKey: signed.publicKey, signature: signed.signature, nonce: c.nonce }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? "Sign-in failed");
  setSession(j);
  return j as Session;
}
