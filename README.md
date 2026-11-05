# Buffer

Humans set the rules. AI agents run the business.

Buffer runs a small business with an AI agent on NEAR. The owner sets the price, the spending limits, the approved vendors, the approval threshold and the revenue split. The agent takes orders, buys the data it needs, writes the work with private inference, delivers it and settles revenue. A NEAR contract holds the money and enforces the owner's rules on every payment. The agent cannot change them.

The first business is the **Verified Research Desk**. It sells short research briefs for 20 testnet USDC.

- Live (testnet): https://buffer-zeta.vercel.app
- NEAR HACKATHON 2026. Tracks: Autonomous Business (`business`), Agent Economy (`agents`), AI Security (`security`)
- Testnet only. No real funds.

## Check it in five minutes

1. **Ledger.** Open [/ledger](https://buffer-zeta.vercel.app/ledger). Each payment, purchase and payout has a status. `REAL` rows link to the transaction on NEAR or Ethereum Sepolia.
2. **Verify an order yourself.** This uses public chains only, with no keys and no `.env`:
   ```
   npm install
   npm run verify -- https://buffer-zeta.vercel.app/orders/<order-id>
   ```
   It re-reads the payment, every purchase (including the Sepolia transfer and its MPC signature), the report hash, the 70/30 settlement math, the TEE signatures and NVIDIA's GPU verdict. Then it prints PASS or FAIL for each.
3. **Attacks.** Open [/security](https://buffer-zeta.vercel.app/security). We ran seven attacks on our own live business: prompt injection from a customer, injection hidden in a vendor's data, paying an attacker on NEAR and on Ethereum, moving USDC directly, rewriting the rules, and overspending. The page shows which layer stopped each one. The rejected calls are real failed transactions; follow the agent's explorer link to see them.
4. **Owner console.** Open [/app](https://buffer-zeta.vercel.app/app). It shows totals, approvals, emergency controls (pause the contract, freeze the agent's wallet), the policy and its on-chain hash, the self-funding treasury and refunds. Every owner action is a transaction the owner signs.
5. **Start a business.** Open [/new](https://buffer-zeta.vercel.app/new). Describe a business and its rules in plain English, and get its policy, hash and launch checklist. Nothing is created for you.

## What one order does

1. **Pay.** The customer pays 20 USDC to the contract (`ft_transfer_call`). The contract accepts only the exact price for a new order id.
2. **Plan.** The agent plans with private inference on NEAR AI Cloud. The response is signed inside a TEE. We check the signature, and NVIDIA's attestation service verifies the GPUs for a fresh nonce.
3. **Buy.** If the dataset helps, the agent asks the contract to pay the vendor. The policy engine checks the action first.
   - The contract pays only an approved vendor, within the order's 13 USDC expense cap.
   - Above 10 USDC, the contract waits for the owner to approve that exact purchase.
   - The vendor is paid either from the order's escrow on NEAR, or from the contract's Ethereum treasury through Chain Signatures (see below).
4. **Write and deliver.** The report is written with private inference, and its sha256 is recorded on-chain.
5. **Settle.** The contract pays out net revenue: 70% to the owner, 30% to the contributor. It also reimburses the owner for expenses they prepaid.

### The money, per order (USDC units, 6 decimals)

```
V  = vendor purchases paid from this order's escrow (NEAR)
X  = vendor purchases paid from the Ethereum treasury (owner-funded)
I  = inference cost (prepaid by the owner)
E  = min(V + X + I, product.max_expense, gross)
D  = gross - E                         net
C  = floor(D * 3000 / 10000)           contributor, 30%
O  = D - C                             owner, 70% (keeps rounding dust)
reimbursed to owner = E - V
V + (E - V) + C + O == gross           checked by the contract and by our off-chain mirror
```

Example from a live cross-chain order: gross 20, Ethereum dataset 12, inference 0.003045. Net is 7.996955, so the owner gets 5.597869, the contributor 2.399086 and the owner is reimbursed 12.003045, which adds up to exactly 20.

## Why the agent cannot misuse the money

| Layer | What it enforces |
| --- | --- |
| Prompts | Customer briefs and vendor data are wrapped as untrusted data, and the model is told to ignore instructions inside them. It flags injection attempts. |
| No money path from text | Model output never chooses a payee or an amount. Those come from the owner's configuration. |
| Policy engine | Deterministic checks before every action: allowlist, limits, budgets, minimum price, approvals. Prohibitions cannot be approved away. |
| Policy anchor | The policy's sha256 is stored in the contract. The agent refuses to act if its copy differs, and pauses while a change is half-signed. |
| Agent custody (OutLayer) | The agent's key lives in a TEE. Its signing policy allows calls to one contract only. The owner can freeze it on-chain. |
| Business contract | It holds the money. It pays approved vendors only, caps each order's expenses, waits for owner approval above the threshold, and keeps configuration owner-only. |
| Chain Signatures | The contract builds the Ethereum transaction itself and asks the MPC network to sign only that. The agent never passes bytes to sign. |

Rules in plain English: in the owner console, the owner describes a rule change ("purchases above $5 need my approval"). Private inference translates it into at most seven numeric fields. Code applies them, checks the result and computes the hash. Nothing changes until the owner signs the hash on-chain. The translator has no field for wallets, vendors, agent permissions or prohibitions, so it cannot change those.

## Self-funding treasury

The business pays its own running costs from its revenue, under rules only the owner can set (`set_treasury_rules`) and enforced by the contract:

- **Business reserve.** At settlement, the contract keeps a share of the owner's 70% until the reserve reaches a target. The defaults are 10% and a 20 USDC target. The contributor's 30% is never touched. The amount kept shows as its own `Reserve` leg on the order, and `npm run verify` checks it.
- **Refunds use the reserve first.** A customer is made whole without the owner stepping in. The owner tops up only what the reserve can't cover.
- **Agent gas.** The owner funds a NEAR gas reserve once. When the agent's wallet drops below 1 NEAR, the agent asks the contract for a refill (default 0.5 NEAR). The contract caps refills per rolling week (default 2 NEAR), however often it's asked.
- **Ethereum treasury.** The agent shows how much the Chain Signatures treasury needs for the next purchase. Moving USDC from NEAR to Ethereum needs NEAR Intents, which runs on mainnet only, so on testnet this is shown, not performed.

Only the owner can change the rules or withdraw (`withdraw_reserve`, `withdraw_gas_reserve`). The agent can only trigger a refill, within the caps.

## Subscriptions

A customer can prepay a series of briefs on one topic in a single payment, and the business delivers them on schedule by itself:

- **One payment, held by the contract.** The customer pays for 2 to 8 issues at 10 USDC each with one `ft_transfer_call`. The money sits in the subscription's own escrow in the contract, not with the agent.
- **The contract decides when an issue is due.** The agent calls `start_issue`, which moves exactly one issue's price into a new ordinary order for the same customer. It refuses if the issue is early, the subscription is used up or cancelled, or the business is paused. The owner sets the pace with `set_subscription_plan`: weekly in production, every hour on testnet so a demo can show two issues.
- **Each issue is a normal order.** It goes through the same policy checks, TEE-signed inference, on-chain report hash, 70/30 settlement and reserve. Each issue builds on the earlier ones. Subscription issues are priced for inference only and never buy a dataset.
- **Cancel any time.** The customer or the owner signs `cancel_subscription`, and the contract sends every unstarted issue's money straight back to the customer. Issues already started still finish. Cancelling works even while the business is paused.

Revenue counts one issue at a time, when it opens. Money still in escrow is the customer's.

## Custom quotes

A customer can describe any research request in their own words and get a price in about half a minute:

1. **The AI only estimates the work.** Private inference on NEAR AI Cloud returns the scope: sections, depth (brief, standard or deep), and whether the vendor's dataset is needed. It never sees or names a price.
2. **Code computes the price** with a fixed formula: dataset + estimated AI + research work for that depth, divided by (1 − the 40% margin), rounded up to 0.50 USDC. The expense cap is the dataset plus a 1 USDC AI allowance. The breakdown is shown to the customer.
3. **The contract enforces the owner's limits.** The agent registers the quote with `create_quote`. The contract refuses it if the price is outside 5–50 USDC, if the expense cap is above 60% of the price, or if it stays open longer than 30 minutes (`set_quote_rules`, owner only). The customer must pay exactly the quoted amount before it expires, and a quoted product cannot be bought at any other price.
4. **The quote's expense cap replaces the product's** for purchases and settlement, so the agent can never give itself a bigger budget than the quote allows, even if a request tries to talk it into one.

## Vendor competition across chains

When an order needs data, the agent doesn't call one fixed vendor. It runs a competition:

- **Every approved vendor bids:** the NEAR vendor and vendors on Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia, Polygon Amoy and Avalanche Fuji. Demo vendors publish an hourly price list (within ±15% of their base price, deterministic, so anyone can recompute it).
- **Real total cost.** For an EVM vendor the agent adds that chain's live gas for the USDC transfer, valued in USDC at the gas token's price (ETH, POL or AVAX, from Pyth or Coinbase). NEAR purchases are paid from the order's escrow with no extra gas.
- **Only bids the owner's rules allow.** A bid is skipped if the vendor or chain isn't approved in the policy or the contract, if it's above what the order may still spend, or if the treasury can't pay on that chain (not enough USDC or gas). Skipped, never failed.
- **Code picks the winner:** the cheapest total, ties to NEAR. The AI only decided that a dataset is needed. The order page shows every bid, the winner, and why the others lost.

The same treasury address, one key derived by the NEAR MPC network, pays on all six EVM chains. Each chain has its own owner-set config (`set_evm_chain`: USDC address, fee cap, gas limit), its own vendor approvals (`set_evm_chain_vendor`) and its own nonce, all in the contract. The owner sets the constraints; the agent decides inside them.

## Chain Signatures (Ethereum Sepolia)

The contract owns an Ethereum address derived by NEAR's MPC network (`v1.signer-prod.testnet`, path `buffer-treasury`). No one holds its private key. A cross-chain purchase works like this:

1. The agent calls `request_evm_purchase(order, vendor, amount, fees)`, with fees under the owner's cap.
2. The contract builds an EIP-1559 USDC `transfer` to the approved vendor (checked byte-for-byte against viem in the tests) and asks the MPC network to sign its keccak256.
3. The server checks that the signed bytes are exactly what the contract built and that the signature recovers to the treasury. Then it broadcasts and waits for the receipt.
4. The vendor releases data only after the USDC `Transfer` from the treasury is confirmed on Sepolia.

The owner funds the treasury and is reimbursed at settlement.

- Treasury: [`0x87239682e3a986431C656DB9B0bd3cB8B36Dc569`](https://sepolia.etherscan.io/address/0x87239682e3a986431C656DB9B0bd3cB8B36Dc569)

## Honesty rules

Every ledger row has exactly one status:
- `REAL`: confirmed on-chain, with a transaction link.
- `QUOTE`: a live NEAR Intents price; no funds moved.
- `SIMULATED`: shown but not performed, because NEAR Intents has no testnet.
- `PENDING` or `FAILED`.

The database rejects a `QUOTE` or `SIMULATED` row that has a transaction hash, and a `REAL` row that doesn't.

Demo vendors deliver small static reference packs, labelled as such. Their payments are real testnet transfers.

## Accounts (testnet)

| Role | Account |
| --- | --- |
| Business contract | [`buffer-john-desk.testnet`](https://testnet.nearblocks.io/address/buffer-john-desk.testnet) |
| Owner | `buffer-john-owner.testnet` |
| Contributor | `buffer-john-contrib.testnet` |
| Agent (OutLayer custody) | [`26f36567c9a7bd63f340c0c48621ee1257ee28c68211736226caf4efefb8dd84`](https://testnet.nearblocks.io/address/26f36567c9a7bd63f340c0c48621ee1257ee28c68211736226caf4efefb8dd84) |
| Ethereum treasury (Chain Signatures) | `0x87239682e3a986431C656DB9B0bd3cB8B36Dc569` |
| USDC | Circle testnet USDC: `3e2210e1…b8af` on NEAR, `0x1c7D…7238` on Sepolia |

Read the contract's state directly:
```
near contract call-function as-read-only buffer-john-desk.testnet get_config json-args {} network-config testnet now
near contract call-function as-read-only buffer-john-desk.testnet get_order json-args '{"order_id":"o-91336486ee60"}' network-config testnet now
```

## Stack and code

- **Contract.** `contract/` is Rust with near-sdk 5. It has 90 unit tests (`cd contract && cargo test --lib`). CI builds the wasm artifact and prints its sha256.
- **App.** Next.js 16 on Vercel with Supabase. Row-level security denies all public access, the ledger is append-only, and job leases use `FOR UPDATE SKIP LOCKED`. Supabase Cron calls `/api/runtime/tick` every minute.
- **Deterministic core.** `src/lib/domain/` holds the policy engine, the revenue mirror of the contract formula, the order state machine and the policy builder's checks. Tests: `npm test`.
- **Integrations.** `src/lib/server/` contains:
  - NEAR AI Cloud, with signature checks (`nearai.ts`);
  - NVIDIA NRAS (`nras.ts`);
  - OutLayer custody (`outlayer.ts`);
  - Chain Signatures and Sepolia (`evm.ts`);
  - NEAR RPC verification (`near-rpc.ts`);
  - 1Click dry quotes (`oneclick.ts`).
- **Agent runtime.** `src/lib/server/agent/runtime.ts` runs idempotent steps: plan → buy → (approval) → draft → deliver → settle.
- **Independent verifier.** `src/lib/verify/order.ts` (`npm run verify`).

## Limits we know about

- Testnet only. A mainnet NEAR Intents settlement has not been run; Intents appears only as `QUOTE` and `SIMULATED`.
- We verify the NEAR AI response signature and NVIDIA's GPU attestation. We do not verify the Intel TDX quote, which needs Intel's DCAP collateral.
- One business and one agent run today. `/new` produces the plan for another business but does not deploy it.
- Owner actions are signed with near-cli or a NEAR wallet. The console shows the exact command for each.

## Built during the hackathon

Every commit is from the hackathon window: the repository starts on 2026-11-03 with `create-next-app`. There is no earlier code and no product on another chain.

Libraries and tools:
- **Contract:** `near-sdk` (Rust), plus `near-sandbox` and `cargo-near` in tests.
- **App:** Next.js, React, Tailwind CSS, Supabase (`@supabase/supabase-js`), `zod`, `viem` (Ethereum transactions and signature recovery), `jose` (NVIDIA token verification), `bs58`, `react-markdown`, `geist` fonts.
- **NEAR:** `near-api-js`, `@hot-labs/near-connect` and `near-connect-hooks` (wallet), `@outlayer/sdk` (agent custody).
- **Tests:** `vitest` and PGlite (an in-memory Postgres for the schema tests).

Much of the code was written with an AI coding assistant (Claude, by Anthropic), directed and reviewed by the team.

## License

MIT
