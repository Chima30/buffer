# Chain Signatures: paying a vendor on Ethereum Sepolia

Status: planned 2026-11-04. Decisions (owner): Sepolia USDC, a second product, upgrade the contract in place.

## Goal

The agent buys a dataset from a vendor whose wallet is on Ethereum Sepolia. The payment is a Sepolia USDC
transfer from a treasury address that belongs to the Buffer contract through NEAR Chain Signatures.
Same rules as on NEAR: approved vendors only, per-order expense cap, owner approval above the threshold.

## Facts we build on

- MPC signer (testnet): `v1.signer-prod.testnet`. Method `sign({ request: { path, payload_v2: { Ecdsa: "<32-byte hex>" }, domain_id: 0 } })`,
  deposit 1 yoctoNEAR, at least 15 Tgas. Response `{ big_r: { affine_point }, s: { scalar }, recovery_id }` (secp256k1).
  Source: github.com/near/mpc, crates/contract/src/api/sign.rs and crates/near-mpc-crypto-types.
- Key derivation: tweak = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" + predecessor + "," + path).
  The derived public key is available from the view `derived_public_key({ path, predecessor, domain_id })`.
- Sepolia USDC (Circle): `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, 6 decimals. Chain id 11155111.

## Design

1. Treasury address = Chain Signatures key for predecessor `buffer-john-desk.testnet`, path `buffer-treasury`.
   No one holds its private key.
2. Contract (new, owner-only): `set_evm_config(mpc, chain_id, usdc, max_fee_per_gas_cap, gas_limit)`,
   `set_evm_vendor(address, approved)`, `set_evm_nonce(nonce)` (resync after a dropped transaction).
3. Contract (agent): `request_evm_purchase(order_id, vendor, amount, max_fee_per_gas, max_priority_fee_per_gas)`.
   The contract checks vendor allowlist, cap (NEAR + EVM purchases combined) and fee cap, then BUILDS the
   EIP-1559 transaction itself: to = USDC, data = transfer(vendor, amount), value 0, nonce = contract counter.
   It hashes it (keccak256) and, at or below the threshold, calls MPC `sign`; above it, waits for
   `approve_evm_purchase` from the owner. The agent never passes bytes to sign.
4. Callback stores the signature; status `Signed` counts as spent (conservative).
5. Server relayer rebuilds the same transaction from the stored fields with viem, checks its hash equals the
   contract's payload hash, attaches the signature, broadcasts to Sepolia, waits for the receipt and checks
   the USDC Transfer log (treasury -> vendor, amount). Only then does the vendor release the dataset.
   Ledger: REAL entry with a Sepolia Etherscan link.
6. Settlement: the owner funds the treasury, so EVM purchase amounts are reimbursed to the owner
   (they join the reimbursable expenses, inside the same cap). 70/30 on net is unchanged.
7. Upgrade: `migrate()` keeps all existing state; new fields are appended. Order and Purchase layouts do not
   change (EVM purchases live in their own map), so existing orders read exactly as before.
8. Policy v3: new tool `request_crosschain_purchase`, EVM vendor allowlist, signed by the owner.
9. Red team attack 6: agent tries to pay an attacker's Ethereum address; contract refuses.

## Sessions

1. Contract: EIP-1559 builder + RLP in Rust (tested against viem vectors), MPC call and callback, approvals,
   migration, unit tests. Owner: deploy the upgrade, call `migrate`, `set_evm_config`, fund the treasury
   (Sepolia ETH for gas, Sepolia USDC from faucet.circle.com).
2. Server: relayer + Sepolia verification, vendor delivery, ledger, settlement change, policy v3, second product.
3. UI + test: treasury card in /app, order page, red team attack 6, live order.

## Risks

Testnet MPC or public Sepolia RPC slow or down (all steps retry; a signed transaction is only re-broadcast,
never re-signed, so it cannot pay twice). Gas spikes (fee cap; owner can raise it). Dropped transaction
leaves a nonce gap (owner `set_evm_nonce`).
