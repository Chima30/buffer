/**
 * EVM testnets the Buffer treasury can pay on through NEAR Chain Signatures.
 * One MPC-derived key controls the same treasury address on all of them; each
 * chain has its own USDC contract, RPC, explorer and (in the contract) its own
 * owner-set config, vendor approvals and nonce.
 */
import type { Chain } from "viem";
import { arbitrumSepolia, avalancheFuji, baseSepolia, optimismSepolia, polygonAmoy, sepolia } from "viem/chains";

export type EvmChainKey = "sepolia" | "base-sepolia" | "arbitrum-sepolia" | "op-sepolia" | "polygon-amoy" | "avalanche-fuji";
/** The token each chain pays gas in; its USD price values gas in vendor bids. */
export type GasToken = "ETH" | "POL" | "AVAX";
export type ChainKey = "near" | EvmChainKey;

export interface EvmChainInfo {
  key: EvmChainKey;
  name: string;
  chainId: number;
  usdc: `0x${string}`;
  rpcUrl: string;
  viem: Chain;
  explorer: string;
  gasToken: GasToken;
  /** Lowest priority fee the chain accepts (Polygon rejects tips under 25 gwei). */
  minTipWei?: bigint;
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
      gasToken: "ETH",
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
      gasToken: "ETH",
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
      gasToken: "ETH",
      defaults: { maxFeePerGasCapWei: "10000000000", gasLimit: 500_000 },
    },
    {
      key: "op-sepolia",
      name: "OP Sepolia",
      chainId: 11155420,
      usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
      rpcUrl: env("OP_SEPOLIA_RPC_URL", "https://sepolia.optimism.io"),
      viem: optimismSepolia,
      explorer: "https://sepolia-optimism.etherscan.io",
      gasToken: "ETH",
      defaults: { maxFeePerGasCapWei: "10000000000", gasLimit: 100_000 },
    },
    {
      key: "polygon-amoy",
      name: "Polygon Amoy",
      chainId: 80002,
      usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
      rpcUrl: env("POLYGON_AMOY_RPC_URL", "https://rpc-amoy.polygon.technology"),
      viem: polygonAmoy,
      explorer: "https://amoy.polygonscan.com",
      gasToken: "POL",
      minTipWei: 30_000_000_000n,
      // Polygon requires a priority fee of at least 25 gwei.
      defaults: { maxFeePerGasCapWei: "200000000000", gasLimit: 100_000 },
    },
    {
      key: "avalanche-fuji",
      name: "Avalanche Fuji",
      chainId: 43113,
      usdc: "0x5425890298aed601595a70AB815c96711a31Bc65",
      rpcUrl: env("AVALANCHE_FUJI_RPC_URL", "https://api.avax-test.network/ext/bc/C/rpc"),
      viem: avalancheFuji,
      explorer: "https://testnet.snowtrace.io",
      gasToken: "AVAX",
      defaults: { maxFeePerGasCapWei: "100000000000", gasLimit: 100_000 },
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
