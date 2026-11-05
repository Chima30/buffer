/**
 * Demo data vendor. Payment to it is a REAL testnet USDC transfer made by the
 * Buffer contract; the dataset it releases is a small, static reference pack
 * written for this demo and labelled as such. It releases the data only after
 * confirming on-chain that the contract paid it for that order.
 */
import { getOrder } from "./contract";
import { nearConfig } from "./env";

export const VENDOR_DATASET = {
  label: "Demo vendor dataset: NEAR agent-infrastructure reference notes (static, compiled for the Buffer demo)",
  version: "2026-11-03",
  notes: [
    { topic: "NEAR Intents / 1Click", note: "1Click is a REST API: request a quote, deposit to the returned address, then poll status until SUCCESS, REFUNDED or FAILED. There is no testnet deployment; dry quotes preview prices without moving funds.", source: "https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction" },
    { topic: "Chain Signatures", note: "NEAR accounts and contracts can request signatures for other chains from an MPC signer contract (v1.signer on mainnet, v1.signer-prod.testnet on testnet). Foreign addresses are derived from the NEAR account and a derivation path.", source: "https://docs.near.org/chain-abstraction/chain-signatures/implementation" },
    { topic: "NEAR AI Cloud", note: "OpenAI-compatible inference through the gateway at cloud-api.near.ai. Private models run in Intel TDX confidential VMs with NVIDIA TEE GPUs; each response can be checked against a signature and the attestation report.", source: "https://docs.near.ai/cloud/private-inference" },
    { topic: "OutLayer Agent Custody", note: "Agent wallets whose keys are derived inside an Intel TDX enclave. An owner-set policy (stored encrypted on NEAR) limits transaction types, destinations and amounts; the owner can freeze the wallet with a direct on-chain call.", source: "https://github.com/out-layer/outlayer" },
    { topic: "NEP-141 tokens", note: "Fungible tokens on NEAR move with ft_transfer (1 yoctoNEAR attached) or ft_transfer_call, which lets the receiving contract accept or return the tokens. Receivers must be storage-registered first.", source: "https://nomicon.io/Standards/Tokens/FungibleToken/Core" },
  ],
};

export type DeliveryResult = { ok: true; dataset: typeof VENDOR_DATASET } | { ok: false; reason: string };

export async function deliverDataset(onchainOrderId: string, purchaseIndex: number): Promise<DeliveryResult> {
  const order = await getOrder(onchainOrderId);
  const p = order?.purchases[purchaseIndex];
  if (!p) return { ok: false, reason: "No such purchase on-chain" };
  if (p.vendor !== nearConfig().vendorAccountId) return { ok: false, reason: "Purchase was not made to this vendor" };
  if (p.status !== "Paid") return { ok: false, reason: `Purchase status is ${p.status}, not Paid` };
  return { ok: true, dataset: VENDOR_DATASET };
}

/**
 * Demo vendors on EVM testnets (Ethereum, Base, Arbitrum, OP Sepolia, Polygon Amoy, Avalanche Fuji). Payment is a REAL USDC transfer on that chain from the
 * Buffer treasury (signed by NEAR Chain Signatures); the dataset is a small static
 * pack written for this demo and labelled as such.
 */
export const EVM_VENDOR_DATASET = {
  label: "Demo vendor dataset: Ethereum & cross-chain reference notes (static, compiled for the Buffer demo)",
  version: "2026-11-04",
  notes: [
    { topic: "Chain Signatures", note: "A NEAR account or contract can control addresses on other chains. The MPC network signs a payload for a key derived from (account, path); the caller builds and broadcasts the foreign transaction.", source: "https://docs.near.org/chain-abstraction/chain-signatures" },
    { topic: "EIP-1559 transactions", note: "Type-2 Ethereum transactions carry maxFeePerGas and maxPriorityFeePerGas; the signed payload is keccak256(0x02 || rlp(fields)).", source: "https://eips.ethereum.org/EIPS/eip-1559" },
    { topic: "USDC on Ethereum Sepolia", note: "Circle publishes a testnet USDC contract on Sepolia (6 decimals) and a faucet for test funds; test USDC has no value.", source: "https://developers.circle.com/stablecoins/usdc-contract-addresses" },
    { topic: "ERC-20 transfer", note: "transfer(address,uint256) moves tokens from the sender and emits a Transfer(from, to, value) event, which is how a payment is verified from the receipt.", source: "https://eips.ethereum.org/EIPS/eip-20" },
  ],
};

export async function deliverEvmDataset(onchainOrderId: string, index: number, evmTxHash: string | null): Promise<{ ok: true; dataset: typeof EVM_VENDOR_DATASET } | { ok: false; reason: string }> {
  const { getEvmPurchases, treasury, verifyUsdcTransfer } = await import("./evm");
  if (!evmTxHash) return { ok: false, reason: "No EVM transaction recorded" };
  const p = (await getEvmPurchases(onchainOrderId))[index];
  if (!p || p.status !== "Signed") return { ok: false, reason: "Purchase is not signed on-chain" };
  const check = await verifyUsdcTransfer(evmTxHash as `0x${string}`, { token: p.token, from: await treasury(), to: p.vendor, amount: BigInt(p.amount), chainId: p.chain_id });
  return check.state === "CONFIRMED" ? { ok: true, dataset: EVM_VENDOR_DATASET } : { ok: false, reason: `Payment on chain ${p.chain_id} not confirmed (${check.state})` };
}
