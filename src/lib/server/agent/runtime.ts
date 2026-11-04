/**
 * Buffer business runtime for the Verified Research Desk.
 *
 * Each order advances through short, idempotent steps stored as jobs:
 *   plan -> (procure -> await_purchase) -> draft -> deliver -> settle
 * Every step reloads the business, checks the on-chain policy anchor and pause
 * flag, and asks the policy engine before acting. Money only moves through the
 * business contract; the database records what the chain confirmed.
 */
import { createHash } from "node:crypto";
import { assertTransition, type OrderState } from "@/lib/domain/order-machine";
import { evaluate } from "@/lib/domain/policy/evaluate";
import { formatUnits } from "@/lib/domain/money";
import { computeSettlement, type ExpenseInput } from "@/lib/domain/revenue";
import { HaltError, evaluationContext, loadBusinessAnchored, scopeFor, type BusinessContext } from "../business";
import { getOrder, getTreasury } from "../contract";
import { db, must } from "../db";
import { nearConfig, sepoliaConfig } from "../env";
import { assembleSigned, broadcast, getEvmConfig, getEvmPurchases, offerFees, treasury, verifyUsdcTransfer } from "../evm";
import { viewFunction } from "../near-rpc";
import { audit, writeLedger } from "../ledger";
import { deliverDataset, deliverEvmDataset } from "../vendor";
import { recordAction } from "./actions";
import { execContractCall } from "./execute";
import { PolicyDenied, runInference } from "./inference";
import { draftMessages, parsePlan, planMessages, type Plan } from "./prompts";

export type Step = "plan" | "procure" | "await_purchase" | "draft" | "deliver" | "settle" | "retry_legs";

interface OrderRow {
  id: string;
  business_id: string;
  state: OrderState;
  brief: string;
  price_units: string;
  onchain_order_id: string;
  product_id: string;
  plan: Plan | null;
}

type StepResult = { next?: Step; delaySec?: number; repeat?: boolean };

// ---------- helpers ----------

export async function loadOrder(id: string): Promise<OrderRow> {
  return must(await db().from("orders").select("id,business_id,state,brief,price_units,onchain_order_id,product_id,plan").eq("id", id).single(), "order");
}

export async function transition(order: OrderRow, to: OrderState, reason: string): Promise<void> {
  if (order.state === to) return;
  assertTransition(order.state, to);
  const r = await db().from("orders").update({ state: to }).eq("id", order.id).eq("state", order.state).select("id");
  if (r.error) throw new Error(`transition: ${r.error.message}`);
  if (!r.data?.length) throw new Error(`Order ${order.id} changed state concurrently`);
  await db().from("order_transitions").insert({ order_id: order.id, from_state: order.state, to_state: to, reason });
  order.state = to;
}

