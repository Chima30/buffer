# Buffer

Humans set the rules. AI agents run the business.

Buffer runs a small business with an AI agent on NEAR. The owner sets the price, the spending limits, the approved vendors, the approval threshold and the revenue split. The agent takes orders, buys the data it needs, writes the work with private inference, delivers it and settles revenue. A NEAR contract holds the money and enforces the owner's rules on every payment. The agent cannot change them.

The first business is the **Verified Research Desk**. It sells short research briefs for 20 testnet USDC, prepaid subscriptions (10 USDC an issue) and custom quotes priced by a fixed formula.

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
6. **Business health.** In the owner console, open **Business health**. It shows margin, runway, obligations, open risks and every intervention the agent took or proposed, all from real records.

## Run one full loop yourself (testnet)

You need a NEAR testnet wallet (for example Meteor) holding a little testnet NEAR and Circle testnet USDC (free at faucet.circle.com, network NEAR testnet).

1. Open [/store](https://buffer-zeta.vercel.app/store), pick **Weekly Market Brief**, type a topic and press **Continue to payment**.
2. Press **Pay 20.00 USDC from <your account>** and approve it in your wallet. The contract now holds your 20 USDC and the order moves past **Payment**.
3. Stay on the order page. The stages advance by themselves: **Planning**, **Procurement** (every vendor's bid is shown, with the winner), **Writing**, **Delivered**, **Settled**. A purchase above the owner's approval threshold waits for the owner at **Procurement**.
4. When it says **Settled**, the report is on the page, its sha256 is on-chain, and the payout rows link to the contract's transfers to the owner and the contributor.
5. Check it independently: `npm run verify -- <the order URL>`.

To see a refund instead: start a subscription with 3 issues, wait for issue #1 to start, then press **Cancel and refund**. The contract returns the unstarted issues' money to you.

## What one order does

1. **Pay.** The customer pays 20 USDC to the contract (`ft_transfer_call`). The contract accepts only the exact price for a new order id.
2. **Plan.** The agent plans with private inference on NEAR AI Cloud. The response is signed inside a TEE. We check the signature, and NVIDIA's attestation service verifies the GPUs for a fresh nonce.
3. **Buy.** If the dataset helps, the agent asks the contract to pay the vendor. The policy engine checks the action first.
   - The contract pays only an approved vendor, within the order's 13 USDC expense cap.
   - Above 10 USDC, the contract waits for the owner to approve that exact purchase.
   - The vendor is paid either from the order's escrow on NEAR, or from the contract's treasury on one of six EVM testnets through Chain Signatures (see below). Vendors compete on price for each purchase.
4. **Write and deliver.** The report is written with private inference, and its sha256 is recorded on-chain.
5. **Settle.** The contract pays out net revenue: 70% to the owner, 30% to the contributor. It also reimburses the owner for expenses they prepaid.

### The money, per order (USDC units, 6 decimals)

```
V  = vendor purchases paid from this order's escrow (NEAR)
X  = vendor purchases paid from the EVM treasuries (owner-funded)
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

## Autonomous Business Survival Engine

The owner console's **Health** tab answers "can this business keep going without me?" from real records only:

- **Actuals:** revenue, vendor and AI costs, net margin and cost per order for the last 7 days against the 7 before.
- **Forecast, labelled as one:** next 7 days from the 14-day average daily revenue, with a ± one standard deviation band and the assumptions written out. Under 3 paid orders in 14 days it says "not enough data" instead of guessing.
- **Runway:** data purchases the chain treasuries can still pay at this hour's prices, and orders the agent's gas plus the gas reserve can cover (the per-order gas figure is a stated assumption).
- **Obligations:** unstarted subscription issues, paid orders still owed a report or a refund, open quotes, purchases waiting for approval, and the refund exposure the reserve must cover.
- **8 deterministic risk rules:** empty or low reserve, refund exposure above the reserve, stranded agent gas, a chain treasury that can't pay its vendor, AI cost per order doubling, revenue halving, margin under 20%, approvals waiting over an hour.
- **Interventions with a hard line.** The agent acts alone only to spend *less* or to use a power the contract already grants: **lean mode** (single orders skip optional datasets while margin is under 20%; quoted orders and subscriptions keep the scope the customer paid for) and the capped gas refill. Anything that moves money or changes rules (topping up a chain, funding gas, raising a price floor, the approval threshold) is proposed for the owner to sign.
- **Audit trail:** every risk opened or resolved and every action executed or proposed, with its evidence, the policy rule it relied on and its transaction where there is one. One live record per condition, enforced by a unique index, so re-running the check never duplicates.

## Chain Signatures (six EVM testnets)

The contract owns one EVM address derived by NEAR's MPC network (`v1.signer-prod.testnet`, path `buffer-treasury`). No one holds its private key. The same address is the treasury on Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia, Polygon Amoy and Avalanche Fuji. A cross-chain purchase works like this:

1. The agent calls `request_evm_purchase(order, vendor, amount, fees, chain_id)`, with fees under that chain's owner-set cap.
2. The contract builds an EIP-1559 USDC `transfer` to a vendor approved on that chain, with that chain's id and nonce (checked byte-for-byte against viem in the tests), and asks the MPC network to sign its keccak256.
3. The server checks that the signed bytes are exactly what the contract built and that the signature recovers to the treasury. Then it broadcasts and waits for the receipt.
4. The vendor releases data only after the USDC `Transfer` from the treasury is confirmed on that chain.

The owner funds the treasury and is reimbursed at settlement.

- Treasury: `0x87239682e3a986431C656DB9B0bd3cB8B36Dc569` on [Sepolia](https://sepolia.etherscan.io/address/0x87239682e3a986431C656DB9B0bd3cB8B36Dc569), [Base Sepolia](https://sepolia.basescan.org/address/0x87239682e3a986431C656DB9B0bd3cB8B36Dc569), [Arbitrum Sepolia](https://sepolia.arbiscan.io/address/0x87239682e3a986431C656DB9B0bd3cB8B36Dc569), [OP Sepolia](https://sepolia-optimism.etherscan.io/address/0x87239682e3a986431C656DB9B0bd3cB8B36Dc569), [Polygon Amoy](https://amoy.polygonscan.com/address/0x87239682e3a986431C656DB9B0bd3cB8B36Dc569), [Avalanche Fuji](https://testnet.snowtrace.io/address/0x87239682e3a986431C656DB9B0bd3cB8B36Dc569)

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
| EVM treasury (Chain Signatures, all six chains) | `0x87239682e3a986431C656DB9B0bd3cB8B36Dc569` |
| USDC | Circle testnet USDC: `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` on NEAR; on EVM chains, the addresses in `src/lib/server/chains.ts` |

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
  - Chain Signatures and the six EVM chains (`evm.ts`, `chains.ts`);
  - vendor competition and gas pricing (`procurement.ts`);
  - subscriptions (`subscriptions.ts`) and quotes (`quotes.ts`);
  - the Survival Engine (`health.ts`, rules in `src/lib/domain/health.ts`);
  - NEAR RPC verification (`near-rpc.ts`);
  - 1Click dry quotes (`oneclick.ts`).
- **Agent runtime.** `src/lib/server/agent/runtime.ts` runs idempotent steps: plan → buy → (approval) → draft → deliver → settle.
- **Independent verifier.** `src/lib/verify/order.ts` (`npm run verify`).

## Limits we know about

- Testnet only. A mainnet NEAR Intents settlement has not been run; Intents appears only as `QUOTE` and `SIMULATED`.
- We verify the NEAR AI response signature and NVIDIA's GPU attestation. We do not verify the Intel TDX quote, which needs Intel's DCAP collateral.
- One business and one agent run today. `/new` produces the plan for another business but does not deploy it.
- Owner actions are signed with near-cli or a NEAR wallet. The console shows the exact command for each.
- Cross-chain payments use Chain Signatures. NEAR Intents has no testnet (rule Q-007), so customers pay in USDC on NEAR and Intents appears only as live `QUOTE`s.
- EVM vendors are demo vendors with deterministic hourly prices. The Survival Engine's forecast is a simple average with a stated band, not a demand model, and its alerts show in the console only (no phone or email).

## Run your own copy

1. `npm install`, then `cp .env.example .env.local` and fill it in. Server-only keys stay in `.env.local`, which is never committed.
2. Supabase: run every file in `supabase/migrations/` in name order (SQL editor or `supabase db push`).
3. Contract: `cd contract && cargo near build non-reproducible-wasm`, then deploy it and call `new` with your owner, agent, token (`USDC_TOKEN_ID`), owner payout account, contributor, `contributor_bps` 3000, approval threshold and order TTL. CI builds the same wasm and prints its sha256.
4. Agent custody: `npm run outlayer:register`, then `npm run outlayer:policy` and run the near-cli command it prints.
5. Business: `npm run seed`, run the printed command to anchor the policy hash as the owner, then `npm run seed -- --activate`. `npm run m0` checks every integration.
6. Deploy to Vercel with the same environment variables, and schedule a POST to `/api/runtime/tick` every minute with `Authorization: Bearer <RUNTIME_SECRET>` (we use Supabase Cron with `pg_net`).
7. Open `/app` with the owner's wallet. Each feature that is not switched on yet (treasury rules, subscriptions, quotes, each EVM chain and its vendors) is listed with the exact transaction for the owner to sign.

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
