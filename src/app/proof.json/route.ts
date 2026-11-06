/**
 * GET /proof.json  Machine-readable proof for judges and their tools, built live from the
 * public ledger: the accounts, the anchored policy, every settled order with a link to re-check
 * it, every REAL transaction with its explorer link, and the latest red-team run.
 * Nothing here is a secret; it is the same data the ledger, verify and security pages show.
 */
import { connection } from "next/server";
import { db } from "@/lib/server/db";
import { nearConfig } from "@/lib/server/env";
import { treasury } from "@/lib/server/evm";
import { latestRedteamRun } from "@/lib/server/redteam";

const usdc = (units: string | number | null) => (units == null ? null : (Number(units) / 1e6).toFixed(6));

export async function GET(req: Request) {
  await connection();
  const origin = new URL(req.url).origin;
  const near = nearConfig();
  const [biz, agent, ledger, orders, run, evm] = await Promise.all([
    db().from("businesses").select("id,name").eq("contract_id", near.contractId).maybeSingle(),
    db().from("agents").select("near_account").limit(1).maybeSingle(),
    db().from("public_ledger").select("event_type,status,amount_units,counterparty,tx_hash,explorer_url,at,order_id").order("at", { ascending: false }).limit(1000),
    db().from("orders").select("onchain_order_id,state,price_units,updated_at").eq("state", "SETTLED").order("updated_at", { ascending: false }).limit(200),
    latestRedteamRun().catch(() => null),
    treasury().catch(() => null),
  ]);
  const policy = biz.data
    ? (await db().from("policies").select("version,rules_hash,onchain_tx,activated_at").eq("business_id", biz.data.id).eq("status", "active").maybeSingle()).data
    : null;

  const entries = ledger.data ?? [];
  const real = entries.filter((e) => e.status === "REAL" && e.tx_hash);
  const counts = entries.reduce<Record<string, number>>((m, e) => ((m[e.status] = (m[e.status] ?? 0) + 1), m), {});

  const body = {
    project: "Buffer",
    description: "An autonomous business on NEAR: the owner sets the rules, an AI agent runs the business, and a NEAR contract holds the money and enforces the rules.",
    network: "NEAR testnet (EVM purchases on Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia, Polygon Amoy, Avalanche Fuji)",
    real_funds: false,
    generated_at: new Date().toISOString(),
    how_to_check: {
      any_order_in_the_browser: `${origin}/verify`,
      any_order_locally: "git clone https://github.com/Chima30/buffer && cd buffer && npm install && npm run verify -- <order id>",
      ledger: `${origin}/ledger`,
      red_team: `${origin}/security`,
      statuses: {
        REAL: "confirmed on-chain; tx_hash and explorer_url point to it",
        QUOTE: "a live NEAR Intents price; no funds moved",
        SIMULATED: "shown, not performed (NEAR Intents has no testnet)",
        PENDING: "submitted, waiting for confirmation",
        FAILED: "did not complete",
      },
    },
    accounts: {
      business_contract: near.contractId,
      business_contract_explorer: `https://testnet.nearblocks.io/address/${near.contractId}`,
      agent: agent.data?.near_account ?? null,
      evm_treasury: evm,
      evm_treasury_note: "derived by the NEAR MPC network for (business contract, 'buffer-treasury'); no one holds its private key",
    },
    policy: policy
      ? { version: policy.version, sha256: policy.rules_hash, anchored_by_tx: policy.onchain_tx, explorer_url: policy.onchain_tx ? near.explorerTxUrl(policy.onchain_tx) : null, active_since: policy.activated_at }
      : null,
    counts: { settled_orders: orders.data?.length ?? 0, ledger_entries: entries.length, by_status: counts },
    settled_orders: (orders.data ?? []).map((o) => ({
      order: o.onchain_order_id,
      price_usdc: usdc(o.price_units),
      settled_at: o.updated_at,
      verify_url: `${origin}/verify?order=${o.onchain_order_id}`,
    })),
    real_transactions: real.map((e) => ({
      at: e.at,
      event: e.event_type,
      amount_usdc: usdc(e.amount_units),
      counterparty: e.counterparty,
      tx_hash: e.tx_hash,
      explorer_url: e.explorer_url,
    })),
    red_team: run
      ? {
          run: run.id,
          finished_at: run.finishedAt,
          attacks: run.results.length,
          blocked: run.results.filter((r) => r.outcome === "BLOCKED").length,
          results: run.results.map((r) => ({
            attack: r.title,
            goal: r.goal,
            outcome: r.outcome,
            stopped_by: r.defences.filter((x) => x.held).map((x) => ({ layer: x.layer, detail: x.detail, tx_hash: x.txHash ?? null, explorer_url: x.explorerUrl ?? null })),
          })),
        }
      : null,
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" },
  });
}