export async function enqueue(orderId: string, step: Step, delaySec = 0): Promise<void> {
  const { error } = await db()
    .from("jobs")
    .upsert(
      { order_id: orderId, step, status: "queued", run_after: new Date(Date.now() + delaySec * 1000).toISOString(), lease_until: null, last_error: null },
      { onConflict: "order_id,step" },
    );
  if (error) throw new Error(`enqueue: ${error.message}`);
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function notifyOwner(businessId: string, type: string, payload: Record<string, unknown>) {
  await db().from("notifications").insert({ business_id: businessId, type, payload });
}

// ---------- steps ----------

async function stepPlan(order: OrderRow, ctx: BusinessContext): Promise<StepResult> {
  if (order.state === "PAID") await transition(order, "PLANNING", "agent picked up paid order");
  const evalCtx = await evaluationContext(ctx);
  const out = await runInference({
    ctx,
    evalCtx,
    orderId: order.id,
    purpose: "plan",
    messages: planMessages(order.brief, ctx.product.title, {
      name: ctx.vendor.name,
      description: ctx.vendor.description ?? "Reference notes on NEAR agent infrastructure (Intents, Chain Signatures, NEAR AI Cloud, OutLayer, NEP-141).",
      priceUsdc: formatUnits(BigInt(ctx.vendor.unit_price_units)),
    }),
    maxTokens: 1200,
    json: true,
    idempotencyKey: `${order.id}:plan`,
  });
  const plan = parsePlan(out.content);
  must(await db().from("orders").update({ plan }).eq("id", order.id).select("id").single(), "save plan");
  if (plan.injection_detected) {
    await audit(order.business_id, "agent", "possible_prompt_injection", order.id, { note: "Planner flagged instructions inside the customer brief; they were ignored." });
  }
  if (plan.use_dataset) {
    await transition(order, "PROCURING", `plan: ${plan.dataset_reason || "dataset needed"}`);
    return { next: "procure" };
  }
  await transition(order, "DRAFTING", "plan: no dataset needed");
  return { next: "draft" };
}

async function stepProcure(order: OrderRow, ctx: BusinessContext): Promise<StepResult> {
  if (ctx.vendor.chain === "sepolia") return stepProcureEvm(order, ctx);
  const { usdcTokenId } = nearConfig();
  const amount = BigInt(ctx.vendor.unit_price_units);
  const action = {
    tool: "request_purchase" as const,
    agentId: ctx.agent.id,
    orderId: order.id,
    amountUnits: amount,
    tokenId: usdcTokenId,
    destination: ctx.vendor.near_account ?? undefined,
    vendorId: ctx.vendor.id,
  };
  const key = `${order.id}:purchase:1`;
  const decision = evaluate(ctx.policy, action, await evaluationContext(ctx));
  await recordAction({ agentId: ctx.agent.id, orderId: order.id, tool: "request_purchase", args: action, decision, idempotencyKey: key });

  if (decision.outcome === "deny") {
    await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: "purchase_blocked", status: "FAILED", amountUnits: amount, counterparty: ctx.vendor.near_account, details: { reasons: decision.reasons } });
    await transition(order, "DRAFTING", `purchase blocked: ${decision.reasons[0]?.code}`);
    return { next: "draft" };
  }

  const existing = await db().from("procurements").select("id,status,onchain_index").eq("idempotency_key", key).maybeSingle();
  if (existing.data && existing.data.onchain_index !== null) return { next: "await_purchase" };
  const proc: { id: string; status: string; onchain_index: number | null } =
    existing.data ??
    must(await db().from("procurements").insert({ order_id: order.id, vendor_id: ctx.vendor.id, amount_units: amount.toString(), status: "proposed", idempotency_key: key }).select("id,status,onchain_index").single(), "insert procurement");

  const res = await execContractCall({
    method: "request_purchase",
    args: { order_id: order.onchain_order_id, vendor: ctx.vendor.near_account, amount: amount.toString(), memo: "market-dataset" },
    idempotencyKey: key,
    agentAccount: ctx.agent.near_account,
  });
  if (res.state === "PENDING") return { repeat: true, delaySec: 10 };
  if (res.state === "FAILED") {
    await db().from("procurements").update({ status: "failed" }).eq("id", proc.id);
    await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: "purchase_failed", status: "FAILED", amountUnits: amount, counterparty: ctx.vendor.near_account, details: { reason: res.reason } });
    await transition(order, "DRAFTING", "purchase request failed");
    return { next: "draft" };
  }

  const ev = res.events.find((e) => e.event === "purchase_awaiting_approval" || e.event === "purchase_requested");
  const index = Number(ev?.data.index ?? 0);
  const paid = res.events.some((e) => e.event === "purchase_paid");
  const awaiting = ev?.event === "purchase_awaiting_approval";
  await db().from("procurements").update({ onchain_index: index, status: paid ? "confirmed" : awaiting ? "awaiting_approval" : "submitted", tx_hash: paid ? res.txHash : null }).eq("id", proc.id);

  if (paid) {
    await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: "vendor_paid", status: "REAL", amountUnits: amount, counterparty: ctx.vendor.near_account, txHash: res.txHash, verifiedOnChain: true });
    await db().from("expenses").upsert({ order_id: order.id, category: "supplier", amount_units: amount.toString(), status: "PAID", evidence_ref: `tx:${res.txHash}`, reimburse_to: "escrow" }, { onConflict: "order_id,evidence_ref" });
    await transition(order, "DRAFTING", "dataset purchased");
    return { next: "draft" };
  }
  if (awaiting) {
    await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: "purchase_awaiting_approval", status: "PENDING", amountUnits: amount, counterparty: ctx.vendor.near_account, details: { request_tx: res.txHash, index } });
    await notifyOwner(order.business_id, "purchase_approval", {
      order: order.onchain_order_id,
      index,
      vendor: ctx.vendor.near_account,
      amount: formatUnits(amount),
      approve_command: `near --% contract call-function as-transaction ${nearConfig().contractId} approve_purchase json-args "{\\"order_id\\":\\"${order.onchain_order_id}\\",\\"index\\":${index}}" prepaid-gas "100 Tgas" attached-deposit "0 NEAR" sign-as ${nearConfig().ownerAccountId} network-config testnet sign-with-keychain send`,
    });
    await transition(order, "AWAITING_APPROVAL", `purchase of ${formatUnits(amount)} USDC needs owner approval`);
  }
  return { next: "await_purchase", delaySec: 10 };
}

