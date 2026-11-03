-- Buffer initial schema.
-- Money: integer smallest units in numeric(40,0) (USDC has 6 decimals). Never floats.
-- Security model: RLS is enabled on every table with NO policies for anon/authenticated,
-- so the browser can read nothing directly. The server uses the service role.
-- Public data is exposed only through the narrow read-only views at the bottom.

create extension if not exists pgcrypto;

-- ---------- enums ----------
create type business_status as enum ('active', 'paused');
create type agent_status as enum ('running', 'paused', 'frozen');
create type order_state as enum (
  'CREATED','AWAITING_PAYMENT','PAID','PLANNING','PROCURING','AWAITING_APPROVAL',
  'DRAFTING','DELIVERED','SETTLING','SETTLED','REFUND_PENDING','REFUNDED','FAILED'
);
create type ledger_status as enum ('REAL','QUOTE','SIMULATED','PENDING','FAILED');
create type payment_status as enum ('PENDING','VERIFIED','FAILED','REFUNDED');
create type expense_status as enum ('PAID','METERED','PENDING','REJECTED');
create type expense_category as enum ('supplier','inference');
create type payout_leg as enum ('owner','contributor','reimb_owner','refund');
create type payout_status as enum ('PENDING','SUBMITTED','CONFIRMED','FAILED');
create type approval_status as enum ('pending','approved','rejected','expired','void');
create type decision_outcome as enum ('allow','deny','needs_approval');
create type job_status as enum ('queued','running','done','failed');
create type intents_kind as enum ('QUOTE','SIMULATED','SUBMITTED','CONFIRMED','FAILED');
create type policy_status as enum ('draft','pending_signature','active','superseded');

-- ---------- identity ----------
create table users (
  id uuid primary key default gen_random_uuid(),
  near_account text not null unique,
  display_name text,
  created_at timestamptz not null default now()
);

create table businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 2 and 80),
  template text not null default 'research_desk',
  network text not null default 'testnet' check (network = 'testnet'),
  contract_id text not null unique,
  status business_status not null default 'active',
  active_policy_version int,
  created_at timestamptz not null default now()
);

create table business_members (
  business_id uuid not null references businesses(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner','viewer')),
  primary key (business_id, user_id)
);

create table business_config (
  business_id uuid primary key references businesses(id) on delete cascade,
  token_id text not null,
  owner_payout_account text not null,
  contributor_account text not null,
  agent_account text not null,
  contributor_bps int not null check (contributor_bps between 0 and 10000),
  purchase_approval_above_units numeric(40,0) not null,
  config_hash text,
  onchain_synced_at timestamptz,
  check (contributor_account <> agent_account),
  check (owner_payout_account <> agent_account)
);

create table policies (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  version int not null check (version > 0),
  source_text text,
  rules jsonb not null,
  rules_hash text not null check (rules_hash ~ '^[0-9a-f]{64}$'),
  status policy_status not null default 'draft',
  signed_by text,
  signature text,
  onchain_tx text,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  unique (business_id, version)
);
create unique index policies_one_active on policies(business_id) where status = 'active';

create table agents (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  role text not null,
  near_account text,
  outlayer_wallet_id text,
  status agent_status not null default 'paused',
  created_at timestamptz not null default now()
);
create index on agents(business_id);

create table agent_permissions (
  agent_id uuid not null references agents(id) on delete cascade,
  tool text not null,
  allowed boolean not null default true,
  primary key (agent_id, tool)
);

-- ---------- catalogue ----------
create table products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  sku text not null,
  title text not null,
  description text,
  price_units numeric(40,0) not null check (price_units > 0),
  max_expense_units numeric(40,0) not null check (max_expense_units >= 0),
  active boolean not null default true,
  onchain_synced boolean not null default false,
  unique (business_id, sku)
);

create table vendors (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  near_account text not null,
  category text not null,
  sku text not null,
  unit_price_units numeric(40,0) not null check (unit_price_units > 0),
  approved boolean not null default false
);
create index on vendors(business_id);

