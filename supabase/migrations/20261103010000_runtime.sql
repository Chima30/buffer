-- Runtime additions: report content, order plan, and a public order-status view.

alter table reports add column content text not null default '';
alter table reports alter column storage_path drop not null;

alter table orders add column plan jsonb;
alter table orders add column customer_account text;

-- Public order status: no brief, no access token, no customer details.
create view public_order_status with (security_barrier) as
  select o.id, o.business_id, o.state, o.price_units, o.onchain_order_id, o.created_at, o.updated_at
  from orders o;

grant select on public_order_status to anon, authenticated;

alter table reports enable row level security;
alter table reports force row level security;

-- Model outputs are kept apart from the call metadata and never exposed publicly.
create table inference_outputs (
  inference_call_id uuid primary key references inference_calls(id) on delete cascade,
  content text not null
);
alter table inference_outputs enable row level security;
alter table inference_outputs force row level security;
revoke all on inference_outputs from anon, authenticated;

-- One expense row per piece of evidence, so retried steps never double-count.
alter table expenses add constraint expenses_order_evidence_unique unique (order_id, evidence_ref);
