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
