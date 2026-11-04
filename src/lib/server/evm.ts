/**
 * Ethereum side of Chain Signatures. The treasury address is derived by the
 * NEAR MPC network from (predecessor = Buffer contract, path = "buffer-treasury").
 */
import bs58 from "bs58";
import { publicKeyToAddress } from "viem/accounts";
import { viewFunction } from "./near-rpc";

export const EVM_TREASURY_PATH = "buffer-treasury";

/** "secp256k1:<base58 of 64-byte x||y>" -> 0x address. */
export function addressFromNearSecp256k1(key: string): `0x${string}` {
  const [curve, b58] = key.split(":");
  if (curve !== "secp256k1" || !b58) throw new Error(`Not a secp256k1 key: ${key}`);
  const raw = bs58.decode(b58);
  if (raw.length !== 64) throw new Error(`Expected 64 key bytes, got ${raw.length}`);
  return publicKeyToAddress(`0x04${Buffer.from(raw).toString("hex")}`);
}

export async function evmTreasuryAddress(contractId: string, mpcContract: string): Promise<`0x${string}`> {
  const key = await viewFunction<string>(mpcContract, "derived_public_key", { path: EVM_TREASURY_PATH, predecessor: contractId, domain_id: 0 });
  return addressFromNearSecp256k1(key);
}