async function stepAwaitPurchase(order: OrderRow, ctx: BusinessContext): Promise<StepResult> {
  const proc = must(await db().from("procurements").select("id,status,onchain_index,amount_units,chain").eq("order_id", order.id).order("created_at", { ascending: false }).limit(1).single(), "procurement");
  if (proc.chain === "sepolia") return stepAwaitEvm(order, ctx, proc);
  const onchain = await getOrder(order.onchain_order_id);
  const p = onchain?.purchases[proc.onchain_index ?? 0];
  if (!p) throw new Error("Purchase not found on-chain");
  if (p.status === "AwaitingApproval" || p.status === "Sending") return { repeat: true, delaySec: p.status === "Sending" ? 5 : 15 };

  if (p.status === "Paid") {
    if (proc.status !== "confirmed") {
      await db().from("procurements").update({ status: "confirmed" }).eq("id", proc.id);
      // The approval transaction was signed by the owner; /api/approvals/confirm records its hash in the ledger.
      await db().from("expenses").upsert({ order_id: order.id, category: "supplier", amount_units: proc.amount_units, status: "PAID", evidence_ref: `onchain:${order.onchain_order_id}:purchase:${proc.onchain_index}`, reimburse_to: "escrow" }, { onConflict: "order_id,evidence_ref" });
    }
    if (order.state === "AWAITING_APPROVAL") await transition(order, "DRAFTING", "owner approved; vendor paid by contract");
    else if (order.state === "PROCURING") await transition(order, "DRAFTING", "vendor paid by contract");
    return { next: "draft" };
  }
  await db().from("procurements").update({ status: p.status === "Rejected" ? "rejected" : "failed" }).eq("id", proc.id);
  await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: p.status === "Rejected" ? "purchase_rejected" : "purchase_failed", status: "FAILED", amountUnits: BigInt(proc.amount_units), counterparty: ctx.vendor.near_account });
  await transition(order, "DRAFTING", `purchase ${p.status.toLowerCase()}; drafting without dataset`);
  return { next: "draft" };
}

// ---------- cross-chain purchase (Chain Signatures, Ethereum Sepolia) ----------

const evmApproveCommand = (orderId: string, index: number) =>
  `near --% contract call-function as-transaction ${nearConfig().contractId} approve_evm_purchase json-args "{\\"order_id\\":\\"${orderId}\\",\\"index\\":${index}}" prepaid-gas "150 Tgas" attached-deposit "0 NEAR" sign-as ${nearConfig().ownerAccountId} network-config testnet sign-with-keychain send`;

