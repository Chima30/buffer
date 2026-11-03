import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { attestedAddresses, inferenceCostUsdMicros, verifyChat } from "./nearai";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const req = "a".repeat(64);
const resp = "b".repeat(64);

async function sign(text: string) {
  return { text, signature: await account.signMessage({ message: text }), signingAddress: account.address, signingAlgo: "ecdsa", signatureKind: "provider_tee" as const };
}

describe("verifyChat", () => {
  const result = { requestHash: req, responseHash: resp, model: "zai-org/GLM-5.1-FP8" };
  const attested = { model_attestations: [{ signing_address: account.address }] };

  it("reports SIGNATURE_ATTESTED when signer is in the attestation report", async () => {
    const v = await verifyChat(result, await sign(`zai-org/GLM-5.1-FP8:${req}:${resp}`), attested);
    expect(v.level).toBe("SIGNATURE_ATTESTED");
  });

  it("reports SIGNATURE_ONLY when signer is not attested", async () => {
    const v = await verifyChat(result, await sign(`${req}:${resp}`), { model_attestations: [] });
    expect(v.level).toBe("SIGNATURE_ONLY");
  });

  it("fails when hashes differ", async () => {
    const v = await verifyChat(result, await sign(`m:${req}:${"c".repeat(64)}`), attested);
    expect(v.level).toBe("FAILED");
    expect(v.hashesMatch).toBe(false);
  });

  it("fails when the claimed signing address is wrong", async () => {
    const s = await sign(`m:${req}:${resp}`);
    const v = await verifyChat(result, { ...s, signingAddress: "0x0000000000000000000000000000000000000001" }, attested);
    expect(v.level).toBe("FAILED");
  });
});

describe("attestedAddresses", () => {
  it("finds nested signing addresses case-insensitively", () => {
    const s = attestedAddresses({ gateway_attestation: { signing_address: "0xABC" }, model_attestations: [{ signing_address: "0xDef" }] });
    expect([...s].sort()).toEqual(["0xabc", "0xdef"]);
  });
});

describe("inferenceCostUsdMicros", () => {
  it("rounds up per component", () => {
    // $1.05/M input, $3.10/M output; 1000 in, 500 out -> 1050 + 1550 micro-USD
    expect(inferenceCostUsdMicros({ promptTokens: 1000, completionTokens: 500 }, { inputUsdMicrosPerM: 1_050_000n, outputUsdMicrosPerM: 3_100_000n })).toBe(2600n);
  });
});
