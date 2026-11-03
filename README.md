# Buffer

Humans set the rules. Agents run the business.

Buffer is infrastructure for businesses operated by AI agents on NEAR. An owner sets prices, spending limits, approved vendors, approval thresholds and the revenue split. An agent then runs the business: it takes orders, buys what it needs, delivers the work and settles revenue. Deterministic code the agent cannot change checks every money movement, and every event is recorded with on-chain evidence.

The first business is the **Verified Research Desk**: it sells short research reports, buys a dataset from an approved vendor, runs private inference on NEAR AI Cloud, and settles revenue 70/30 between owner and contributor.

Built at NEAR HACKATHON 2026. Tracks: Autonomous Business (`business`), Agent Economy (`agents`). AI Security (`security`) once the attack demo ships. Testnet only.

## Status

Work in progress (milestone M1/M2). What exists and is tested today:

| Component | Where | Tests |
| --- | --- | --- |
| Business contract: escrow, exact-price payments, on-chain vendor allowlist and purchase approvals, settlement, per-leg retry, refunds with owner top-up, policy anchor, pause | `contract/` | 35 unit tests (`cargo test --lib`), sandbox test |
| Revenue engine (off-chain mirror of the contract formula) | `src/lib/domain/revenue.ts` | 10 tests incl. 5,000 generated cases |
| Policy engine (deterministic) + policy hash anchoring | `src/lib/domain/policy/` | 16 tests |
| Approval binding to exact action + revalidation | `src/lib/domain/approval.ts` | 8 tests |
| Order state machine, ledger status rules | `src/lib/domain/` | covered above |
| NEAR AI Cloud client with chat-signature verification | `src/lib/server/nearai.ts` | 6 tests |
| OutLayer agent-custody wrapper, 1Click dry quotes, NEAR RPC verification | `src/lib/server/` | live checks via `npm run m0` |
| Supabase schema with RLS lockdown, append-only ledger, job leasing | `supabase/migrations/` | 8 tests on in-memory Postgres |

| Agent runtime: plan → (buy dataset via the contract) → draft → deliver → settle, as idempotent jobs | `src/lib/server/agent/` | typecheck, build; live on testnet |
| Order API with on-chain payment verification, approvals confirmation, NEAR Intents quote + labelled simulation | `src/app/api/` | build |
| Storefront, live order page with proof of private inference, public ledger | `src/app/store`, `src/app/orders/[id]`, `src/app/ledger` | build |

Not built yet: the owner console (approvals and kill switch in the browser), natural-language policy builder, wallet-connect payment, demo mode.

## How the money works

Per order, in USDC smallest units (6 decimals):

```
V  = vendor purchases the contract paid from this order's escrow
I  = inference cost (metered, reimbursed to the owner who prepaid the credits)
E  = min(V + I, product.max_expense, gross)
D  = gross - E                                   distributable (net)
C  = floor(D * 3000 / 10000)                     contributor, 30%
O  = D - C                                       owner, 70% (gets rounding dust)
V + (E - V) + C + O == gross, checked in the contract and the database.
```

Demo: a 20 USDC report, a 12 USDC dataset, 0.40 inference → net 7.60, owner 5.32, contributor 2.28.

The agent never holds funds. Vendors are paid by the contract, only if the owner approved the vendor on-chain, within the order's expense cap; purchases above 10 USDC wait for the owner's on-chain approval of that exact vendor and amount. Refunds make the customer whole: the owner tops up any vendor spend, then the contract refunds the full gross.

## Honesty rules

Every record has one status: `REAL` (confirmed on NEAR testnet, with a transaction hash), `QUOTE` (a live NEAR Intents price; no funds moved), `SIMULATED` (NEAR Intents has no testnet, so cross-chain settlement is shown but not performed), `PENDING` or `FAILED`. The database rejects a `QUOTE` or `SIMULATED` row with a transaction hash, and a `REAL` row without one.

## Try it

1. `npm install`
2. `npm test` → see 51 TypeScript tests pass (domain logic, signature verification, database schema).
3. `cd contract && cargo test --lib` → see 35 contract tests pass.
4. Copy `.env.example` to `.env.local`, fill in testnet values, then `npm run m0` → see PASS/FAIL/SKIP for each live integration (read-only, plus one small inference call).
5. `npm run dev` → open http://localhost:3000.

## NEAR integrations

- **NEAR Protocol (testnet):** the `buffer-desk` contract holds payments in escrow and settles revenue. Payments use Circle's testnet USDC (`3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`).
- **OutLayer Agent Custody:** the agent's wallet keys live in OutLayer's TEE. Its owner-set policy allows contract calls only, only to the Buffer contract, with no NEAR attached. The app holds only a server-side API key; the owner can freeze the wallet on-chain.
- **NEAR AI Cloud:** inference through the gateway (`cloud-api.near.ai`) with per-response signature verification against the attestation report.
- **NEAR Intents (1Click):** dry-run quotes only (`dry: true`). There is no Intents testnet.
- **Chain Signatures:** stretch goal (contract-gated vendor payment on Base Sepolia).

## License

MIT