async function stepProcureEvm(order: OrderRow, ctx: BusinessContext): Promise<StepResult> {
  const cfg = await getEvmConfig();
  if (!cfg) throw new HaltError("Cross-chain purchases are not configured on the contract");
  const vendorAddress = ctx.vendor.evm_address;
  if (!vendorAddress) throw new Error("Cross-chain vendor has no address");
  const amount = BigInt(ctx.vendor.unit_price_units);
  const action = { tool: "request_crosschain_purchase" as const, agentId: ctx.agent.id, orderId: order.id, amountUnits: amount, tokenId: cfg.usdc, destination: vendorAddress, vendorId: ctx.vendor.id };
  const key = `${order.id}:evm-purchase:1`;
  const decision = evaluate(ctx.policy, action, await evaluationContext(ctx));
  await recordAction({ agentId: ctx.agent.id, orderId: order.id, tool: action.tool, args: action, decision, idempotencyKey: key });
  if (decision.outcome === "deny") {
    await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: "purchase_blocked", status: "FAILED", amountUnits: amount, counterparty: vendorAddress, details: { chain: "sepolia", reasons: decision.reasons } });
    await transition(order, "DRAFTING", `cross-chain purchase blocked: ${decision.reasons[0]?.code}`);
    return { next: "draft" };
  }

  const existing = await db().from("procurements").select("id,onchain_index").eq("idempotency_key", key).maybeSingle();
  if (existing.data && existing.data.onchain_index !== null) return { next: "await_purchase" };
  const proc: { id: string } =
    existing.data ?? must(await db().from("procurements").insert({ order_id: order.id, vendor_id: ctx.vendor.id, amount_units: amount.toString(), status: "proposed", idempotency_key: key, chain: "sepolia" }).select("id").single(), "insert procurement");

  const fees = await offerFees(BigInt(cfg.max_fee_per_gas_cap));
  const res = await execContractCall({
    method: "request_evm_purchase",
    args: { order_id: order.onchain_order_id, vendor: vendorAddress, amount: amount.toString(), max_fee_per_gas: fees.maxFeePerGas.toString(), max_priority_fee_per_gas: fees.maxPriorityFeePerGas.toString() },
    idempotencyKey: key,
    agentAccount: ctx.agent.near_account,
    maxWaitMs: 90_000,
  });
  if (res.state === "PENDING") return { repeat: true, delaySec: 15 };
  if (res.state === "FAILED") {
    await db().from("procurements").update({ status: "failed" }).eq("id", proc.id);
    await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: "purchase_failed", status: "FAILED", amountUnits: amount, counterparty: vendorAddress, details: { chain: "sepolia", reason: res.reason } });
    await transition(order, "DRAFTING", "cross-chain purchase request failed");
    return { next: "draft" };
  }
  const ev = res.events.find((e) => e.event === "evm_purchase_awaiting_approval" || e.event === "evm_purchase_requested");
  const index = Number(ev?.data.index ?? 0);
  const awaiting = ev?.event === "evm_purchase_awaiting_approval";
  await db().from("procurements").update({ onchain_index: index, status: awaiting ? "awaiting_approval" : "submitted", tx_hash: res.txHash }).eq("id", proc.id);
  if (awaiting) {
    await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: "purchase_awaiting_approval", status: "PENDING", amountUnits: amount, counterparty: vendorAddress, details: { chain: "sepolia", request_tx: res.txHash, index } });
    await notifyOwner(order.business_id, "purchase_approval", { order: order.onchain_order_id, index, chain: "sepolia", vendor: vendorAddress, amount: formatUnits(amount), approve_command: evmApproveCommand(order.onchain_order_id, index) });
    await transition(order, "AWAITING_APPROVAL", `cross-chain purchase of ${formatUnits(amount)} USDC needs owner approval`);
  }
  return { next: "await_purchase", delaySec: 10 };
}

