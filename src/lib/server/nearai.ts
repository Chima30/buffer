/**
 * NEAR AI Cloud client (OpenAI-compatible gateway at cloud-api.near.ai).
 *
 * We use raw fetch instead of an SDK so we keep the exact request and response
 * bytes: chat signatures are computed over sha256(request body) and
 * sha256(response body), so any re-serialisation would break verification.
 *
 * Verification levels we report honestly:
 *  - SIGNATURE_ATTESTED: signature recovers to an address that appears in the
 *    attestation report for this model (or the gateway), and both hashes match.
 *  - SIGNATURE_ONLY: signature valid and hashes match, but the signer was not
 *    found in the attestation report we fetched.
 *  - FAILED: anything else.
 * Hardware quote verification (NVIDIA NRAS + Intel TDX) is a stretch goal and
 * is not claimed by these levels.
 */
import { createHash, randomBytes } from "node:crypto";
import { recoverMessageAddress, type Hex } from "viem";
import { nearAiConfig } from "./env";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  chatId: string;
  model: string;
  content: string;
  usage: { promptTokens: number; completionTokens: number };
  requestBody: string;
  responseBody: string;
  requestHash: string;
  responseHash: string;
}

export interface SignatureRecord {
  text: string;
  signature: string;
  signingAddress: string;
  signingAlgo: string;
  signatureKind: "provider_tee" | "gateway" | "unknown";
}

export type VerificationLevel = "SIGNATURE_ATTESTED" | "SIGNATURE_ONLY" | "FAILED";

export interface VerificationResult {
  level: VerificationLevel;
  recoveredAddress: string | null;
  hashesMatch: boolean;
  signerInAttestation: boolean;
  signatureKind: SignatureRecord["signatureKind"];
  detail: string;
}

export class NearAiError extends Error {
  constructor(message: string, public readonly status?: number, public readonly retryable = false) {
    super(message);
    this.name = "NearAiError";
  }
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function authHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export async function listModels(): Promise<unknown> {
  const { baseUrl } = nearAiConfig();
  const res = await fetch(`${baseUrl}/models`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new NearAiError(`GET /models failed: ${res.status}`, res.status);
  return res.json();
}

export async function chat(params: {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  responseFormatJson?: boolean;
}): Promise<ChatResult> {
  const cfg = nearAiConfig();
  const model = params.model ?? cfg.model;
  const body: Record<string, unknown> = {
    model,
    messages: params.messages,
    stream: false,
  };
  if (params.maxTokens) body.max_tokens = params.maxTokens;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.responseFormatJson) body.response_format = { type: "json_object" };

  const requestBody = JSON.stringify(body);
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: authHeaders(cfg.apiKey),
    body: requestBody,
  });
  const responseBody = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new NearAiError(`chat/completions failed: ${res.status} ${responseBody.slice(0, 300)}`, res.status, retryable);
  }
  let parsed: {
    id?: string;
    model?: string;
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    throw new NearAiError("chat/completions returned non-JSON");
  }
  const chatId = parsed.id;
  const content = parsed.choices?.[0]?.message?.content;
  if (!chatId || typeof content !== "string") {
    throw new NearAiError("chat/completions response missing id or content");
  }
  return {
    chatId,
    model: parsed.model ?? model,
    content,
    usage: {
      promptTokens: parsed.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
    },
    requestBody,
    responseBody,
    requestHash: sha256(requestBody),
    responseHash: sha256(responseBody),
  };
}

/** Signatures are cached on the node that served the call; retry "not found". */
export async function getSignature(chatId: string, model: string, attempts = 6): Promise<SignatureRecord> {
  const cfg = nearAiConfig();
  const url = `${cfg.baseUrl}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, { headers: authHeaders(cfg.apiKey) });
    const text = await res.text();
    if (res.ok) {
      const j = JSON.parse(text) as {
        text: string;
        signature: string;
        signing_address: string;
        signing_algo: string;
        signature_kind?: string;
      };
      return {
        text: j.text,
        signature: j.signature,
        signingAddress: j.signing_address,
        signingAlgo: j.signing_algo,
        signatureKind:
          j.signature_kind === "provider_tee" || j.signature_kind === "gateway" ? j.signature_kind : "unknown",
      };
    }
    lastError = `${res.status} ${text.slice(0, 200)}`;
    await sleep(500 * (i + 1));
  }
  throw new NearAiError(`Signature not available for ${chatId}: ${lastError}`, undefined, true);
}

export async function getAttestation(model?: string): Promise<{ nonce: string; report: unknown }> {
  const cfg = nearAiConfig();
  const nonce = randomBytes(32).toString("hex");
  const qs = new URLSearchParams({ signing_algo: "ecdsa", nonce });
  if (model) qs.set("model", model);
  const res = await fetch(`${cfg.baseUrl}/attestation/report?${qs}`, { headers: authHeaders(cfg.apiKey) });
  if (!res.ok) throw new NearAiError(`attestation/report failed: ${res.status}`, res.status);
  return { nonce, report: await res.json() };
}

/** Collect every `signing_address` value found anywhere in an attestation report. */
export function attestedAddresses(report: unknown): Set<string> {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if (k === "signing_address" && typeof val === "string") found.add(val.toLowerCase());
        else walk(val);
      }
    }
  };
  walk(report);
  return found;
}

export async function verifyChat(
  result: Pick<ChatResult, "requestHash" | "responseHash" | "model">,
  sig: SignatureRecord,
  attestationReport: unknown,
): Promise<VerificationResult> {
  const parts = sig.text.split(":");
  // provider_tee: "{model}:{req}:{resp}" (model ids may themselves contain ':'); gateway: "{req}:{resp}"
  const [reqH, respH] = parts.slice(-2);
  const hashesMatch = reqH === result.requestHash && respH === result.responseHash;

  let recovered: string | null = null;
  try {
    recovered = (await recoverMessageAddress({ message: sig.text, signature: sig.signature as Hex })).toLowerCase();
  } catch {
    recovered = null;
  }
  const claimedMatches = recovered !== null && recovered === sig.signingAddress.toLowerCase();
  const signerInAttestation = recovered !== null && attestedAddresses(attestationReport).has(recovered);

  if (!claimedMatches) {
    return { level: "FAILED", recoveredAddress: recovered, hashesMatch, signerInAttestation, signatureKind: sig.signatureKind, detail: "Signature does not recover to the claimed signing address" };
  }
  if (!hashesMatch) {
    return { level: "FAILED", recoveredAddress: recovered, hashesMatch, signerInAttestation, signatureKind: sig.signatureKind, detail: "Signed hashes do not match the request/response we sent and received" };
  }
  return {
    level: signerInAttestation ? "SIGNATURE_ATTESTED" : "SIGNATURE_ONLY",
    recoveredAddress: recovered,
    hashesMatch,
    signerInAttestation,
    signatureKind: sig.signatureKind,
    detail: signerInAttestation
      ? "Signature valid; signer is listed in the attestation report"
      : "Signature valid; signer not found in the fetched attestation report",
  };
}

/** Cost from token usage. Prices are USD per 1M tokens, expressed in micro-USD. */
export function inferenceCostUsdMicros(
  usage: ChatResult["usage"],
  price: { inputUsdMicrosPerM: bigint; outputUsdMicrosPerM: bigint },
): bigint {
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  return (
    ceilDiv(BigInt(usage.promptTokens) * price.inputUsdMicrosPerM, 1_000_000n) +
    ceilDiv(BigInt(usage.completionTokens) * price.outputUsdMicrosPerM, 1_000_000n)
  );
}
