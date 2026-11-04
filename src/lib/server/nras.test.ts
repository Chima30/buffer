import { describe, expect, it } from "vitest";
import { gpuCandidates, parseNrasResponse, verifyGpuAttestation } from "./nras";

const NONCE = "ab".repeat(32);
const report = (nonce: string) => ({
  model_attestations: [
    { signing_address: "0xAAA", request_nonce: nonce, nvidia_payload: JSON.stringify({ nonce, arch: "HOPPER", evidence_list: [{}] }) },
    { signing_address: "0xBBB", request_nonce: nonce, nvidia_payload: JSON.stringify({ nonce, arch: "HOPPER", evidence_list: [{}] }) },
  ],
});

describe("NRAS GPU attestation", () => {
  it("finds GPU evidence per signing node", () => {
    expect(gpuCandidates(report(NONCE)).map((c) => c.signing_address)).toEqual(["0xAAA", "0xBBB"]);
  });

  it("parses the NRAS v3 response shape", () => {
    const t = "aaa.bbb.ccc";
    expect(parseNrasResponse([["JWT", t], { "GPU-0": "x.y.z", "GPU-1": "p.q.r" }])).toEqual({ platform: t, gpuTokens: ["x.y.z", "p.q.r"] });
    expect(parseNrasResponse({})).toEqual({ platform: null, gpuTokens: [] });
  });

  it("fails without evidence for the node that signed", async () => {
    expect((await verifyGpuAttestation(report(NONCE), NONCE, "0xCCC")).verdict).toBe("FAIL");
  });

  it("fails when the evidence carries a different nonce (replayed attestation)", async () => {
    const r = await verifyGpuAttestation(report("cd".repeat(32)), NONCE, "0xaaa");
    expect(r).toMatchObject({ verdict: "FAIL", detail: "GPU evidence does not carry our fresh nonce" });
  });

  it("reports ERROR when there is no GPU evidence at all", async () => {
    expect((await verifyGpuAttestation({ signing_address: "0xaaa" }, NONCE, "0xaaa")).verdict).toBe("ERROR");
  });
});
