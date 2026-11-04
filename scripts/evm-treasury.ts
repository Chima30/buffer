/**
 * npm run treasury -> prints the Buffer contract's Ethereum Sepolia treasury
 * address (Chain Signatures, path "buffer-treasury") and its ETH and USDC
 * balances. Read-only. Nobody holds this address's private key: only the
 * contract can ask the NEAR MPC network to sign for it.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const MPC = process.env.MPC_CONTRACT_ID || "v1.signer-prod.testnet";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

async function main() {
  const { evmTreasuryAddress } = await import("../src/lib/server/evm");
  const contractId = process.env.BUFFER_CONTRACT_ID;
  if (!contractId) throw new Error("BUFFER_CONTRACT_ID is not set");
  const address = await evmTreasuryAddress(contractId, MPC);
  console.log(`Treasury (Ethereum Sepolia) for ${contractId}: ${address}`);
  const { createPublicClient, http, erc20Abi, formatEther, formatUnits } = await import("viem");
  const { sepolia } = await import("viem/chains");
  const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
  const [eth, usdc] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
  ]);
  console.log(`ETH  ${formatEther(eth)}`);
  console.log(`USDC ${formatUnits(usdc, 6)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
