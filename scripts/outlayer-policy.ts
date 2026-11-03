/**
 * Sets the agent wallet's OutLayer policy (TESTNET), in two halves so that the
 * on-chain transaction is signed by YOU with near-cli, never by this script.
 *
 *   npm run outlayer:policy             -> encrypts + signs the policy, writes
 *                                          outlayer-policy-args.json and prints
 *                                          the near-cli command to store it
 *   npm run outlayer:policy -- --finish -> after you ran that command: clears
 *                                          OutLayer's cache and shows the live policy
 *
 * The policy: the agent may only make contract calls, only to the Buffer
 * business contract, attaching no NEAR, at most 60 per hour. Every other
 * capability (swaps, cross-chain withdrawals, raw signing, message signing)
 * is denied. The first account to store a policy becomes its controller, which
 * can later update or freeze it; that must be the owner account.
 */
import { config } from "dotenv";
import { writeFileSync } from "node:fs";

config({ path: ".env.local" });

const isSet = (v?: string) => !!v && v.trim() !== "" && !v.includes("<");
function need(name: string): string {
  const v = process.env[name];
  if (!isSet(v)) throw new Error(`${name} is not set in .env.local`);
  return v!.trim();
}

const base = (isSet(process.env.OUTLAYER_API_BASE) ? process.env.OUTLAYER_API_BASE! : "https://testnet-api.outlayer.ai").replace(/\/$/, "");
const OUTLAYER_CONTRACT = "outlayer.testnet";

async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { Authorization: `Bearer ${need("OUTLAYER_API_KEY")}`, "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

export function bufferAgentPolicy(contractId: string) {
  return {
    transaction_types: ["call"],
    allowed_tokens: ["native"],
    addresses: { mode: "whitelist", list: [contractId] },
    limits: { per_transaction: { native: "0" } },
    rate_limit: { max_per_hour: 60 },
    capabilities: {
      raw_sign: { allowed: false },
      evm_sign: { allowed: false, raw_tx: false },
      solana_sign: { allowed: false, raw_tx: false },
      confidential: { allowed: false },
      sign_message: { allowed: false },
      swap: { allowed: false },
      cross_chain_withdraw: { allowed: false },
      payment_check: { allowed: false },
    },
  };
}

async function prepare() {
  if (need("NEAR_NETWORK") !== "testnet") throw new Error("NEAR_NETWORK must be testnet");
  const walletId = need("OUTLAYER_WALLET_ID");
  const contractId = need("BUFFER_CONTRACT_ID");
  const owner = need("OWNER_ACCOUNT_ID");
  const rules = bufferAgentPolicy(contractId);

  const enc = await api("/wallet/v1/encrypt-policy", { body: { wallet_id: walletId, rules } });
  const encrypted = enc.encrypted_base64 ?? enc.encrypted_data;
  if (!encrypted) throw new Error(`encrypt-policy returned no ciphertext. Fields: ${Object.keys(enc).join(", ")}`);

  const sig = await api("/wallet/v1/sign-policy", { body: { encrypted_data: encrypted, caller: owner } });
  const signature = sig.signature ?? sig.signature_hex;
  if (!signature) throw new Error(`sign-policy response missing a signature. Fields: ${Object.keys(sig).join(", ")}`);

  // outlayer.testnet needs the wallet's public key as "ed25519:<hex>". Some API
  // responses return the wallet id in `wallet_pubkey`, so only accept a value
  // in key format; otherwise use the controller key OutLayer reports, or the
  // implicit account hex (an implicit account is named after its ed25519 key).
  const keyFormat = /^(ed25519|secp256k1):[0-9a-f]+$/;
  const live = await api("/wallet/v1/policy").catch(() => ({}));
  const candidates = [enc.wallet_pubkey, sig.wallet_pubkey, live.controller, isSet(process.env.AGENT_ACCOUNT_ID) ? `ed25519:${process.env.AGENT_ACCOUNT_ID!.trim()}` : undefined];
  const walletPubkey = candidates.find((c) => typeof c === "string" && keyFormat.test(c));
  if (!walletPubkey) throw new Error("Could not determine the wallet public key (expected ed25519:<hex>)");

  writeFileSync(
    "outlayer-policy-args.json",
    JSON.stringify({ wallet_pubkey: walletPubkey, encrypted_data: encrypted, wallet_signature: signature }, null, 2),
  );

  console.log("\nPolicy encrypted and signed by the agent wallet's TEE key.\n");
  console.log("What it allows:");
  console.log(`  - contract calls only, and only to ${contractId}`);
  console.log("  - no NEAR attached to any call, at most 60 calls per hour");
  console.log("  - swaps, withdrawals, raw signing and message signing: all denied\n");
  console.log(`Controller (can update or freeze it later): ${owner}\n`);
  console.log("Now store it on-chain. Run this yourself; near-cli signs with the owner key on your machine:\n");
  console.log(
    `near contract call-function as-transaction ${OUTLAYER_CONTRACT} store_wallet_policy file-args outlayer-policy-args.json prepaid-gas '100 Tgas' attached-deposit '0.05 NEAR' sign-as ${owner} network-config testnet sign-with-keychain send`,
  );
  console.log("\nThen run:  npm run outlayer:policy -- --finish\n");
}

async function finish() {
  const walletId = need("OUTLAYER_WALLET_ID");
  await api("/wallet/v1/invalidate-cache", { body: { wallet_id: walletId } });
  const live = await api("/wallet/v1/policy");
  console.log("\nLive policy as OutLayer reports it:\n");
  console.log(JSON.stringify(live, null, 2));
  console.log("");
}

(process.argv.includes("--finish") ? finish() : prepare()).catch((e) => {
  console.error(`Failed: ${(e as Error).message}`);
  process.exit(1);
});
