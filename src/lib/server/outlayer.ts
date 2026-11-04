/**
 * OutLayer Agent Custody wrapper. The agent wallet's keys live in OutLayer's
 * TEE; this server only holds the wallet API key (server env, never browser).
 *
 * Testnet supports: address, balance, transfer, call, policy, approvals.
 * Every /wallet/v1/intents/* and confidential route is mainnet-only (503 on testnet).
 *
 * Every effectful call here must be preceded by a Policy Engine "allow" (or a
 * revalidated approval) — enforced by the executor, not by this module.
 */
import { OutlayerClient, type CallResponse } from "@outlayer/sdk";
import { outlayerConfig } from "./env";

let cached: OutlayerClient | null = null;

export function outlayer(): OutlayerClient {
  if (cached) return cached;
  const cfg = outlayerConfig();
  cached = new OutlayerClient({
    apiKey: cfg.apiKey,
    network: cfg.network,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
  });
  return cached;
}

const CALL_GAS = "50000000000000"; // 50 TGas: request_purchase / mark_fulfilled
const SETTLE_GAS = "300000000000000"; // 300 TGas: settle fans out several ft_transfer promises
const EVM_GAS = "200000000000000"; // 200 TGas: request_evm_purchase -> MPC sign (50) -> callback (10)

export type AgentMethod = "request_purchase" | "request_evm_purchase" | "mark_fulfilled" | "settle" | "retry_leg" | "refill_agent_gas";

export async function agentAddress(): Promise<string> {
  const r = await outlayer().getAddress("near");
  return r.address;
}

/**
 * The agent's only on-chain actions: calls to the Buffer business contract.
 * It never transfers tokens itself; the contract pays vendors and payouts.
 * OutLayer's policy allowlists exactly this contract.
 */
export async function callContract(params: {
  contractId: string;
  method: AgentMethod;
  args: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<CallResponse> {
  return outlayer().call({
    receiver_id: params.contractId,
    method_name: params.method,
    args: params.args,
    gas: params.method === "settle" || params.method === "retry_leg" ? SETTLE_GAS : params.method === "request_evm_purchase" ? EVM_GAS : CALL_GAS,
    deposit: "0",
    idempotencyKey: params.idempotencyKey,
  });
}

/**
 * RED-TEAM ONLY. Sends a call the agent's normal code can never make (another
 * contract, an owner-only method, an unapproved vendor) so the security test can
 * show the custody policy and the contract refusing it. Used only by
 * src/lib/server/redteam.ts, behind RUNTIME_SECRET.
 */
export async function redteamCall(params: { receiverId: string; method: string; args: Record<string, unknown>; deposit?: string; idempotencyKey: string }): Promise<CallResponse> {
  return outlayer().call({
    receiver_id: params.receiverId,
    method_name: params.method,
    args: params.args,
    gas: CALL_GAS,
    deposit: params.deposit ?? "0",
    idempotencyKey: params.idempotencyKey,
  });
}

export async function requestStatus(requestId: string) {
  return outlayer().getRequest(requestId);
}

export async function currentPolicy() {
  return outlayer().policy.get();
}