async function stepAwaitEvm(order: OrderRow, ctx: BusinessContext, proc: { id: string; status: string; onchain_index: number | null; amount_units: string }): Promise<StepResult> {
  const list = await getEvmPurchases(order.onchain_order_id);
  const p = list[proc.onchain_index ?? 0];
  if (!p) throw new Error("Cross-chain purchase not found on-chain");
  if (p.status === "AwaitingApproval" || p.status === "Signing") return { repeat: true, delaySec: p.status === "Signing" ? 5 : 15 };

  if (p.status === "Signed") {
    const from = await treasury();
    const unsigned = await viewFunction<string | null>(nearConfig().contractId, "get_evm_unsigned_tx", { order_id: order.onchain_order_id, index: proc.onchain_index ?? 0 });
    if (!unsigned) throw new Error("Contract returned no unsigned transaction");
    const { raw, hash } = await assembleSigned(unsigned, p, from);
    if (proc.status !== "confirmed") {
      await db().from("procurements").update({ evm_tx_hash: hash, evm_nonce: p.nonce, status: "submitted" }).eq("id", proc.id);
      await broadcast(raw, hash);
    }
    const check = await verifyUsdcTransfer(hash, { token: p.token, from, to: p.vendor, amount: BigInt(p.amount) });
    if (check.state === "PENDING") return { repeat: true, delaySec: 10 };
    if (check.state === "FAILED") {
      // Signed and counted as spent by the contract, but not paid: the owner is told; no retry with new bytes.
      await db().from("procurements").update({ status: "failed" }).eq("id", proc.id);
      await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: "purchase_failed", status: "FAILED", amountUnits: BigInt(p.amount), counterparty: p.vendor, details: { chain: "sepolia", reason: check.reason, evm_tx: hash } });
      await notifyOwner(order.business_id, "crosschain_payment_failed", { order: order.onchain_order_id, evm_tx: hash, reason: check.reason });
      await transition(order, "DRAFTING", "cross-chain payment did not land; drafting without dataset");
      return { next: "draft" };
    }
    if (proc.status !== "confirmed") {
      await db().from("procurements").update({ status: "confirmed" }).eq("id", proc.id);
      await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: "vendor_paid", status: "REAL", amountUnits: BigInt(p.amount), tokenId: p.token, counterparty: p.vendor, txHash: hash, verifiedOnChain: true, explorerUrl: sepoliaConfig().explorerTxUrl(hash), details: { chain: "sepolia", from, nonce: p.nonce, block: check.blockNumber.toString(), signed_by: "NEAR Chain Signatures (MPC)" } });
      await db().from("expenses").upsert({ order_id: order.id, category: "supplier", amount_units: p.amount, status: "PAID", evidence_ref: `sepolia:${hash}`, reimburse_to: "owner" }, { onConflict: "order_id,evidence_ref" });
    }
    if (order.state === "AWAITING_APPROVAL" || order.state === "PROCURING") await transition(order, "DRAFTING", "vendor paid on Ethereum Sepolia via Chain Signatures");
    return { next: "draft" };
  }
  await db().from("procurements").update({ status: p.status === "Rejected" ? "rejected" : "failed" }).eq("id", proc.id);
  await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: p.status === "Rejected" ? "purchase_rejected" : "purchase_failed", status: "FAILED", amountUnits: BigInt(proc.amount_units), counterparty: p.vendor, details: { chain: "sepolia" } });
  await transition(order, "DRAFTING", `cross-chain purchase ${p.status.toLowerCase()}; drafting without dataset`);
  return { next: "draft" };
}

async function stepDraft(order: OrderRow, ctx: BusinessContext): Promise<StepResult> {
  const proc = await db().from("procurements").select("status,onchain_index,chain,evm_tx_hash,amount_units").eq("order_id", order.id).eq("status", "confirmed").maybeSingle();
  let dataset: unknown = null;
  if (proc.data) {
    const d =
      proc.data.chain === "sepolia"
        ? await deliverEvmDataset(order.onchain_order_id, proc.data.onchain_index ?? 0, proc.data.evm_tx_hash)
        : await deliverDataset(order.onchain_order_id, proc.data.onchain_index ?? 0);
    if (d.ok) dataset = d.dataset;
  }
  const out = await runInference({
    ctx,
    evalCtx: await evaluationContext(ctx),
    orderId: order.id,
    purpose: "draft",
    messages: draftMessages(order.brief, order.plan ?? { title: ctx.product.title, angles: [] }, dataset),
    maxTokens: 1600,
    idempotencyKey: `${order.id}:draft`,
  });
  const content = out.content.trim();
  if (content.length < 200) throw new Error("Draft too short; will retry");
  const hash = sha256(content);
  await db().from("reports").upsert({ order_id: order.id, content, content_hash: hash, inference_call_id: out.inferenceCallId, storage_path: null }, { onConflict: "order_id" });
  return { next: "deliver" };
}

