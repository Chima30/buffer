-- Red-team runs: each row is one execution of the attack suite (src/lib/server/redteam.ts).
create table security_runs (
  id text primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  results jsonb not null
);
create index on security_runs(started_at desc);

-- Same lockdown as every other table: only the server (service role) reads or writes.
alter table security_runs enable row level security;
revoke all on security_runs from anon, authenticated;
