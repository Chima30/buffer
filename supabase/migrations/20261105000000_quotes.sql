-- Quote-based pricing: a product the agent prices per order, within limits the contract enforces.
alter table products drop constraint if exists products_kind_check;
alter table products add constraint products_kind_check check (kind in ('single', 'subscription', 'quote'));

-- The accepted scope, price breakdown, expense cap and expiry of a quoted order.
alter table orders add column quote jsonb;

insert into products (business_id, sku, title, description, price_units, max_expense_units, kind)
select id, 'custom-brief', 'Custom research, priced for you',
       'Describe what you need. The agent scopes it and quotes a price in seconds, within limits the business contract enforces.',
       5000000, 3000000, 'quote'
from businesses where template = 'research_desk'
on conflict (business_id, sku) do nothing;