async function stepDeliver(order: OrderRow, ctx: BusinessContext, attempt: number): Promise<StepResult> {
  const report = must(await db().from("reports").select("content_hash").eq("order_id", order.id).single(), "report");
  const sale = { tool: "deliver_report" as const, agentId: ctx.agent.id, orderId: order.id, sku: ctx.product.sku, priceUnits: BigInt(order.price_units) };
  const decision = evaluate(ctx.policy, sale, await evaluationContext(ctx));
  const key = `${order.id}:deliver`;
  await recordAction({ agentId: ctx.agent.id, orderId: order.id, tool: "deliver_report", args: sale, decision, idempotencyKey: key });
  if (decision.outcome !== "allow") throw new PolicyDenied(decision.reasons[0]?.code ?? "DENIED", decision.reasons[0]?.message ?? "Delivery denied");

  const onchain = await getOrder(order.onchain_order_id);
  if (onchain?.state === "Paid") {
    // Fresh OutLayer key per attempt: a failed request is cached under its key, and the
    // contract itself refuses a second mark_fulfilled, so retries cannot double-act.
    const res = await execContractCall({ method: "mark_fulfilled", args: { order_id: order.onchain_order_id, report_hash: report.content_hash }, idempotencyKey: `${key}:a${attempt}`, agentAccount: ctx.agent.near_account });
    if (res.state === "PENDING") return { repeat: true, delaySec: 10 };
    if (res.state === "FAILED") throw new Error(`mark_fulfilled failed: ${res.reason}`);
    await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: "order_fulfilled", status: "REAL", txHash: res.txHash, verifiedOnChain: true, details: { report_hash: report.content_hash } });
  } else if (onchain?.state !== "Fulfilled") {
    throw new Error(`Cannot deliver: on-chain order is ${onchain?.state ?? "missing"}`);
  }
  await transition(order, "DELIVERED", "report delivered; hash recorded on-chain");
  return { next: "settle" };
}

async function stepSettle(order: OrderRow, ctx: BusinessContext, attempt: number): Promise<StepResult> {
  const onchain = await getOrder(order.onchain_order_id);
  if (!onchain) throw new Error("Order missing on-chain");

  const calls = must<{ id: string; chat_id: string; cost_usd_micros: string }[]>(await db().from("inference_calls").select("id,chat_id,cost_usd_micros").eq("order_id", order.id), "inference calls");
  const vendorPaid = onchain.purchases.filter((p) => p.status === "Paid");
  const evmSigned = (await getEvmPurchases(order.onchain_order_id).catch(() => [])).filter((p) => p.status === "Signed");
  const expenses: ExpenseInput[] = [
    ...vendorPaid.map((p, i) => ({ id: `vendor-${i}`, category: "supplier" as const, amount: BigInt(p.amount), status: "PAID" as const, evidenceRef: `onchain-purchase-${i}` })),
    ...evmSigned.map((p, i) => ({ id: `evm-${i}`, category: "treasury" as const, amount: BigInt(p.amount), status: "PAID" as const, evidenceRef: `evm-nonce-${p.nonce}` })),
    ...calls.map((c) => ({ id: c.id, category: "inference" as const, amount: BigInt(c.cost_usd_micros), status: "METERED" as const, evidenceRef: `chat:${c.chat_id}` })),
  ];
  // Off-chain preview with the same formula the contract runs; used for reconciliation.
  const t = onchain.state === "Fulfilled" ? await getTreasury() : null;
  const preview = computeSettlement({ gross: BigInt(onchain.gross), maxExpense: BigInt(ctx.product.max_expense_units), contributorBps: ctx.contributorBps, expenses, reserve: t ? { bps: t.reserve_bps, target: BigInt(t.reserve_target), balance: BigInt(t.reserve_balance) } : undefined });

  if (onchain.state === "Fulfilled") {
    if (order.state === "DELIVERED") await transition(order, "SETTLING", "settlement requested");
    const claims = calls
      .filter((c) => BigInt(c.cost_usd_micros) > 0n)
      .map((c) => ({ category: "Inference", amount: c.cost_usd_micros.toString(), evidence_ref: `chat:${c.chat_id}`.slice(0, 128) }));
    for (const c of calls) {
      await db().from("expenses").upsert({ order_id: order.id, category: "inference", amount_units: c.cost_usd_micros.toString(), status: "METERED", evidence_ref: `chat:${c.chat_id}`, reimburse_to: "owner" }, { onConflict: "order_id,evidence_ref" });
    }
    const res = await execContractCall({ method: "settle", args: { order_id: order.onchain_order_id, claims }, idempotencyKey: `${order.id}:settle:a${attempt}`, agentAccount: ctx.agent.near_account, maxWaitMs: 60_000 });
    if (res.state === "PENDING") return { repeat: true, delaySec: 10 };
    if (res.state === "FAILED") throw new Error(`settle failed: ${res.reason}`);
    await recordSettlement(order, res.txHash, preview);
  } else if (onchain.state === "Settling" || onchain.state === "Settled") {
    if (order.state === "DELIVERED") await transition(order, "SETTLING", "settlement found on-chain");
  } else {
    throw new Error(`Cannot settle: on-chain order is ${onchain.state}`);
  }

  const after = await getOrder(order.onchain_order_id);
  if (after?.state === "Settled") {
    await transition(order, "SETTLED", "all payout legs confirmed on-chain");
    return {};
  }
  return { next: "retry_legs", delaySec: 15 };
}

