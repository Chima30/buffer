/**
 * Sign-in with a NEAR wallet (NEP-413 signed message, no transaction, no gas).
 *
 * The wallet signs sha256(borsh(tag = 2^31 + 413) ++ borsh(payload)) where
 * payload = { message, nonce: [u8; 32], recipient, callbackUrl: Option<String> }.
 * We check the ed25519 signature, that the nonce is one we issued and has not
 * been used, and that the key is a full-access key of the account on-chain, so
 * a signature from someone else's key cannot claim another account.
 *
 * Sessions reuse the `owner_sessions` table (account, nonce, token hash, expiry).
 */
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import bs58 from "bs58";
import { db } from "./db";
import { nearConfig } from "./env";
import { hashToken, newToken } from "./http";
import { viewAccessKey } from "./near-rpc";

export const SIGN_IN_MESSAGE = "Sign in to Buffer to see your orders. This is not a transaction and costs nothing.";
const NEP413_TAG = 2 ** 31 + 413;
const CHALLENGE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 3600_000;

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const borshString = (s: string) => {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([u32(bytes.length), bytes]);
};

/** The 32-byte hash a NEP-413 wallet signs. */
export function nep413Hash(message: string, nonce: Buffer, recipient: string, callbackUrl?: string): Buffer {
  if (nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const payload = Buffer.concat([
    borshString(message),
    nonce,
    borshString(recipient),
    callbackUrl === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), borshString(callbackUrl)]),
  ]);
  return createHash("sha256").update(Buffer.concat([u32(NEP413_TAG), payload])).digest();
}

/** Wallets return the signature as base64 or as "ed25519:<base58>". */
function decodeSignature(sig: string): Buffer {
  if (sig.startsWith("ed25519:")) return Buffer.from(bs58.decode(sig.slice(8)));
  return Buffer.from(sig, "base64");
}

function ed25519Key(publicKey: string) {
  if (!publicKey.startsWith("ed25519:")) throw new Error("Only ed25519 keys are supported");
  const raw = Buffer.from(bs58.decode(publicKey.slice(8)));
  if (raw.length !== 32) throw new Error("Bad public key");
  // SPKI DER prefix for an Ed25519 public key.
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
}

export function verifyNep413(input: { publicKey: string; signature: string; message: string; nonce: Buffer; recipient: string }): boolean {
  try {
    const sig = decodeSignature(input.signature);
    if (sig.length !== 64) return false;
    return verify(null, nep413Hash(input.message, input.nonce, input.recipient), ed25519Key(input.publicKey), sig);
  } catch {
    return false;
  }
}

export const signInRecipient = () => nearConfig().contractId;

/** Issues a one-time nonce for the wallet to sign. */
export async function createChallenge(): Promise<{ nonce: string; message: string; recipient: string }> {
  const nonce = randomBytes(32).toString("hex");
  const { error } = await db().from("owner_sessions").insert({ account_id: "pending", nonce, expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString() });
  if (error) throw new Error(`challenge: ${error.message}`);
  return { nonce, message: SIGN_IN_MESSAGE, recipient: signInRecipient() };
}

/** Verifies a signed challenge and returns a session token for the account. */
export async function completeSignIn(input: { accountId: string; publicKey: string; signature: string; nonce: string }): Promise<{ token: string; accountId: string; expiresAt: string }> {
  if (!/^[0-9a-f]{64}$/.test(input.nonce)) throw new AuthError("Bad nonce");
  const row = (await db().from("owner_sessions").select("id,expires_at,token_hash").eq("nonce", input.nonce).maybeSingle()).data;
  if (!row || row.token_hash || new Date(row.expires_at).getTime() < Date.now()) throw new AuthError("Sign-in request expired; try again");
  const ok = verifyNep413({ publicKey: input.publicKey, signature: input.signature, message: SIGN_IN_MESSAGE, nonce: Buffer.from(input.nonce, "hex"), recipient: signInRecipient() });
  if (!ok) throw new AuthError("The signature does not match");
  // The key must belong to the account with full access; a function-call key is not proof of ownership.
  const key = await viewAccessKey(input.accountId, input.publicKey);
  if (key !== "FullAccess") throw new AuthError("That key is not a full-access key of this account");

  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  // Claim the nonce exactly once.
  const upd = await db().from("owner_sessions").update({ account_id: input.accountId, token_hash: hashToken(token), expires_at: expiresAt }).eq("id", row.id).is("token_hash", null).select("id");
  if (!upd.data?.length) throw new AuthError("Sign-in request already used");
  return { token, accountId: input.accountId, expiresAt };
}

/** The account a session token belongs to, or null. */
export async function sessionAccount(token: string | null | undefined): Promise<string | null> {
  if (!token || !/^[0-9a-f]{48}$/.test(token)) return null;
  const row = (await db().from("owner_sessions").select("account_id,expires_at").eq("token_hash", hashToken(token)).maybeSingle()).data;
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.account_id;
}

/** Reads the session header sent by the browser. */
export const sessionFrom = (req: Request) => sessionAccount(req.headers.get("x-buffer-session"));

export class AuthError extends Error {}
