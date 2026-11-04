import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { addressFromNearSecp256k1 } from "./evm";

describe("Chain Signatures address", () => {
  it("turns a NEAR secp256k1 key into the matching Ethereum address", () => {
    const pk = "0x" + "11".repeat(32);
    const account = privateKeyToAccount(pk as `0x${string}`);
    const uncompressed = Buffer.from(account.publicKey.slice(4), "hex"); // drop 0x04
    const nearKey = `secp256k1:${bs58.encode(uncompressed)}`;
    expect(addressFromNearSecp256k1(nearKey)).toBe(account.address);
  });
  it("rejects other key types", () => {
    expect(() => addressFromNearSecp256k1("ed25519:abc")).toThrow();
  });
});
