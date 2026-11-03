/**
 * M0 integration checks. Run on your own machine:
 *
 *   npm run m0
 *
 * Read-only except one small NEAR AI Cloud inference call (uses a few credits).
 * Sends no blockchain transactions. Each check runs independently and reports
 * PASS / FAIL / SKIP (SKIP = the env vars for it are not set yet).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

type Result = { name: string; status: "PASS" | "FAIL" | "SKIP"; detail: string };
const results: Result[] = [];

// Treat empty values and unedited placeholders ("<...>") as not set.
for (const [k, v] of Object.entries(process.env)) {
  const t = v?.trim();
  if (t !== undefined && (!t || t.includes("<"))) delete process.env[k];
}

async function check(name: string, needs: string[], fn: () => Promise<string>) {
  const missing = needs.filter((k) => !process.env[k]);
  if (missing.length) {
    results.push({ name, status: "SKIP", detail: `set ${missing.join(", ")}` });
    return;
  }
  try {
    results.push({ name, status: "PASS", detail: await fn() });
  } catch (e) {
    results.push({ name, status: "FAIL", detail: (e as Error).message.slice(0, 400) });
  }
}

async function main() {
  const { USDC_TOKEN_ID, NEAR_RPC_URL } = process.env;

  // ---------- NEAR testnet + Circle USDC ----------
  await check("NEAR testnet RPC reachable", ["NEAR_NETWORK"], async () => {
    if (process.env.NEAR_NETWORK !== "testnet") throw new Error("NEAR_NETWORK must be testnet");
    const res = await fetch(NEAR_RPC_URL || "https://rpc.testnet.near.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }),
    });
    const j = (await res.json()) as { result?: { chain_id?: string; sync_info?: { latest_block_height?: number } } };
    if (j.result?.chain_id !== "testnet") throw new Error(`unexpected chain_id ${j.result?.chain_id}`);
    return `chain_id=testnet height=${j.result.sync_info?.latest_block_height}`;
  });

  const { viewFunction, isStorageRegistered, ftBalance } = await import("../src/lib/server/near-rpc");

  await check("Circle testnet USDC metadata", ["NEAR_NETWORK", "USDC_TOKEN_ID", "BUFFER_CONTRACT_ID", "OWNER_ACCOUNT_ID", "CONTRIBUTOR_ACCOUNT_ID", "VENDOR_ACCOUNT_ID"], async () => {
    const m = await viewFunction<{ symbol: string; decimals: number; name: string }>(USDC_TOKEN_ID!, "ft_metadata");
    if (m.decimals !== 6) throw new Error(`expected 6 decimals, got ${m.decimals}`);
    return `${m.name} (${m.symbol}), ${m.decimals} decimals`;
  });

  for (const key of ["OWNER_ACCOUNT_ID", "CONTRIBUTOR_ACCOUNT_ID", "VENDOR_ACCOUNT_ID", "DEMO_CUSTOMER_ACCOUNT_ID"]) {
    await check(`USDC storage + balance: ${key}`, ["NEAR_NETWORK", "USDC_TOKEN_ID", "BUFFER_CONTRACT_ID", "OWNER_ACCOUNT_ID", "CONTRIBUTOR_ACCOUNT_ID", "VENDOR_ACCOUNT_ID", key], async () => {
      const acct = process.env[key]!;
      const registered = await isStorageRegistered(USDC_TOKEN_ID!, acct);
      if (!registered) throw new Error(`${acct} is not registered with USDC (needs storage_deposit)`);
      const bal = await ftBalance(USDC_TOKEN_ID!, acct);
      return `${acct}: registered, balance ${Number(bal) / 1e6} USDC`;
    });
  }

  // ---------- NEAR AI Cloud ----------
  const nearai = await import("../src/lib/server/nearai");
  await check("NEAR AI Cloud: model list (public)", [], async () => {
    const res = await fetch(`${process.env.NEARAI_API_BASE || "https://cloud-api.near.ai/v1"}/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { data?: Record<string, unknown>[] };
    const models = j.data ?? [];
    const ids = models.map((m) => String(m.id));
    // Show any field that hints at TEE/private hosting so we can pick a Private model.
    const looksPrivate = (m: Record<string, unknown>) => /tee|private|confidential/i.test(JSON.stringify(m));
    const priv = models.filter(looksPrivate).map((m) => String(m.id));
    const configured = process.env.NEARAI_MODEL;
    const note = configured ? (ids.includes(configured) ? `configured model ${configured} is listed` : `WARNING: ${configured} not in list`) : "NEARAI_MODEL not set yet";
    return `${ids.length} models; ${note}.\n        Fields on a model entry: ${Object.keys(models[0] ?? {}).join(", ")}\n        Entries mentioning TEE/private (${priv.length}): ${priv.join(", ") || "none found by field scan"}`;
  });

  await check("NEAR AI Cloud: chat + signature + attestation", ["NEARAI_API_KEY", "NEARAI_MODEL"], async () => {
    const r = await nearai.chat({ messages: [{ role: "user", content: "Reply with exactly: Buffer M0 OK" }], maxTokens: 20, temperature: 0 });
    const sig = await nearai.getSignature(r.chatId, r.model);
    const att = await nearai.getAttestation(r.model);
    const v = await nearai.verifyChat(r, sig, att.report);
    return `chat_id=${r.chatId} tokens=${r.usage.promptTokens}/${r.usage.completionTokens} kind=${sig.signatureKind} verification=${v.level} (${v.detail}) reply="${r.content.trim().slice(0, 40)}"`;
  });

  // ---------- NEAR Intents 1Click (read-only) ----------
  const oneclick = await import("../src/lib/server/oneclick");
  await check("1Click: tokens list", [], async () => {
    process.env.ONECLICK_PREVIEW_ACCOUNT ||= "placeholder.near";
    const tokens = await oneclick.listTokens();
    const usdcNear = tokens.find((t) => t.blockchain === "near" && t.symbol === "USDC");
    const sol = tokens.find((t) => t.blockchain === "sol" && t.symbol === "SOL");
    return `${tokens.length} tokens; NEAR USDC=${usdcNear?.assetId ?? "not found"}; SOL=${sol?.assetId ?? "not found"}`;
  });

  await check("1Click: dry quote SOL -> 20 USDC (no funds move)", ["ONECLICK_PREVIEW_ACCOUNT"], async () => {
    const tokens = await oneclick.listTokens();
    const usdc = tokens.find((t) => t.blockchain === "near" && t.symbol === "USDC");
    const sol = tokens.find((t) => t.blockchain === "sol" && t.symbol === "SOL");
    if (!usdc || !sol) throw new Error("token ids not found");
    const q = await oneclick.previewQuote({ originAsset: sol.assetId, destinationAsset: usdc.assetId, amountOut: "20000000" });
    return `pay ~${q.amountIn ?? q.maxAmountIn} lamports of SOL for 20 USDC (QUOTE only, dry: true)`;
  });

  // ---------- OutLayer (read-only) ----------
  for (const base of ["https://testnet-api.outlayer.ai", "https://api.testnet.outlayer.fastnear.com"]) {
    await check(`OutLayer testnet host reachable: ${base}`, [], async () => {
      const res = await fetch(`${base}/wallet/v1/address?chain=near`, { headers: process.env.OUTLAYER_API_KEY ? { Authorization: `Bearer ${process.env.OUTLAYER_API_KEY}` } : {} });
      return `HTTP ${res.status} (401 without a key is fine; it means the host answers)`;
    });
  }

  const outlayer = await import("../src/lib/server/outlayer");
  await check("OutLayer: agent wallet address + policy", ["OUTLAYER_API_KEY"], async () => {
    const addr = await outlayer.agentAddress();
    const policy = (await outlayer.currentPolicy()) as unknown as Record<string, unknown>;
    return `agent NEAR account=${addr}; policy=${JSON.stringify(policy).slice(0, 300)}`;
  });

  // ---------- Report ----------
  const pad = Math.max(...results.map((r) => r.name.length));
  console.log("\nBuffer M0 checks\n");
  for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name.padEnd(pad)}  ${r.detail}`);
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n${results.filter((r) => r.status === "PASS").length} pass, ${failed} fail, ${results.filter((r) => r.status === "SKIP").length} skipped\n`);
  process.exit(failed ? 1 : 0);
}

main();
