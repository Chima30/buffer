# Proof: how to check that Buffer did what it says

Buffer runs on NEAR testnet with testnet USDC. No real funds. Everything below can be checked without trusting this repository, the website or its database.

## 1. The live proof file

**[`/proof.json`](https://buffer-zeta.vercel.app/proof.json)** is built live from the public ledger. It lists:

- the business contract, the agent account and the EVM treasury address;
- the active policy: its version, its sha256 and the transaction that anchored it on-chain;
- every settled order, each with a link that re-checks it;
- every `REAL` transaction with its explorer link;
- the latest red-team run: each attack, its outcome and the layer (and transaction) that stopped it.

## 2. Re-check any order

- In the browser: [`/verify`](https://buffer-zeta.vercel.app/verify), then paste an order id such as `o-3438af14498a`.
- Locally, with no keys and no `.env`:
  ```
  npm install
  npm run verify -- o-3438af14498a
  ```

The verifier reads the public chains, not Buffer's database. It checks:

- **Payment:** the customer's USDC transfer into the contract's escrow.
- **Purchases:** each data purchase, on NEAR or on the EVM testnet that paid. For EVM purchases it also checks that the contract built the transaction and that the NEAR MPC network signed it for the contract's own treasury.
- **Delivery:** the report's sha256 recorded on-chain.
- **AI work:** the TEE signatures on the AI's work and NVIDIA's GPU attestation.
- **Settlement:** the costs-first 70/30 maths, and every payout confirmed on-chain.

## 3. Read the contract yourself

```
near contract call-function as-read-only buffer-john-desk.testnet get_config json-args {} network-config testnet now
near contract call-function as-read-only buffer-john-desk.testnet get_order json-args '{"order_id":"o-3438af14498a"}' network-config testnet now
```

Explorer: [buffer-john-desk.testnet on nearblocks](https://testnet.nearblocks.io/address/buffer-john-desk.testnet).

## 4. What is not claimed

- **NEAR Intents:** it has no testnet, so Intents appears only as live `QUOTE`s or `SIMULATED` entries, never as completed settlement.
- **EVM vendors:** they are demo vendors with deterministic hourly prices. Their payments are real testnet transfers, but their data is demo reference material.
- **The red team:** it tests seven specific attacks. It does not claim that every possible attack is prevented.
