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

describe("assembling a Chain Signatures transaction", async () => {
  const { serializeTransaction, keccak256, encodeFunctionData, erc20Abi } = await import("viem");
  const { sign } = await import("viem/accounts");
  const { assembleSigned } = await import("./evm");
  const pk = ("0x" + "22".repeat(32)) as `0x${string}`;
  const treasury = privateKeyToAccount(pk).address;
  const unsigned = serializeTransaction({
    type: "eip1559", chainId: 11155111, nonce: 0, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: 100000n,
    to: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: ["0x8fcf5415cc8c338d4523be5a04bb758b5437810f", 12000000n] }),
  });
  const hash = keccak256(unsigned);
  const sig = await sign({ hash, privateKey: pk });
  const purchase = {
    vendor: "0x8fcf5415cc8c338d4523be5a04bb758b5437810f", amount: "12000000", chain_id: 11155111, token: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
    gas_limit: 100000, max_fee_per_gas: "2", max_priority_fee_per_gas: "1", nonce: 0, payload_hash: hash.slice(2), status: "Signed" as const,
    signature: { big_r: `0${2 + (sig.yParity ?? 0)}${sig.r.slice(2)}`, s: sig.s.slice(2), recovery_id: sig.yParity ?? 0 },
  };

  it("rebuilds a transaction that recovers to the treasury", async () => {
    const out = await assembleSigned(unsigned.slice(2), purchase, treasury);
    expect(out.hash).toBe(keccak256(out.raw));
  });
  it("refuses bytes that are not what the contract signed", async () => {
    await expect(assembleSigned(unsigned.slice(2), { ...purchase, payload_hash: "00".repeat(32) }, treasury)).rejects.toThrow(/does not match/);
  });
  it("refuses a signature from any other key", async () => {
    await expect(assembleSigned(unsigned.slice(2), purchase, "0x0000000000000000000000000000000000000001")).rejects.toThrow(/not the treasury/);
  });
});
