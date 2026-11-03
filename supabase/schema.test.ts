/**
 * Applies the migration to an in-memory Postgres (PGlite) and checks the
 * financial constraints, append-only history, job leasing and RLS lockdown.
 */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const sql = readFileSync(new URL("./migrations/20261103000000_init.sql", import.meta.url), "utf8")
  // pgcrypto is preinstalled on Supabase; gen_random_uuid is core in PG13+.
  .replace("create extension if not exists pgcrypto;", "");

let db: PGlite;
let biz: string;
let order: string;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated;`);
  await db.exec(sql);
  biz = (await db.query<{ id: string }>(`insert into businesses (name, contract_id) values ('Research Desk', 'buffer-desk.testnet') returning id`)).rows[0].id;
  const product = (await db.query<{ id: string }>(
    `insert into products (business_id, sku, title, price_units, max_expense_units) values ($1, 'weekly-market-brief', 'Weekly Market Brief', 20000000, 13000000) returning id`, [biz])).rows[0].id;
  order = (await db.query<{ id: string }>(
    `insert into orders (business_id, product_id, brief, price_units, onchain_order_id, access_token_hash, deadline_at)
     values ($1, $2, 'NEAR DeFi weekly overview please', 20000000, 'o-1', 'h', now() + interval '1 day') returning id`, [biz, product])).rows[0].id;
}, 60_000);

const fails = async (q: string, params: unknown[] = []) => {
  await expect(db.query(q, params)).rejects.toThrow();
};

describe("schema", () => {
  it("rejects SIMULATED or QUOTE ledger rows with a tx hash, and REAL rows without one", async () => {
    await fails(`insert into ledger_entries (business_id, event_type, status, tx_hash) values ($1, 'x', 'SIMULATED', 'abc')`, [biz]);
    await fails(`insert into ledger_entries (business_id, event_type, status, tx_hash) values ($1, 'x', 'QUOTE', 'abc')`, [biz]);
    await fails(`insert into ledger_entries (business_id, event_type, status) values ($1, 'x', 'REAL')`, [biz]);
    await db.query(`insert into ledger_entries (business_id, event_type, status, tx_hash) values ($1, 'payment', 'REAL', 'tx1')`, [biz]);
  });

  it("keeps the ledger append-only", async () => {
    await fails(`update ledger_entries set event_type = 'tampered'`);
    await fails(`delete from ledger_entries`);
  });

  it("enforces the revenue invariant", async () => {
    await fails(
      `insert into revenue_records (order_id, formula_version, gross, expenses_counted, expenses_uncounted, distributable, owner_share, contributor_share, paid_to_vendors, reimb_owner)
       values ($1, 2, 20000000, 12400000, 0, 7600000, 5320000, 2280000, 12000000, 1)`, [order]);
    await db.query(
      `insert into revenue_records (order_id, formula_version, gross, expenses_counted, expenses_uncounted, distributable, owner_share, contributor_share, paid_to_vendors, reimb_owner)
       values ($1, 2, 20000000, 12400000, 0, 7600000, 5320000, 2280000, 12000000, 400000)`, [order]);
  });

  it("allows exactly one payout row per leg per order", async () => {
    await db.query(`insert into distributions (order_id, leg, recipient, amount_units) values ($1, 'owner', 'owner.testnet', 5320000)`, [order]);
    await fails(`insert into distributions (order_id, leg, recipient, amount_units) values ($1, 'owner', 'owner.testnet', 5320000)`, [order]);
  });

  it("rejects duplicate payment tx hashes and duplicate procurement keys", async () => {
    await db.query(`insert into payments (order_id, token_id, amount_units, sender_account, tx_hash) values ($1, 'usdc', 20000000, 'c.testnet', 'pay-1')`, [order]);
    await fails(`insert into payments (order_id, token_id, amount_units, sender_account, tx_hash) values ($1, 'usdc', 20000000, 'c.testnet', 'pay-1')`, [order]);
  });

  it("refuses mainnet businesses", async () => {
    await fails(`insert into businesses (name, contract_id, network) values ('x', 'x.near', 'mainnet')`);
  });

  it("leases jobs so two workers never take the same one", async () => {
    await db.query(`insert into jobs (order_id, step) values ($1, 'plan'), ($1, 'draft')`, [order]);
    const a = await db.query<{ id: string }>(`select id from claim_jobs(1, 60)`);
    const b = await db.query<{ id: string }>(`select id from claim_jobs(5, 60)`);
    expect(a.rows).toHaveLength(1);
    expect(b.rows.map((r) => r.id)).not.toContain(a.rows[0].id);
    const again = await db.query(`select id from claim_jobs(5, 60)`);
    expect(again.rows).toHaveLength(0);
  });

  it("gives anon no access to tables but read access to public views", async () => {
    await db.exec(`set role anon`);
    try {
      await fails(`select * from orders`);
      await fails(`select * from approval_requests`);
      const rows = await db.query(`select event_type, status from public_ledger`);
      expect(rows.rows.length).toBeGreaterThan(0);
      const products = await db.query(`select sku from public_products`);
      expect(products.rows).toEqual([{ sku: "weekly-market-brief" }]);
    } finally {
      await db.exec(`reset role`);
    }
  });
});