-- ---------- sales ----------
create table customers (
  id uuid primary key default gen_random_uuid(),
  near_account text,
  created_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  product_id uuid not null references products(id),
  customer_id uuid references customers(id),
  brief text not null check (length(brief) between 10 and 4000),
  state order_state not null default 'CREATED',
  price_units numeric(40,0) not null check (price_units > 0),
  onchain_order_id text not null unique,
  access_token_hash text not null,
  deadline_at timestamptz not null,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on orders(business_id, created_at desc);
create index on orders(state);

create table order_transitions (
  id bigint generated always as identity primary key,
  order_id uuid not null references orders(id) on delete cascade,
  from_state order_state,
  to_state order_state not null,
  reason text,
  at timestamptz not null default now()
);
create index on order_transitions(order_id, at);

create table payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  status payment_status not null default 'PENDING',
  token_id text not null,
  amount_units numeric(40,0) not null check (amount_units > 0),
  sender_account text not null,
  tx_hash text not null unique,
  block_height bigint,
  verified_at timestamptz
);
create index on payments(order_id);

create table intents_records (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id) on delete cascade,
  kind intents_kind not null,
  origin_asset text not null,
  destination_asset text not null,
  amount_in text,
  amount_out text not null,
  tx_hash text,
  raw jsonb,
  created_at timestamptz not null default now(),
  check ((kind in ('QUOTE','SIMULATED') and tx_hash is null) or kind not in ('QUOTE','SIMULATED'))
);

-- ---------- work ----------
create table procurements (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  vendor_id uuid not null references vendors(id),
  amount_units numeric(40,0) not null check (amount_units > 0),
  status text not null check (status in ('proposed','denied','awaiting_approval','approved','submitted','confirmed','failed','rejected')),
  onchain_index int,
  approval_id uuid,
  idempotency_key text not null unique,
  outlayer_request_id text,
  tx_hash text unique,
  created_at timestamptz not null default now()
);
create index on procurements(order_id);

create table inference_calls (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id) on delete cascade,
  agent_id uuid references agents(id),
  purpose text not null,
  model text not null,
  chat_id text not null unique,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_usd_micros numeric(40,0) not null default 0,
  request_hash text not null,
  response_hash text not null,
  signature_kind text,
  signing_address text,
  signature text,
  verification_level text check (verification_level in ('SIGNATURE_ATTESTED','SIGNATURE_ONLY','FAILED','UNVERIFIED')),
  created_at timestamptz not null default now()
);
create index on inference_calls(created_at);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  category expense_category not null,
  amount_units numeric(40,0) not null check (amount_units >= 0),
  status expense_status not null,
  evidence_ref text,
  reimburse_to text not null,
  created_at timestamptz not null default now()
);
create index on expenses(order_id);

create table reports (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references orders(id) on delete cascade,
  storage_path text not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  inference_call_id uuid references inference_calls(id),
  created_at timestamptz not null default now()
);

-- ---------- money out ----------
create table revenue_records (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references orders(id) on delete cascade,
  formula_version int not null,
  gross numeric(40,0) not null,
  expenses_counted numeric(40,0) not null,
  expenses_uncounted numeric(40,0) not null,
  distributable numeric(40,0) not null,
  owner_share numeric(40,0) not null,
  contributor_share numeric(40,0) not null,
  paid_to_vendors numeric(40,0) not null,
  reimb_owner numeric(40,0) not null,
  created_at timestamptz not null default now(),
  check (paid_to_vendors + reimb_owner + contributor_share + owner_share = gross),
  check (distributable = gross - expenses_counted)
);

create table distributions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  leg payout_leg not null,
  recipient text not null,
  amount_units numeric(40,0) not null check (amount_units > 0),
  status payout_status not null default 'PENDING',
  tx_hash text,
  attempts int not null default 0,
  last_error text,
  updated_at timestamptz not null default now(),
  unique (order_id, leg)
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  chain text not null default 'near-testnet',
  tx_hash text not null unique,
  kind text not null,
  status text not null check (status in ('PENDING','SUCCESS','FAILED')),
  raw jsonb,
  checked_at timestamptz not null default now()
);

