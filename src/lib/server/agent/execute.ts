/**
 * Executes an agent contract call through OutLayer and returns only verified
 * facts: the call is REAL once its transaction is final on NEAR testnet.
 */
import { bufferEventsFromTx, type BufferEvent } from "../contract";
import { nearConfig } from "../env";
import type { CallResponse } from "@outlayer/sdk";
import { callContract, requestStatus } from "../outlayer";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ExecResult =
  | { state: "CONFIRMED"; txHash: string; events: BufferEvent[] }
  | { state: "FAILED"; reason: string; txHash?: string }
  | { state: "PENDING"; requestId: string };

export async function execContractCall(params: {
  method: "request_purchase" | "mark_fulfilled" | "settle" | "retry_leg";
  args: Record<string, unknown>;
  idempotencyKey: string;
  agentAccount: string;
  maxWaitMs?: number;
}): Promise<ExecResult> {
  const { contractId } = nearConfig();
  const res = await callContract({ contractId, method: params.method, args: params.args, idempotencyKey: params.idempotencyKey });
  return followCall(res, params.agentAccount, params.maxWaitMs);
}

/** Follows an OutLayer call to a final, on-chain-verified result. */
export async function followCall(res: CallResponse, agentAccount: string, maxWaitMs = 45_000): Promise<ExecResult> {
  if (res.status === "pending_approval") {
    // Our OutLayer policy has no approval gate; approvals live in the business contract.
    return { state: "FAILED", reason: "OutLayer unexpectedly requested approval for a contract call" };
  }

  let txHash = res.tx_hash ?? null;
  let status: string = res.status;
  let failure: unknown = res.result ?? null;
  const deadline = Date.now() + maxWaitMs;
  while (!txHash && (status === "processing" || status === "approved" || status === "pending_deposit")) {
    if (Date.now() > deadline) return { state: "PENDING", requestId: res.request_id };
    await sleep(1500);
    const r = await requestStatus(res.request_id);
    status = r.status;
    const result = (r.result ?? {}) as Record<string, unknown>;
    failure = r.result ?? failure;
    txHash = (result.tx_hash as string | undefined) ?? (result.transaction_hash as string | undefined) ?? null;
  }
  if (status === "failed" || status === "rejected" || status === "refunded") {
    const detail = failure ? `: ${JSON.stringify(failure).slice(0, 300)}` : "";
    return { state: "FAILED", reason: `OutLayer request ${res.request_id} ${status}${detail}`, txHash: txHash ?? undefined };
  }
  if (!txHash) return { state: "PENDING", requestId: res.request_id };

  // Never trust the custody API's word alone: confirm the transaction on-chain.
  for (let i = 0; i < 10; i++) {
    const v = await bufferEventsFromTx(txHash, agentAccount);
    if (v.state === "SUCCESS") return { state: "CONFIRMED", txHash, events: v.events };
    if (v.state === "FAILED") return { state: "FAILED", reason: v.reason, txHash };
    await sleep(1500);
  }
  return { state: "PENDING", requestId: res.request_id };
}
