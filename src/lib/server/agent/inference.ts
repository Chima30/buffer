/**
 * Every model call the agent makes goes through here:
 *   policy check (inference budget) -> NEAR AI Cloud gateway -> fetch signature
 *   -> verify against the attestation report -> record cost and proof.
 * The cost is recorded in micro-USD, which equals USDC smallest units (6 decimals).
 */
import { evaluate, type EvaluationContext } from "@/lib/domain/policy/evaluate";
import type { BusinessContext } from "../business";
import { db, must } from "../db";
import { nearAiConfig } from "../env";
import { chat, getAttestation, getSignature, inferenceCostUsdMicros, verifyChat, type ChatMessage, type VerificationLevel } from "../nearai";
import { recordAction } from "./actions";

export interface InferenceOutcome {
  inferenceCallId: string;
  content: string;
  costUsdMicros: bigint;
  chatId: string;
  verification: VerificationLevel | "UNVERIFIED";
}

function price() {
  const p = (k: string) => {
    const v = process.env[k];
    if (!v || !/^\d+$/.test(v)) throw new Error(`${k} must be set to the model's price in micro-USD per 1M tokens`);
    return BigInt(v);
  };
  return { inputUsdMicrosPerM: p("NEARAI_INPUT_USD_MICROS_PER_M"), outputUsdMicrosPerM: p("NEARAI_OUTPUT_USD_MICROS_PER_M") };
}

/** Rough upper estimate used for the budget check before the call. */
function estimateUsdMicros(messages: ChatMessage[], maxTokens: number): bigint {
  const inputTokens = BigInt(Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 3));
  const pr = price();
  return (inputTokens * pr.inputUsdMicrosPerM + BigInt(maxTokens) * pr.outputUsdMicrosPerM) / 1_000_000n + 1n;
}

export class PolicyDenied extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PolicyDenied";
  }
}

export async function runInference(params: {
  ctx: BusinessContext;
  evalCtx: EvaluationContext;
  orderId: string;
  purpose: string;
  messages: ChatMessage[];
  maxTokens: number;
  json?: boolean;
  idempotencyKey: string;
}): Promise<InferenceOutcome> {
  // Idempotency: a retried step reuses the stored result instead of paying twice.
  const prior = await db().from("agent_actions").select("result_ref").eq("idempotency_key", params.idempotencyKey).maybeSingle();
  if (prior.data?.result_ref) {
    const call = must(await db().from("inference_calls").select("id,chat_id,cost_usd_micros,verification_level").eq("id", prior.data.result_ref).single(), "prior inference");
    const content = must(await db().from("inference_outputs").select("content").eq("inference_call_id", call.id).single(), "prior inference output");
    return { inferenceCallId: call.id, content: content.content, costUsdMicros: BigInt(call.cost_usd_micros), chatId: call.chat_id, verification: call.verification_level };
  }

  const action = {
    tool: "run_inference" as const,
    agentId: params.ctx.agent.id,
    orderId: params.orderId,
    inferenceUsdMicros: estimateUsdMicros(params.messages, params.maxTokens),
  };
  const decision = evaluate(params.ctx.policy, action, params.evalCtx);
  if (decision.outcome !== "allow") {
    await recordAction({ agentId: params.ctx.agent.id, orderId: params.orderId, tool: "run_inference", args: { purpose: params.purpose }, decision, idempotencyKey: params.idempotencyKey });
    throw new PolicyDenied(decision.reasons[0]?.code ?? "DENIED", decision.reasons[0]?.message ?? "Inference denied by policy");
  }

  const cfg = nearAiConfig();
  let result;
  try {
    result = await chat({ messages: params.messages, maxTokens: params.maxTokens, temperature: 0.3, responseFormatJson: params.json });
  } catch (e) {
    if (!cfg.fallbackModel) throw e;
    result = await chat({ messages: params.messages, maxTokens: params.maxTokens, temperature: 0.3, responseFormatJson: params.json, model: cfg.fallbackModel });
  }
  const cost = inferenceCostUsdMicros(result.usage, price());

  let verification: VerificationLevel | "UNVERIFIED" = "UNVERIFIED";
  let sig: Awaited<ReturnType<typeof getSignature>> | null = null;
  try {
    sig = await getSignature(result.chatId, result.model);
    const att = await getAttestation(result.model);
    verification = (await verifyChat(result, sig, att.report)).level;
  } catch {
    verification = "UNVERIFIED";
  }

  const call = must(
    await db()
      .from("inference_calls")
      .insert({
        order_id: params.orderId,
        agent_id: params.ctx.agent.id,
        purpose: params.purpose,
        model: result.model,
        chat_id: result.chatId,
        tokens_in: result.usage.promptTokens,
        tokens_out: result.usage.completionTokens,
        cost_usd_micros: cost.toString(),
        request_hash: result.requestHash,
        response_hash: result.responseHash,
        signature_kind: sig?.signatureKind ?? null,
        signing_address: sig?.signingAddress ?? null,
        signature: sig?.signature ?? null,
        verification_level: verification,
      })
      .select("id")
      .single(),
    "insert inference call",
  );
  must(await db().from("inference_outputs").insert({ inference_call_id: call.id, content: result.content }).select("inference_call_id").single(), "insert inference output");
  await recordAction({
    agentId: params.ctx.agent.id,
    orderId: params.orderId,
    tool: "run_inference",
    args: { purpose: params.purpose, model: result.model },
    decision,
    idempotencyKey: params.idempotencyKey,
    resultRef: call.id,
  });
  return { inferenceCallId: call.id, content: result.content, costUsdMicros: cost, chatId: result.chatId, verification };
}
