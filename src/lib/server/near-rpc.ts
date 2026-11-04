/**
 * Minimal NEAR JSON-RPC client for verification. We call RPC directly with
 * fetch so verification logic stays small and auditable. A transaction is
 * only REAL when its final outcome is SuccessValue/SuccessReceiptId on chain
 * and every receipt succeeded.
 */
import { nearConfig } from "./env";

interface RpcError {
  name?: string;
  cause?: { name?: string; info?: unknown };
  message?: string;
  data?: unknown;
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const { rpcUrl } = nearConfig();
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "buffer", method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const j = (await res.json()) as { result?: T; error?: RpcError };
  if (j.error) throw new Error(`RPC ${method} error: ${j.error.cause?.name ?? j.error.name ?? JSON.stringify(j.error)}`);
  return j.result as T;
}

export async function viewFunction<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
}

type ExecutionStatus =
  | { SuccessValue: string }
  | { SuccessReceiptId: string }
  | { Failure: unknown }
  | "Unknown"
  | "Pending";

interface TxStatusResult {
  final_execution_status?: string;
  status: ExecutionStatus;
  transaction: { hash: string; signer_id: string; receiver_id: string };
  receipts_outcome: { id: string; outcome: { status: ExecutionStatus; logs: string[]; executor_id: string } }[];
}

export type TxVerdict =
  | { state: "SUCCESS"; signerId: string; receiverId: string; logs: string[]; failedReceipts: number }
  | { state: "FAILED"; reason: string }
  | { state: "PENDING" };

export async function verifyTransaction(txHash: string, senderAccountId: string): Promise<TxVerdict> {
  let r: TxStatusResult;
  try {
    r = await rpc<TxStatusResult>("tx", { tx_hash: txHash, sender_account_id: senderAccountId, wait_until: "FINAL" });
  } catch (e) {
    const msg = (e as Error).message;
    // Not indexed yet, or the RPC node timed out / is overloaded: ask again later.
    if (/UNKNOWN_TRANSACTION|TIMEOUT_ERROR|HTTP 408|HTTP 429|HTTP 5\d\d/.test(msg)) return { state: "PENDING" };
    throw e;
  }
  const s = r.status;
  if (typeof s === "object" && "Failure" in s) return { state: "FAILED", reason: JSON.stringify(s.Failure).slice(0, 500) };
  if (s === "Unknown" || s === "Pending") return { state: "PENDING" };
  const failedReceipts = r.receipts_outcome.filter((o) => typeof o.outcome.status === "object" && "Failure" in o.outcome.status).length;
  return {
    state: "SUCCESS",
    signerId: r.transaction.signer_id,
    receiverId: r.transaction.receiver_id,
    logs: r.receipts_outcome.flatMap((o) => o.outcome.logs),
    failedReceipts,
  };
}

/** Parse NEP-297 events ("EVENT_JSON:{...}") from transaction logs. */
export function parseEvents(logs: string[]): { standard: string; event: string; data: unknown }[] {
  return logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice("EVENT_JSON:".length));
      } catch {
        return null;
      }
    })
    .filter((e): e is { standard: string; event: string; data: unknown } => !!e && typeof e.event === "string");
}

export async function ftBalance(tokenId: string, accountId: string): Promise<bigint> {
  const v = await viewFunction<string>(tokenId, "ft_balance_of", { account_id: accountId });
  return BigInt(v);
}

export async function isStorageRegistered(tokenId: string, accountId: string): Promise<boolean> {
  const v = await viewFunction<{ total: string } | null>(tokenId, "storage_balance_of", { account_id: accountId });
  return v !== null;
}