async function recordSettlement(order: OrderRow, txHash: string, preview: ReturnType<typeof computeSettlement>) {
  const onchain = await getOrder(order.onchain_order_id);
  if (!onchain) return;
  const leg = (k: string) => BigInt(onchain.legs.find((l) => l.kind === k)?.amount ?? "0");
  const paidToVendors = onchain.purchases.filter((p) => p.status === "Paid").reduce((a, p) => a + BigInt(p.amount), 0n);
  const gross = BigInt(onchain.gross);
  const counted = BigInt(onchain.expenses_counted);
  const row = {
    order_id: order.id,
    formula_version: preview.formulaVersion,
    gross: gross.toString(),
    expenses_counted: counted.toString(),
    expenses_uncounted: preview.expensesUncounted.toString(),
    distributable: (gross - counted).toString(),
    owner_share: (leg("Owner") + leg("Reserve")).toString(),
    contributor_share: leg("Contributor").toString(),
    paid_to_vendors: paidToVendors.toString(),
    reimb_owner: leg("ReimbOwner").toString(),
  };
  await db().from("revenue_records").upsert(row, { onConflict: "order_id" });
  // The owner's share is what they were paid plus what the reserve kept.
  if (preview.ownerShare !== leg("Owner") + leg("Reserve") || preview.contributorShare !== leg("Contributor")) {
    await audit(order.business_id, "runtime", "reconciliation_mismatch", order.id, { preview: { owner: preview.ownerShare.toString(), contributor: preview.contributorShare.toString() }, onchain: row });
  }
  const kindToLeg: Record<string, string> = { Owner: "owner", Contributor: "contributor", ReimbOwner: "reimb_owner", Reserve: "reserve" };
  // What the owner's reimbursement is for: the Ethereum treasury purchases first, then inference.
  const treasuryPaid = (await getEvmPurchases(order.onchain_order_id).catch(() => [])).filter((p) => p.status === "Signed").reduce((a, p) => a + BigInt(p.amount), 0n);
  const reimb = leg("ReimbOwner");
  const reimbTreasury = treasuryPaid < reimb ? treasuryPaid : reimb;
  const reimbBreakdown = { treasury_units: reimbTreasury.toString(), inference_units: (reimb - reimbTreasury).toString() };
  for (const l of onchain.legs) {
    const status = l.status === "Confirmed" ? "CONFIRMED" : l.status === "Failed" ? "FAILED" : "SUBMITTED";
    await db().from("distributions").upsert({ order_id: order.id, leg: kindToLeg[l.kind], recipient: l.recipient, amount_units: l.amount, status, tx_hash: txHash, attempts: l.attempts }, { onConflict: "order_id,leg" });
    await writeLedger({
      businessId: order.business_id,
      orderId: order.id,
      eventType: `payout_${kindToLeg[l.kind]}`,
      status: l.status === "Confirmed" ? "REAL" : l.status === "Failed" ? "FAILED" : "PENDING",
      amountUnits: BigInt(l.amount),
      counterparty: l.recipient,
      txHash: l.status === "Confirmed" ? txHash : null,
      verifiedOnChain: l.status === "Confirmed",
      details: l.kind === "ReimbOwner" ? reimbBreakdown : undefined,
    });
  }
}

