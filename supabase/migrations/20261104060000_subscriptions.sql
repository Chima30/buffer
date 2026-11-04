-- Subscriptions: a customer prepays several issues once; the agent opens each
-- issue as an ordinary order when the contract says it is due.
alter table products add column kind text not null default 'single' check (kind in ('single', 'subscription'));

create type subscription_state as enum ('AWAITING_PAYMENT', 'ACTIVE', 'COMPLETED', 'CANCELLED');

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  product_id uuid not null references products(id),
  topic text not null check (length(topic) between 10 and 2000),
  customer_account text,
  state subscription_state not null default 'AWAITING_PAYMENT',
  issues_total int not null check (issues_total between 1 and 52),
  issues_started int not null default 0 check (issues_started between 0 and issues_total),
  issue_price_units numeric(40,0) not null check (issue_price_units > 0),
  onchain_subscription_id text not null unique,
  access_token_hash text not null,
  payment_tx text unique,
  next_due_at timestamptz,
  refund_units numeric(40,0),
  refund_status text check (refund_status is null or refund_status in ('Pending', 'Confirmed', 'Failed')),
  cancel_tx text unique,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on subscriptions(state, next_due_at);
create trigger subscriptions_touch before update on subscriptions for each row execute function touch_updated_at();
alter table subscriptions enable row level security;

-- Each issue is a normal order that points back to its subscription.
alter table orders
  add column subscription_id uuid references subscriptions(id),
  add column issue_number int check (issue_number is null or issue_number > 0);
create unique index orders_one_per_issue on orders(subscription_id, issue_number) where subscription_id is not null;

-- The subscription product of each Research Desk: 10 USDC an issue, inference only (no dataset).
insert into products (business_id, sku, title, description, price_units, max_expense_units, kind)
select id, 'brief-subscription', 'Weekly brief subscription',
       'One topic, a fresh brief every week. Pay for 2 to 8 issues at once; cancel any time and get the unstarted ones back.',
       10000000, 2000000, 'subscription'
from businesses where template = 'research_desk'
on conflict (business_id, sku) do nothing;
