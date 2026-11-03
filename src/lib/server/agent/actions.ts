import type { Decision } from "@/lib/domain/policy/evaluate";
import { db } from "../db";

const jsonSafe = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

/** Every agent action is recorded with its policy decision and reasons. Idempotent by key. */
export async function recordAction(a: {
  agentId: string;
  orderId: string | null;
  tool: string;
  args: Record<string, unknown>;
  decision: Decision;
  idempotencyKey: string;
  resultRef?: string;
}): Promise<void> {
  const { error } = await db()
    .from("agent_actions")
    .upsert(
      {
        agent_id: a.agentId,
        order_id: a.orderId,
        tool: a.tool,
        args: jsonSafe(a.args),
        decision: a.decision.outcome,
        reasons: jsonSafe(a.decision.reasons),
        policy_version: a.decision.policyVersion,
        idempotency_key: a.idempotencyKey,
        result_ref: a.resultRef ?? null,
      },
      { onConflict: "idempotency_key" },
    );
  if (error) throw new Error(`record action: ${error.message}`);
}
