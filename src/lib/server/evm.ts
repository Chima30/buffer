/**
 * Ethereum side of Chain Signatures.
 *
 * The treasury address is derived by the NEAR MPC network from
 * (predecessor = Buffer contract, path = "buffer-treasury"); nobody holds its key.
 * The contract builds and the MPC signs each transaction. This module only:
 *   1. reads the unsigned transaction and signature from the contract,
 *   2. checks the hash matches and the signature recovers to the treasury,
 *   3. broadcasts the exact signed bytes (re-broadcasting is harmless),
 *   4. verifies the USDC Transfer on Sepolia before anyone treats it as paid.
 */
import bs58 from "bs58";
import { createPublicClient, decodeEventLog, erc20Abi, http, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction, type Hex, type TransactionSerializableEIP1559 } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { sepolia } from "viem/chains";
import { nearConfig, sepoliaConfig } from "./env";
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

let treasuryCache: `0x${string}` | null = null;
export async function treasury(): Promise<`0x${string}`> {
  treasuryCache ??= await evmTreasuryAddress(nearConfig().contractId, sepoliaConfig().mpcContract);
  return treasuryCache;
}

export const sepoliaClient = () => createPublicClient({ chain: sepolia, transport: http(sepoliaConfig().rpcUrl) });

export interface OnchainEvmPurchase {
  vendor: string;
  amount: string;
  chain_id: number;
  token: string;
  gas_limit: number;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  nonce: number | null;
  payload_hash: string | null;
  status: "AwaitingApproval" | "Signing" | "Signed" | "Failed" | "Rejected";
  signature: { big_r: string; s: string; recovery_id: number } | null;
}

export async function getEvmPurchases(onchainOrderId: string): Promise<OnchainEvmPurchase[]> {
  return viewFunction<OnchainEvmPurchase[]>(nearConfig().contractId, "get_evm_purchases", { order_id: onchainOrderId });
}

export async function getEvmConfig(): Promise<{ chain_id: number; usdc: string; max_fee_per_gas_cap: string; gas_limit: number } | null> {
  return viewFunction(nearConfig().contractId, "get_evm_config", {});
}

/** Current Sepolia fees, clamped to the owner's cap stored in the contract. */
export async function offerFees(capWei: bigint): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const f = await sepoliaClient().estimateFeesPerGas();
  const maxFeePerGas = (f.maxFeePerGas * 2n < capWei ? f.maxFeePerGas * 2n : capWei) || 1n;
  const tip = f.maxPriorityFeePerGas ?? 1_000_000_000n;
  return { maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas };
}

/** Assembles the signed transaction from contract data, with every check that it is exactly what the contract built. */
export function assembleSigned(unsignedHex: string, p: OnchainEvmPurchase, expectedFrom: string): Promise<{ raw: Hex; hash: Hex }> {
  return (async () => {
    if (!p.signature || !p.payload_hash) throw new Error("Purchase is not signed yet");
    const unsigned = `0x${unsignedHex}` as Hex;
    if (keccak256(unsigned).slice(2) !== p.payload_hash.toLowerCase()) throw new Error("Unsigned transaction does not match the payload the contract signed");
    const tx = parseTransaction(unsigned) as TransactionSerializableEIP1559;
    if (tx.type !== "eip1559") throw new Error("Unexpected transaction type");
    const big = p.signature.big_r.toLowerCase().replace(/^0x/, "");
    if (big.length !== 66) throw new Error("Unexpected signature R encoding");
    const r = `0x${big.slice(2)}` as Hex; // x-coordinate of R
    const s = `0x${p.signature.s.replace(/^0x/, "")}` as Hex;
    const raw = serializeTransaction(tx, { r, s, yParity: p.signature.recovery_id });
    const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
    if (from.toLowerCase() !== expectedFrom.toLowerCase()) throw new Error(`Signature recovers to ${from}, not the treasury ${expectedFrom}`);
    return { raw, hash: keccak256(raw) };
  })();
}

/** Sends the signed bytes. Safe to repeat: the same bytes have the same hash and can only be mined once. */
export async function broadcast(raw: Hex, hash: Hex): Promise<Hex> {
  const client = sepoliaClient();
  try {
    const sent = await client.sendRawTransaction({ serializedTransaction: raw });
    if (sent.toLowerCase() !== hash.toLowerCase()) throw new Error(`Node returned hash ${sent}, expected ${hash}`);
  } catch (e) {
    const msg = (e as Error).message;
    // Already in the mempool or mined: fine, we track it by its hash.
    if (!/already known|known transaction|nonce too low|already imported/i.test(msg)) throw e;
  }
  return hash;
}

export type TransferCheck = { state: "CONFIRMED"; blockNumber: bigint } | { state: "PENDING" } | { state: "FAILED"; reason: string };

/** A payment is real only when its receipt succeeded and carries the exact USDC Transfer. */
export async function verifyUsdcTransfer(hash: Hex, p: { token: string; from: string; to: string; amount: bigint }): Promise<TransferCheck> {
  const client = sepoliaClient();
  const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt) return { state: "PENDING" };
  if (receipt.status !== "success") return { state: "FAILED", reason: "Transaction reverted on Sepolia" };
  const ok = receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== p.token.toLowerCase()) return false;
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      return ev.eventName === "Transfer" && ev.args.from.toLowerCase() === p.from.toLowerCase() && ev.args.to.toLowerCase() === p.to.toLowerCase() && ev.args.value === p.amount;
    } catch {
      return false;
    }
  });
  return ok ? { state: "CONFIRMED", blockNumber: receipt.blockNumber } : { state: "FAILED", reason: "No matching USDC Transfer in the receipt" };
}

export async function treasuryBalances(): Promise<{ address: string; eth: bigint; usdc: bigint } | null> {
  const cfg = await getEvmConfig();
  if (!cfg) return null;
  const address = await treasury();
  const client = sepoliaClient();
  const [eth, usdc] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: cfg.usdc as Hex, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
  ]);
  return { address, eth, usdc };
}
