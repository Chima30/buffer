-- Chain Signatures: vendors paid on Ethereum Sepolia from the contract's treasury.
alter table vendors
  add column chain text not null default 'near' check (chain in ('near', 'sepolia')),
  add column evm_address text check (evm_address is null or evm_address ~ '^0x[0-9a-f]{40}$'),
  add column description text;
alter table vendors alter column near_account drop not null;
alter table vendors add constraint vendors_chain_address check (
  (chain = 'near' and near_account is not null) or (chain = 'sepolia' and evm_address is not null)
);

-- Each product names the vendor whose dataset it may buy.
alter table products add column vendor_id uuid references vendors(id);

alter table procurements
  add column chain text not null default 'near' check (chain in ('near', 'sepolia')),
  add column evm_tx_hash text unique check (evm_tx_hash is null or evm_tx_hash ~ '^0x[0-9a-f]{64}$'),
  add column evm_nonce int;

-- The store lists every active product.
create or replace view public_products with (security_barrier) as
  select p.id, p.business_id, p.sku, p.title, p.description, p.price_units
  from products p join businesses b on b.id = p.business_id
  where p.active and b.status = 'active';
grant select on public_products to anon, authenticated;
