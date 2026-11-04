import { generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ db: () => ({}) }));
const { nep413Hash, verifyNep413 } = await import("./wallet-auth");

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { publicKey: `ed25519:${bs58.encode(raw)}`, sign: (h: Buffer) => sign(null, h, privateKey) };
}

describe("NEP-413 sign-in", () => {
  const nonce = Buffer.alloc(32, 7);
  const input = { message: "Sign in", nonce, recipient: "buffer-desk.testnet" };

  it("hashes the tagged borsh payload", () => {
    const h = nep413Hash("hi", Buffer.alloc(32), "r");
    expect(h).toHaveLength(32);
    // tag 2^31+413 changes the hash: a plain transaction signature can never pass as a message signature.
    expect(h.equals(nep413Hash("hi", Buffer.alloc(32), "r", "https://x"))).toBe(false);
  });

  it("matches the reference serialisation used by near-api-js", async () => {
    const { serialize } = await import("borsh");
    const { createHash } = await import("node:crypto");
    const schema = { struct: { message: "string", nonce: { array: { type: "u8", len: 32 } }, recipient: "string", callbackUrl: { option: "string" } } } as const;
    const body = serialize(schema, { message: "Sign in", nonce: Array.from(nonce), recipient: "buffer-desk.testnet", callbackUrl: null });
    const expected = createHash("sha256").update(Buffer.concat([Buffer.from(serialize("u32", 2147484061)), Buffer.from(body)])).digest();
    expect(nep413Hash("Sign in", nonce, "buffer-desk.testnet").equals(expected)).toBe(true);
  });

  it("accepts a real signature in base64 or ed25519:base58 form", () => {
    const w = wallet();
    const sig = w.sign(nep413Hash(input.message, nonce, input.recipient));
    expect(verifyNep413({ ...input, publicKey: w.publicKey, signature: sig.toString("base64") })).toBe(true);
    expect(verifyNep413({ ...input, publicKey: w.publicKey, signature: `ed25519:${bs58.encode(sig)}` })).toBe(true);
  });

  it("rejects another key, another nonce, another recipient or garbage", () => {
    const w = wallet();
    const other = wallet();
    const sig = w.sign(nep413Hash(input.message, nonce, input.recipient)).toString("base64");
    expect(verifyNep413({ ...input, publicKey: other.publicKey, signature: sig })).toBe(false);
    expect(verifyNep413({ ...input, nonce: Buffer.alloc(32, 8), publicKey: w.publicKey, signature: sig })).toBe(false);
    expect(verifyNep413({ ...input, recipient: "evil.testnet", publicKey: w.publicKey, signature: sig })).toBe(false);
    expect(verifyNep413({ ...input, publicKey: w.publicKey, signature: "bm9wZQ==" })).toBe(false);
    expect(verifyNep413({ ...input, publicKey: "secp256k1:abc", signature: sig })).toBe(false);
  });
});
