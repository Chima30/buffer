/** Display names for the chains a purchase can be paid on (the `chain` column of procurements and vendors). */
export const CHAIN_NAMES: Record<string, string> = {
  near: "NEAR",
  sepolia: "Ethereum Sepolia",
  "base-sepolia": "Base Sepolia",
  "arbitrum-sepolia": "Arbitrum Sepolia",
  "op-sepolia": "OP Sepolia",
  "polygon-amoy": "Polygon Amoy",
  "avalanche-fuji": "Avalanche Fuji",
};

export const chainName = (chain: string | null | undefined): string => (chain ? (CHAIN_NAMES[chain] ?? chain) : "NEAR");
