# buffer-desk contract

Escrow, policy anchor and deterministic revenue settlement for a Buffer business.

## What it enforces

- Accepts payment only from the configured token (Circle testnet USDC) and only the exact product price for a new order id. Anything else is returned to the sender in full.
- Revenue stays in the contract until settlement. The agent never holds revenue or a spending float.
- Vendors are paid by the contract, from the order's escrow, only if the owner approved the vendor on-chain and the order's expense cap allows it. Purchases above the approval threshold wait for the owner's `approve_purchase` on that exact vendor and amount.
- `settle` applies the net-revenue formula (see `src/lib.rs`), caps expenses at the product's `max_expense`, and pays each leg with its own callback. An order settles once: it moves to `Settling` before any transfer.
- A failed leg is retried alone with `retry_leg`; confirmed legs are never paid twice.
- Refunds return what the order still holds (gross minus confirmed vendor payments) plus any owner top-up. To make a customer whole after vendor spend, the owner first sends the shortfall with `{"refund_top_up":"<order_id>"}`. The owner can refund before settlement; anyone can after the order deadline if it was never fulfilled.
- Only the owner can change recipients, the split, vendors, the approval threshold, products, the agent, the policy hash or the pause flag. The agent can never be a revenue recipient or a vendor.

## Build and test (on your machine)

```sh
rustup target add wasm32-unknown-unknown
cargo test --lib            # 35 unit tests
cargo near build non-reproducible-wasm
cargo test --test sandbox   # deploys to a local sandbox
```

## Deploy to testnet (you sign; keys stay on your machine)

```sh
near contract deploy <contract>.testnet use-file target/near/buffer_desk.wasm \
  with-init-call new json-args '{
    "owner": "<owner>.testnet",
    "agent": "<outlayer-agent-account>",
    "token_id": "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
    "owner_payout": "<owner>.testnet",
    "contributor": "<contributor>.testnet",
    "contributor_bps": 3000,
    "purchase_approval_above": "10000000",
    "order_ttl_ns": 86400000000000
  }' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

The contract and every payout recipient must be registered with the USDC contract (`storage_deposit`) before the first payment. `npm run m0` checks this.