async function stepRetryLegs(order: OrderRow, ctx: BusinessContext): Promise<StepResult> {
  const onchain = await getOrder(order.onchain_order_id);
  if (!onchain) throw new Error("Order missing on-chain");
  if (onchain.state === "Settled") {
    await transition(order, "SETTLED", "all payout legs confirmed on-chain");
    return {};
  }
  const failed = onchain.legs.map((l, i) => ({ l, i })).filter(({ l }) => l.status === "Failed");
  for (const { l, i } of failed) {
    const res = await execContractCall({ method: "retry_leg", args: { order_id: order.onchain_order_id, leg_index: i }, idempotencyKey: `${order.id}:retry:${i}:${l.attempts}`, agentAccount: ctx.agent.near_account });
    if (res.state === "CONFIRMED") {
      const kind = ({ Owner: "owner", Contributor: "contributor", ReimbOwner: "reimb_owner" } as Record<string, string>)[l.kind];
      await db().from("distributions").update({ status: "CONFIRMED", tx_hash: res.txHash, attempts: l.attempts + 1 }).eq("order_id", order.id).eq("leg", kind);
      await writeLedger({ businessId: order.business_id, orderId: order.id, eventType: `payout_${kind}_retried`, status: "REAL", amountUnits: BigInt(l.amount), counterparty: l.recipient, txHash: res.txHash, verifiedOnChain: true });
    }
  }
  return { repeat: true, delaySec: 30 };
}

const STEPS: Record<Step, (o: OrderRow, c: BusinessContext, attempt: number) => Promise<StepResult>> = {
  plan: stepPlan,
  procure: stepProcure,
  await_purchase: stepAwaitPurchase,
  draft: stepDraft,
  deliver: stepDeliver,
  settle: stepSettle,
  retry_legs: stepRetryLegs,
};

// ---------- job runner ----------

interface JobRow {
  id: string;
  order_id: string;
  step: Step;
  attempts: number;
  max_attempts: number;
}

async function runJob(job: JobRow): Promise<void> {
  const order = await loadOrder(job.order_id);
  // A refund (started by the owner or after a failure) ends the agent's work on the order.
  if (order.state === "REFUND_PENDING" || order.state === "REFUNDED") {
    await db().from("jobs").update({ status: "done", lease_until: null, last_error: "order is being refunded" }).eq("id", job.id);
    return;
  }
  try {
    const base = await loadBusinessAnchored();
    // Each order works with its own product and that product's vendor.
    const ctx: BusinessContext = { ...base, ...scopeFor(base, order.product_id) };
    const result = await STEPS[job.step](order, ctx, job.attempts);
    if (result.repeat) {
      await db().from("jobs").update({ status: "queued", run_after: new Date(Date.now() + (result.delaySec ?? 10) * 1000).toISOString(), lease_until: null, attempts: Math.max(0, job.attempts - 1) }).eq("id", job.id);
      return;
    }
    await db().from("jobs").update({ status: "done", lease_until: null }).eq("id", job.id);
    if (result.next) await enqueue(order.id, result.next, result.delaySec ?? 0);
  } catch (e) {
    const err = e as Error;
    if (err instanceof HaltError) {
      // Paused or policy not anchored: wait, do not burn attempts.
      await db().from("jobs").update({ status: "queued", run_after: new Date(Date.now() + 60_000).toISOString(), lease_until: null, attempts: Math.max(0, job.attempts - 1), last_error: err.message }).eq("id", job.id);
      return;
    }
    const exhausted = job.attempts >= job.max_attempts || err instanceof PolicyDenied;
    await db().from("jobs").update({ status: exhausted ? "failed" : "queued", run_after: new Date(Date.now() + 2 ** job.attempts * 5000).toISOString(), lease_until: null, last_error: err.message.slice(0, 500) }).eq("id", job.id);
    await audit(order.business_id, "runtime", exhausted ? "step_failed" : "step_retry", order.id, { step: job.step, error: err.message.slice(0, 500) });
    if (exhausted) {
      try {
        await transition(order, "REFUND_PENDING", `step ${job.step} failed: ${err.message.slice(0, 200)}`);
        await notifyOwner(order.business_id, "refund_needed", { order: order.onchain_order_id, reason: err.message.slice(0, 200) });
      } catch {
        /* order already terminal or in a state that cannot move to refund */
      }
    }
  }
}

/** Claims and runs due jobs until none are left or the time budget is spent. */
export async function runDueJobs(budgetMs = 240_000): Promise<{ ran: number }> {
  const started = Date.now();
  let ran = 0;
  while (Date.now() - started < budgetMs) {
    const { data, error } = await db().rpc("claim_jobs", { p_limit: 1, p_lease_seconds: 180 });
    if (error) throw new Error(`claim_jobs: ${error.message}`);
    const jobs = (data ?? []) as JobRow[];
    if (jobs.length === 0) break;
    for (const job of jobs) {
      await runJob(job);
      ran++;
    }
  }
  return { ran };
}
