/**
 * NVIDIA GPU attestation through NVIDIA's Remote Attestation Service (NRAS).
 *
 * For the TEE node that signed our chat (matched by signing_address) we take the
 * GPU evidence NEAR AI collected inside the enclave (`nvidia_payload`), check it
 * carries the fresh nonce we sent, post it to NRAS unchanged, and verify NVIDIA's
 * signed verdict (an EAT JWT) against NVIDIA's published keys. We accept only when
 * the overall result claim is `true`.
 *
 * Scope, stated honestly: this proves the GPUs are genuine NVIDIA hardware in
 * confidential-computing mode with good measurements, for a fresh nonce. It does
 * not verify the Intel TDX quote (that needs Intel DCAP collateral).
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

export const NRAS_GPU_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";
const NRAS_JWKS = createRemoteJWKSet(new URL("https://nras.attestation.nvidia.com/.well-known/jwks.json"));

export type GpuVerdict = "PASS" | "FAIL" | "ERROR";

export interface GpuAttestation {
  verdict: GpuVerdict;
  detail: string;
  arch?: string;
  gpus?: number;
  /** NVIDIA's signed platform token, kept so anyone can re-verify it. */
  platformToken?: string;
  issuedAt?: string;
}

interface Candidate {
  signing_address?: string;
  nvidia_payload: string;
  request_nonce?: string;
}

/** Every report entry that carries GPU evidence. */
export function gpuCandidates(report: unknown): Candidate[] {
  const out: Candidate[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.nvidia_payload === "string" && o.nvidia_payload.length > 0) {
        out.push({ signing_address: typeof o.signing_address === "string" ? o.signing_address : undefined, nvidia_payload: o.nvidia_payload, request_nonce: typeof o.request_nonce === "string" ? o.request_nonce : undefined });
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(report);
  return out;
}

/** NRAS returns [["JWT", platformToken], {"GPU-0": token, ...}]; tolerate small shape changes. */
export function parseNrasResponse(body: unknown): { platform: string | null; gpuTokens: string[] } {
  let platform: string | null = null;
  const gpuTokens: string[] = [];
  const isJwt = (s: unknown): s is string => typeof s === "string" && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(s);
  if (Array.isArray(body)) {
    for (const item of body) {
      if (Array.isArray(item) && item[0] === "JWT" && isJwt(item[1])) platform = item[1];
      else if (item && typeof item === "object") for (const v of Object.values(item)) if (isJwt(v)) gpuTokens.push(v);
    }
  }
  return { platform, gpuTokens };
}

export async function verifyGpuAttestation(report: unknown, nonce: string, signer: string | null): Promise<GpuAttestation> {
  try {
    const candidates = gpuCandidates(report);
    if (candidates.length === 0) return { verdict: "ERROR", detail: "The attestation report has no GPU evidence" };
    const c = (signer && candidates.find((x) => x.signing_address?.toLowerCase() === signer.toLowerCase())) || null;
    if (!c) return { verdict: "FAIL", detail: "No GPU evidence for the node that signed this response" };

    let payload: { nonce?: string; arch?: string; evidence_list?: unknown[] };
    try {
      payload = JSON.parse(c.nvidia_payload);
    } catch {
      return { verdict: "FAIL", detail: "GPU evidence is not valid JSON" };
    }
    if (String(payload.nonce ?? "").toLowerCase() !== nonce.toLowerCase()) return { verdict: "FAIL", detail: "GPU evidence does not carry our fresh nonce" };
    if (c.request_nonce && c.request_nonce.toLowerCase() !== nonce.toLowerCase()) return { verdict: "FAIL", detail: "Report echoes a different nonce" };

    const res = await fetch(NRAS_GPU_URL, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: c.nvidia_payload });
    const text = await res.text();
    if (!res.ok) return { verdict: "ERROR", detail: `NRAS answered HTTP ${res.status}: ${text.slice(0, 160)}` };
    const { platform, gpuTokens } = parseNrasResponse(JSON.parse(text));
    if (!platform) return { verdict: "ERROR", detail: "NRAS response had no platform token" };

    // Signature check against NVIDIA's keys; throws if forged or expired.
    const { payload: claims } = await jwtVerify(platform, NRAS_JWKS);
    for (const t of gpuTokens) await jwtVerify(t, NRAS_JWKS);

    const overall = claims["x-nvidia-overall-att-result"] === true;
    const eatNonce = typeof claims.eat_nonce === "string" ? claims.eat_nonce : null;
    if (eatNonce && eatNonce.toLowerCase() !== nonce.toLowerCase()) return { verdict: "FAIL", detail: "NVIDIA's verdict is for a different nonce", platformToken: platform };
    const gpus = gpuTokens.length || (Array.isArray(payload.evidence_list) ? payload.evidence_list.length : undefined);
    const issuedAt = typeof claims.iat === "number" ? new Date(claims.iat * 1000).toISOString() : undefined;
    return {
      verdict: overall ? "PASS" : "FAIL",
      detail: overall ? `NVIDIA NRAS verified ${gpus ?? "the"} ${payload.arch ?? ""} GPU${gpus === 1 ? "" : "s"} (signed verdict, fresh nonce)`.replace(/\s+/g, " ") : "NVIDIA NRAS returned a failing overall result",
      arch: payload.arch,
      gpus,
      platformToken: platform,
      issuedAt,
    };
  } catch (e) {
    return { verdict: "ERROR", detail: `GPU attestation check failed: ${(e as Error).message.slice(0, 200)}` };
  }
}
