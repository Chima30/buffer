/**
 * Independent order verifier. Uses only public sources: the order's public API
 * record, NEAR testnet RPC, Ethereum Sepolia RPC, the NEAR MPC contract and
 * NVIDIA's published keys. It trusts nothing the Buffer database says about
 * money; every amount is re-read from a chain and every proof is re-checked.
 *
 * No secrets, no keys, no Buffer server code: anyone can run it.
 */
import bs58 from "bs58";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createPublicClient, decodeEventLog, erc20Abi, http, keccak256, parseTransaction, recoverMessageAddress, recoverTransactionAddress, serializeTransaction, type Hex, type TransactionSerializableEIP1559 } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { sepolia } from "viem/chains";
import { computeSettlement, type ExpenseInput } from "../domain/revenue";

export interface Check {
  group: string;
  name: string;
  ok: boolean | null; // null = could not check (stated why)
  detail: string;
}

export interface VerifyOptions {
  base: string;
  orderId: string;
  token?: string;
  nearRpc?: string;
  sepoliaRpc?: string;
  mpcContract?: string;
}

interface PublicOrder {
  onchainOrderId: string;
  contractId: string;
  tokenContract: string;
  sku: string;
  state: string;
  ledger: { event_type: string; status: string; amount_units: string | null; counterparty: string | null; tx_hash: string | null; explorer_url: string | null; details: Record<string, unknown> }[];
  proofs: { purpose: string; model: string; chat_id: string; signing_address: string | null; signature: string | null; signature_text: string | null; request_hash: string; response_hash: string; verification_level: string; gpu_attestation: string | null; gpu_attestation_detail: { nras_platform_token?: string | null } | null }[];
  report: { content: string; content_hash: string } | null;
}

interface ChainOrder {
  sku: string;
  customer: string;
  gross: string;
  state: string;
  report_hash: string | null;
  purchases: { vendor: string; amount: string; status: string }[];
  expenses_counted: string;
  claims: { category: string; amount: string; evidence_ref: string }[];
  legs: { kind: string; recipient: string; amount: string; status: string }[];
}

async function rpc<T>(url: string, method: string, params: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }) });
  const j = (await res.json()) as { result?: T; error?: { cause?: { name?: string }; name?: string } };
  if (j.error) throw new Error(j.error.cause?.name ?? j.error.name ?? "RPC error");
  return j.result as T;
}

async function view<T>(url: string, contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>(url, "query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
}

type NearTx = { status: unknown; transaction: { signer_id: string; receiver_id: string }; receipts_outcome: { outcome: { logs: string[] } }[] };

/** Finds a NEAR transaction by trying the likely signers (the RPC needs one). */
async function nearTx(url: string, hash: string, senders: string[]): Promise<NearTx | null> {
  for (const s of [...new Set(senders.filter(Boolean))]) {
    try {
      return await rpc<NearTx>(url, "tx", { tx_hash: hash, sender_account_id: s, wait_until: "FINAL" });
    } catch {
      /* try next signer */
    }
  }
  return null;
}

const succeeded = (t: NearTx) => !(typeof t.status === "object" && t.status !== null && "Failure" in t.status);
const bufferEvents = (t: NearTx) =>
  t.receipts_outcome
    .flatMap((o) => o.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice(11)) as { standard: string; event: string; data: Record<string, unknown>[] };
      } catch {
        return null;
      }
    })
    .filter((e): e is { standard: string; event: string; data: Record<string, unknown>[] } => !!e && e.standard === "buffer");

