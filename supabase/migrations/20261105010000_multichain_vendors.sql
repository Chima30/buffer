-- Vendor competition across chains: vendors and purchases on Base Sepolia and Arbitrum Sepolia too.
alter table vendors drop constraint if exists vendors_chain_check;
alter table vendors add constraint vendors_chain_check check (chain in ('near', 'sepolia', 'base-sepolia', 'arbitrum-sepolia'));
alter table vendors drop constraint if exists vendors_chain_address;
alter table vendors add constraint vendors_chain_address check (
  (chain = 'near' and near_account is not null) or (chain <> 'near' and evm_address is not null)
);
alter table procurements drop constraint if exists procurements_chain_check;
alter table procurements add constraint procurements_chain_check check (chain in ('near', 'sepolia', 'base-sepolia', 'arbitrum-sepolia'));

-- Every bid the agent collected for a purchase, and why the winner won.
alter table procurements add column bids jsonb;

-- Two more demo vendors, at the same vendor address as the Ethereum one, on Base and Arbitrum.
insert into vendors (business_id, name, chain, evm_address, near_account, category, sku, unit_price_units, approved, description)
select v.business_id, x.name, x.chain, v.evm_address, null, 'dataset', x.sku, x.price, true, x.description
from vendors v
cross join (values
  ('Base Data Desk', 'base-sepolia', 'base-reference-pack', 9000000, 'Reference notes on Base, L2 fees and USDC on Base (static demo pack).'),
  ('Arbitrum Data Desk', 'arbitrum-sepolia', 'arb-reference-pack', 10000000, 'Reference notes on Arbitrum, rollup fees and USDC on Arbitrum (static demo pack).')
) as x(name, chain, sku, price, description)
where v.chain = 'sepolia' and v.approved
  and not exists (select 1 from vendors w where w.business_id = v.business_id and w.chain = x.chain);

update products set description = 'A sourced brief whose dataset is bought from whichever approved vendor is cheapest across NEAR, Ethereum, Base and Arbitrum, paid by the business contract.'
where sku = 'crosschain-brief';
