-- Autonomous Business Survival Engine: every risk the engine detects and every
-- intervention it takes or proposes, with its evidence and policy check.
create table health_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  kind text not null check (kind in ('risk', 'intervention')),
  code text not null,
  severity text check (severity is null or severity in ('info', 'warn', 'high')),
  mode text check (mode is null or mode in ('autonomous', 'needs_owner')),
  status text not null check (status in ('open', 'resolved', 'executed', 'proposed', 'dismissed')),
  title text not null,
  detail text,
  evidence jsonb not null default '{}',
  policy_check jsonb not null default '{}',
  tx_hash text,
  order_id uuid references orders(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index on health_events(business_id, created_at desc);
-- One live record per condition: re-running the check never duplicates it.
create unique index health_events_one_live on health_events(business_id, code) where resolved_at is null and status in ('open', 'proposed');
alter table health_events enable row level security;