const sha256Hex = async (s: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");

export async function verifyOrder(o: VerifyOptions): Promise<Check[]> {
  const near = o.nearRpc ?? "https://rpc.testnet.near.org";
  const sepoliaRpc = o.sepoliaRpc ?? "https://ethereum-sepolia-rpc.publicnode.com";
  const mpc = o.mpcContract ?? "v1.signer-prod.testnet";
  const checks: Check[] = [];
  const add = (group: string, name: string, ok: boolean | null, detail: string) => checks.push({ group, name, ok, detail });

  const res = await fetch(`${o.base.replace(/\/$/, "")}/api/orders/${o.orderId}${o.token ? `?token=${encodeURIComponent(o.token)}` : ""}`);
  if (!res.ok) throw new Error(`Order API answered HTTP ${res.status}`);
  const pub = (await res.json()) as PublicOrder;
  const chain = await view<ChainOrder | null>(near, pub.contractId, "get_order", { order_id: pub.onchainOrderId });
  if (!chain) {
    add("Order", "exists on NEAR", false, `No order ${pub.onchainOrderId} on ${pub.contractId}`);
    return checks;
  }
  const config = await view<{ owner: string; agent: string; contributor_bps: number; token_id: string }>(near, pub.contractId, "get_config");
  add("Order", "exists on NEAR", true, `${pub.onchainOrderId} on ${pub.contractId}: ${chain.state}, gross ${chain.gross}`);

  // 1. Payment
  const payment = pub.ledger.find((e) => e.event_type === "payment_received" && e.tx_hash);
  if (!payment?.tx_hash) add("Payment", "customer payment", false, "No payment transaction in the ledger");
  else {
    const t = await nearTx(near, payment.tx_hash, [chain.customer, payment.counterparty ?? ""]);
    const ev = t ? bufferEvents(t).find((e) => e.event === "payment_received") : null;
    const okPay = !!t && succeeded(t) && t.transaction.receiver_id === config.token_id && String(ev?.data[0]?.order_id) === pub.onchainOrderId && String(ev?.data[0]?.amount) === chain.gross;
    add("Payment", "customer payment", okPay, okPay ? `${payment.tx_hash}: ${chain.gross} USDC units from ${chain.customer} into escrow` : `Transaction ${payment.tx_hash} does not show this payment`);
  }

  // 2. Vendor purchases on NEAR
  const nearPaid = chain.purchases.filter((p) => p.status === "Paid");
  for (const [i, p] of chain.purchases.entries()) add("Purchases", `NEAR purchase #${i}`, p.status !== "Sending", `${p.status}: ${p.amount} to ${p.vendor}`);

  // 3. Cross-chain purchases (Chain Signatures)
  const evm = await view<{ vendor: string; amount: string; token: string; nonce: number | null; payload_hash: string | null; status: string; signature: { big_r: string; s: string; recovery_id: number } | null }[]>(near, pub.contractId, "get_evm_purchases", { order_id: pub.onchainOrderId }).catch(() => []);
  const evmSigned = evm.filter((p) => p.status === "Signed");
  if (evm.length) {
    const key = await view<string>(near, mpc, "derived_public_key", { path: "buffer-treasury", predecessor: pub.contractId, domain_id: 0 });
    const treasury = publicKeyToAddress(`0x04${Buffer.from(bs58.decode(key.split(":")[1])).toString("hex")}`);
    add("Cross-chain", "treasury address", true, `${treasury} = MPC key for (${pub.contractId}, "buffer-treasury")`);
    const client = createPublicClient({ chain: sepolia, transport: http(sepoliaRpc) });
    for (const [i, p] of evm.entries()) {
      if (p.status !== "Signed" || !p.signature || !p.payload_hash) {
        add("Cross-chain", `Ethereum purchase #${i}`, p.status === "Rejected" || p.status === "Failed" ? true : null, `${p.status}: nothing signed`);
        continue;
      }
      const unsigned = await view<string | null>(near, pub.contractId, "get_evm_unsigned_tx", { order_id: pub.onchainOrderId, index: i });
      const u = `0x${unsigned}` as Hex;
      const hashOk = !!unsigned && keccak256(u).slice(2) === p.payload_hash;
      add("Cross-chain", `#${i} contract-built transaction`, hashOk, hashOk ? `keccak256(unsigned tx from the contract) = signed payload ${p.payload_hash.slice(0, 16)}…` : "Payload hash does not match the contract's transaction");
      const tx = parseTransaction(u) as TransactionSerializableEIP1559;
      const bigR = p.signature.big_r.replace(/^0x/, "");
      const raw = serializeTransaction(tx, { r: `0x${bigR.slice(2)}`, s: `0x${p.signature.s.replace(/^0x/, "")}`, yParity: p.signature.recovery_id });
      const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
      add("Cross-chain", `#${i} MPC signature`, from.toLowerCase() === treasury.toLowerCase(), `signature recovers to ${from}`);
      const sepHash = keccak256(raw);
      const receipt = await client.getTransactionReceipt({ hash: sepHash }).catch(() => null);
      const transfer = receipt?.logs.some((log) => {
        if (log.address.toLowerCase() !== p.token) return false;
        try {
          const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
          return ev.eventName === "Transfer" && ev.args.from.toLowerCase() === treasury.toLowerCase() && ev.args.to.toLowerCase() === p.vendor && ev.args.value === BigInt(p.amount);
        } catch {
          return false;
        }
      });
      add("Cross-chain", `#${i} paid on Sepolia`, receipt ? receipt.status === "success" && !!transfer : null, receipt ? `${sepHash}: ${p.amount} USDC units ${treasury} -> ${p.vendor}` : `Transaction ${sepHash} not found on Sepolia (yet)`);
    }
  }

  // 4. Delivery
  const fulfilled = ["Fulfilled", "Settling", "Settled"].includes(chain.state);
  add("Delivery", "report hash on-chain", fulfilled ? !!chain.report_hash : null, chain.report_hash ? `sha256 ${chain.report_hash}` : "Not delivered yet");
  if (pub.report && chain.report_hash) {
    const h = await sha256Hex(pub.report.content);
    add("Delivery", "report matches the hash", h === chain.report_hash, h === chain.report_hash ? "The report you received is the one recorded on-chain" : `Report hashes to ${h}`);
  } else if (chain.report_hash) add("Delivery", "report matches the hash", null, "Pass the order's access token (#t=… in its URL) to check the report itself");

  // 5. Settlement math, from on-chain numbers only
  if (["Settling", "Settled"].includes(chain.state)) {
    const products = await view<[string, { max_expense: string }][]>(near, pub.contractId, "get_products");
    const cap = products.find(([s]) => s === chain.sku)?.[1].max_expense;
    const expenses: ExpenseInput[] = [
      ...nearPaid.map((p, i) => ({ id: `v${i}`, category: "supplier" as const, amount: BigInt(p.amount), status: "PAID" as const, evidenceRef: "onchain" })),
      ...evmSigned.map((p, i) => ({ id: `x${i}`, category: "treasury" as const, amount: BigInt(p.amount), status: "PAID" as const, evidenceRef: "onchain" })),
      ...chain.claims.map((c, i) => ({ id: `c${i}`, category: "inference" as const, amount: BigInt(c.amount), status: "METERED" as const, evidenceRef: c.evidence_ref })),
    ];
    const s = computeSettlement({ gross: BigInt(chain.gross), maxExpense: BigInt(cap ?? "0"), contributorBps: config.contributor_bps, expenses });
    const leg = (k: string) => BigInt(chain.legs.find((l) => l.kind === k)?.amount ?? "0");
    const match = leg("Owner") === s.ownerShare && leg("Contributor") === s.contributorShare && leg("ReimbOwner") === s.reimbOwner && BigInt(chain.expenses_counted) === s.expensesCounted;
    add("Settlement", "70/30 formula", match, `expenses ${s.expensesCounted}, net ${s.distributable}: owner ${s.ownerShare}, contributor ${s.contributorShare} (${config.contributor_bps / 100}%), reimbursed ${s.reimbOwner}`);
    const sum = s.paidToVendors + s.reimbOwner + s.contributorShare + s.ownerShare;
    add("Settlement", "parts add up to the payment", sum === BigInt(chain.gross), `${sum} = ${chain.gross}`);
    const allConfirmed = chain.legs.every((l) => l.status === "Confirmed");
    add("Settlement", "payouts confirmed on-chain", allConfirmed, chain.legs.map((l) => `${l.kind} ${l.amount} -> ${l.recipient}: ${l.status}`).join("; "));
    const settleTx = pub.ledger.find((e) => e.event_type === "payout_owner" && e.tx_hash)?.tx_hash;
    if (settleTx) {
      const t = await nearTx(near, settleTx, [config.agent, config.owner]);
      add("Settlement", "settlement transaction", !!t && succeeded(t), t ? `${settleTx} signed by ${t.transaction.signer_id}` : `${settleTx} not found`);
    }
  }

  // 6. Private inference proofs
  const jwks = createRemoteJWKSet(new URL("https://nras.attestation.nvidia.com/.well-known/jwks.json"));
  for (const p of pub.proofs) {
    if (!p.signature || !p.signing_address) {
      add("Inference", `${p.purpose} signature`, null, "No signature stored");
      continue;
    }
    const texts = p.signature_text ? [p.signature_text] : [`${p.model}:${p.request_hash}:${p.response_hash}`, `${p.request_hash}:${p.response_hash}`];
    let signer: string | null = null;
    let usedText = "";
    for (const t of texts) {
      try {
        const a = await recoverMessageAddress({ message: t, signature: p.signature as Hex });
        if (a.toLowerCase() === p.signing_address.toLowerCase()) {
          signer = a;
          usedText = t;
          break;
        }
      } catch {
        /* try next */
      }
    }
    const coversHashes = usedText.endsWith(`${p.request_hash}:${p.response_hash}`);
    add("Inference", `${p.purpose} signed by the TEE key`, signer ? coversHashes : false, signer ? `${signer} signed request ${p.request_hash.slice(0, 12)}… / response ${p.response_hash.slice(0, 12)}…` : "Signature does not recover to the recorded signer");
    const token = p.gpu_attestation_detail?.nras_platform_token;
    if (token) {
      try {
        const { payload } = await jwtVerify(token, jwks);
        add("Inference", `${p.purpose} GPU attestation`, payload["x-nvidia-overall-att-result"] === true, `NVIDIA NRAS verdict signed by NVIDIA, issued ${typeof payload.iat === "number" ? new Date(payload.iat * 1000).toISOString() : "?"}`);
      } catch (e) {
        add("Inference", `${p.purpose} GPU attestation`, false, `NRAS token did not verify: ${(e as Error).message}`);
      }
    } else add("Inference", `${p.purpose} GPU attestation`, null, "No NRAS token stored (call predates GPU checks)");
  }
  return checks;
}
