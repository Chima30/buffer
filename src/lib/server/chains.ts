/**
 * EVM testnets the Buffer treasury can pay on through NEAR Chain Signatures.
 * One MPC-derived key controls the same treasury address on all of them; each
 * chain has its own USDC contract, RPC, explorer and (in the contract) its own
 * owner-set config, vendor approvals and nonce.
 */
import type { Chain } from "viem";
import { arbitrumSepolia, baseSepolia, sepolia } from "viem/chains";

export type EvmChainKey = "sepolia" | "base-sepolia" | "arbitrum-sepolia";
export type ChainKey = "near" | EvmChainKey;

export interface EvmChainInfo {
  key: EvmChainKey;
  name: string;
  chainId: number;
  usdc: `0x${string}`;
  rpcUrl: string;
  viem: Chain;
  explorer: string;
  /** Owner-side defaults offered by the console when switching the chain on. */
  defaults: { maxFeePerGasCapWei: string; gasLimit: number };
}

const env = (name: string, fallback: string) => {
  const v = process.env[name]?.trim();
  return v && !v.includes("<") ? v : fallback;
};

export function evmChains(): EvmChainInfo[] {
  return [
    {
      key: "sepolia",
      name: "Ethereum Sepolia",
      chainId: 11155111,
      usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      rpcUrl: env("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com"),
      viem: sepolia,
      explorer: "https://sepolia.etherscan.io",
      defaults: { maxFeePerGasCapWei: "100000000000", gasLimit: 100_000 },
    },
    {
      key: "base-sepolia",
      name: "Base Sepolia",
      chainId: 84532,
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      rpcUrl: env("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org"),
      viem: baseSepolia,
      explorer: "https://sepolia.basescan.org",
      defaults: { maxFeePerGasCapWei: "10000000000", gasLimit: 100_000 },
    },
    {
      key: "arbitrum-sepolia",
      name: "Arbitrum Sepolia",
      chainId: 421614,
      usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      rpcUrl: env("ARBITRUM_SEPOLIA_RPC_URL", "https://sepolia-rollup.arbitrum.io/rpc"),
      viem: arbitrumSepolia,
      // Arbitrum transfers use more gas units than L1 because of L1 data costs.
      explorer: "https://sepolia.arbiscan.io",
      defaults: { maxFeePerGasCapWei: "10000000000", gasLimit: 500_000 },
    },
  ];
}

export function chainById(chainId: number): EvmChainInfo {
  const c = evmChains().find((x) => x.chainId === chainId);
  if (!c) throw new Error(`Unknown EVM chain ${chainId}`);
  return c;
}

export function chainByKey(key: string): EvmChainInfo | null {
  return evmChains().find((x) => x.key === key) ?? null;
}

export const isEvmChain = (key: string): key is EvmChainKey => key !== "near";
