-- Three more EVM testnets for vendor competition: OP Sepolia, Polygon Amoy and Avalanche Fuji.
alter table vendors drop constraint if exists vendors_chain_check;
alter table vendors add constraint vendors_chain_check check (chain in ('near', 'sepolia', 'base-sepolia', 'arbitrum-sepolia', 'op-sepolia', 'polygon-amoy', 'avalanche-fuji'));
alter table procurements drop constraint if exists procurements_chain_check;
alter table procurements add constraint procurements_chain_check check (chain in ('near', 'sepolia', 'base-sepolia', 'arbitrum-sepolia', 'op-sepolia', 'polygon-amoy', 'avalanche-fuji'));

insert into vendors (business_id, name, chain, evm_address, near_account, category, sku, unit_price_units, approved, description)
select v.business_id, x.name, x.chain, v.evm_address, null, 'dataset', x.sku, x.price, true, x.description
from vendors v
cross join (values
  ('Optimism Data Desk', 'op-sepolia', 'op-reference-pack', 9500000, 'Reference notes on the OP Stack, L2 fees and USDC on Optimism (static demo pack).'),
  ('Polygon Data Desk', 'polygon-amoy', 'pol-reference-pack', 8500000, 'Reference notes on Polygon PoS, POL gas and USDC on Polygon (static demo pack).'),
  ('Avalanche Data Desk', 'avalanche-fuji', 'avax-reference-pack', 9000000, 'Reference notes on the Avalanche C-Chain, AVAX gas and USDC on Avalanche (static demo pack).')
) as x(name, chain, sku, price, description)
where v.chain = 'sepolia' and v.approved
  and not exists (select 1 from vendors w where w.business_id = v.business_id and w.chain = x.chain);

update products set description = 'A sourced brief whose dataset is bought from whichever approved vendor is cheapest across NEAR and five EVM chains, paid by the business contract.'
where sku = 'crosschain-brief';