-- ---------- control ----------
create table approval_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  agent_id uuid references agents(id),
  order_id uuid references orders(id),
  action_hash text not null unique check (action_hash ~ '^[0-9a-f]{64}$'),
  binding jsonb not null,
  policy_version int not null,
  status approval_status not null default 'pending',
  expires_at timestamptz not null,
  decided_by text,
  signature jsonb,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index on approval_requests(business_id, status);

create table agent_actions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id),
  order_id uuid references orders(id),
  tool text not null,
  args jsonb not null,
  decision decision_outcome not null,
  reasons jsonb not null,
  policy_version int not null,
  idempotency_key text not null unique,
  result_ref text,
  at timestamptz not null default now()
);
create index on agent_actions(order_id, at);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id) on delete cascade,
  step text not null,
  status job_status not null default 'queued',
  run_after timestamptz not null default now(),
  lease_until timestamptz,
  attempts int not null default 0,
  max_attempts int not null default 5,
  last_error text,
  created_at timestamptz not null default now(),
  unique (order_id, step)
);
create index on jobs(status, run_after);

create table ledger_entries (
  id bigint generated always as identity primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  order_id uuid references orders(id) on delete set null,
  event_type text not null,
  status ledger_status not null,
  amount_units numeric(40,0),
  token_id text,
  counterparty text,
  tx_hash text,
  explorer_url text,
  details jsonb not null default '{}',
  at timestamptz not null default now(),
  check ((status in ('QUOTE','SIMULATED') and tx_hash is null) or status not in ('QUOTE','SIMULATED')),
  check (status <> 'REAL' or tx_hash is not null)
);
create index on ledger_entries(business_id, at desc);
create index on ledger_entries(order_id);

create table audit_logs (
  id bigint generated always as identity primary key,
  business_id uuid references businesses(id) on delete cascade,
  actor text not null,
  action text not null,
  target text,
  details jsonb not null default '{}',
  at timestamptz not null default now()
);
create index on audit_logs(business_id, at desc);

create table integration_status (
  business_id uuid not null references businesses(id) on delete cascade,
  integration text not null,
  configured boolean not null,
  key_fingerprint text check (key_fingerprint is null or length(key_fingerprint) <= 8),
  last_check_at timestamptz,
  last_result text,
  primary key (business_id, integration)
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table owner_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  nonce text not null unique,
  token_hash text unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- ---------- append-only history ----------
create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

create trigger ledger_append_only before update or delete on ledger_entries
  for each row execute function forbid_mutation();
create trigger audit_append_only before update or delete on audit_logs
  for each row execute function forbid_mutation();
create trigger transitions_append_only before update or delete on order_transitions
  for each row execute function forbid_mutation();

create function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger orders_touch before update on orders for each row execute function touch_updated_at();
create trigger distributions_touch before update on distributions for each row execute function touch_updated_at();

-- ---------- job queue: lease-based claiming ----------
create function claim_jobs(p_limit int, p_lease_seconds int)
returns setof jobs language plpgsql as $$
begin
  return query
  update jobs j set status = 'running',
                    lease_until = now() + make_interval(secs => p_lease_seconds),
                    attempts = j.attempts + 1
  where j.id in (
    select id from jobs
    where (status = 'queued' and run_after <= now())
       or (status = 'running' and lease_until < now() and attempts < max_attempts)
    order by run_after
    limit p_limit
    for update skip locked
  )
  returning j.*;
end $$;

-- ---------- RLS: deny-by-default ----------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated;
revoke execute on function claim_jobs(int, int) from public, anon, authenticated;

-- ---------- public read-only views (safe columns only) ----------
create view public_ledger with (security_barrier) as
  select l.id, l.business_id, b.name as business_name, l.order_id, l.event_type, l.status,
         l.amount_units, l.token_id, l.counterparty, l.tx_hash, l.explorer_url, l.at,
         l.details - 'internal' as details
  from ledger_entries l join businesses b on b.id = l.business_id;

create view public_products with (security_barrier) as
  select p.id, p.business_id, p.sku, p.title, p.description, p.price_units
  from products p join businesses b on b.id = p.business_id
  where p.active and b.status = 'active';

grant select on public_ledger, public_products to anon, authenticated;
