/**
 * "Start a business" draft. Turns an owner's form into everything a new Buffer
 * business needs, without creating anything: the starting policy (and its hash),
 * the contract's init arguments, and the owner's launch checklist. Pure code;
 * the only AI step (translating the owner's rules into numbers) happens before
 * this and passes through the same strict edit schema as the policy builder.
 */
import { z } from "zod";
import { toUnits } from "./money";
import { applyEdit, describeChanges, lintPolicy, type Change, type PolicyEdit } from "./policy/draft";
import { policyHash } from "./policy/hash";
import type { PolicyDocument } from "./policy/schema";

const nearAccount = z.string().trim().toLowerCase().regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "Not a valid NEAR account id").min(2).max(64);
const evmAddress = z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/, "Not a valid 0x address").transform((s) => s.toLowerCase());
const usdc = z.string().trim().regex(/^\d{1,7}(\.\d{1,6})?$/, "Use a plain amount like 20 or 12.5");

export const NEAR_TESTNET_USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

export const businessDraftInput = z
  .object({
    businessName: z.string().trim().min(3).max(60),
    owner: nearAccount,
    contributor: nearAccount,
    contributorPercent: z.number().int().min(0).max(100),
    productTitle: z.string().trim().min(3).max(80),
    productSku: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,40}$/, "Lowercase letters, digits and dashes"),
    price: usdc,
    maxExpense: usdc,
    vendorName: z.string().trim().min(2).max(60),
    vendorChain: z.enum(["near", "sepolia"]),
    vendorAccount: z.string().trim(),
    vendorPrice: usdc,
    rules: z.string().trim().max(1000).default(""),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ok = v.vendorChain === "near" ? nearAccount.safeParse(v.vendorAccount).success : evmAddress.safeParse(v.vendorAccount).success;
    if (!ok) ctx.addIssue({ code: "custom", path: ["vendorAccount"], message: v.vendorChain === "near" ? "Vendor must be a NEAR account" : "Vendor must be a 0x address" });
    if (toUnits(v.maxExpense) > toUnits(v.price)) ctx.addIssue({ code: "custom", path: ["maxExpense"], message: "Expense cap cannot exceed the price" });
    if (toUnits(v.vendorPrice) > toUnits(v.maxExpense)) ctx.addIssue({ code: "custom", path: ["vendorPrice"], message: "The dataset costs more than the expense cap allows" });
    if (v.owner === v.contributor) ctx.addIssue({ code: "custom", path: ["contributor"], message: "Use a different account for the contributor" });
  });
export type BusinessDraftInput = z.infer<typeof businessDraftInput>;

const contractIdFor = (sku: string, owner: string) => `${sku}.${owner.endsWith(".testnet") ? owner : `${owner}.testnet`}`.slice(0, 64);

/** The baseline every new business starts from, before the owner's own rules. */
export function baselinePolicy(input: BusinessDraftInput): PolicyDocument {
  const vendorId = "vendor-1";
  const agentId = "agent";
  const contract = contractIdFor(input.productSku, input.owner);
  // Default approval threshold: half the per-order spending cap, so large purchases always need the owner.
  const half = (toUnits(input.maxExpense) / 2n).toString();
  const rules: PolicyDocument["rules"] = {
    emergency: { shutdown: false },
    token_id: NEAR_TESTNET_USDC,
    limits: { per_transaction_units: toUnits(input.maxExpense).toString(), daily_units: (toUnits(input.maxExpense) * 5n).toString(), monthly_units: (toUnits(input.maxExpense) * 50n).toString() },
    inference: { daily_usd_micros: toUnits("20").toString(), monthly_usd_micros: toUnits("200").toString() },
    procurement: { max_per_purchase_units: toUnits(input.maxExpense).toString(), approved_vendor_ids: [vendorId] },
    destinations: { allowlist: input.vendorChain === "near" ? [input.vendorAccount.toLowerCase(), contract] : [contract] },
    pricing: { min_price_units: { [input.productSku]: toUnits(input.price).toString() } },
    revenue: { basis: "net", contributor_bps: input.contributorPercent * 100 },
    agent_permissions: { [agentId]: ["get_vendor_catalog", "run_inference", input.vendorChain === "near" ? "request_purchase" : "request_crosschain_purchase", "deliver_report", "request_settlement"] },
    approvals: [{ id: "A-1", description: `Purchases above ${Number(half) / 1e6} USDC require owner approval`, when: { tools: ["request_purchase", "request_crosschain_purchase"], amount_above_units: half } }],
    prohibitions: [{ id: "P-1", description: "Payments to unapproved wallets are always blocked", when: { tools: ["request_purchase", "request_crosschain_purchase"], destination_not_in_allowlist: true } }],
  };
  if (input.vendorChain === "sepolia") rules.crosschain = { chain_id: 11155111, token: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238", approved_vendors: [input.vendorAccount.toLowerCase()] };
  return { version: 1, business_id: "draft", rules };
}

export interface ChecklistStep {
  step: string;
  detail: string;
  command?: string;
  /** Set when a NEAR wallet can sign this step instead of near-cli. */
  call?: { contractId: string; method: string; args: Record<string, unknown> };
}

export interface BusinessDraft {
  contractId: string;
  policy: PolicyDocument;
  policyHash: string;
  changes: Change[];
  warnings: string[];
  errors: string[];
  initArgs: Record<string, unknown>;
  checklist: ChecklistStep[];
}

/** Applies the translated rules (if any) and lays out the launch plan. Creates nothing. */
export function buildBusinessDraft(input: BusinessDraftInput, edit: PolicyEdit | null): BusinessDraft {
  const base = baselinePolicy(input);
  // applyEdit bumps the version; a brand-new business starts at v1 either way.
  const edited = edit ? { ...applyEdit(base, edit), version: 1 } : base;
  const lint = lintPolicy({ ...base, version: 0 }, edited, toUnits(input.maxExpense));
  const contractId = contractIdFor(input.productSku, input.owner);
  const hash = policyHash(edited);
  const threshold = edited.rules.approvals.find((a) => a.id === "A-1")?.when.amount_above_units ?? "0";
  const initArgs = {
    owner: input.owner,
    agent: "<agent account from npm run outlayer:register>",
    token_id: NEAR_TESTNET_USDC,
    owner_payout: input.owner,
    contributor: input.contributor,
    contributor_bps: input.contributorPercent * 100,
    purchase_approval_above: threshold,
    order_ttl_ns: 86_400_000_000_000,
  };
  const call = (method: string, args: Record<string, unknown>) =>
    `near --% contract call-function as-transaction ${contractId} ${method} json-args "${JSON.stringify(args).replace(/"/g, '\\"')}" prepaid-gas "30 Tgas" attached-deposit "0 NEAR" sign-as ${input.owner} network-config testnet sign-with-keychain send`;
  const fn = (method: string, args: Record<string, unknown>) => ({ command: call(method, args), call: { contractId, method, args } });
  const checklist: BusinessDraft["checklist"] = [
    { step: "Create the contract account", detail: "A sub-account of your owner account holds the business contract. Needs near-cli: a browser wallet cannot create it", command: `near account create-account fund-myself ${contractId} '5 NEAR' autogenerate-new-keypair save-to-keychain sign-as ${input.owner} network-config testnet sign-with-keychain send` },
    { step: "Create the agent wallet", detail: "Each business runs as its own copy of Buffer, so do this in a fresh copy of the repository with its own .env.local. OutLayer derives the agent's key inside a TEE; you never see it. The policy step limits it to your contract", command: "npm run outlayer:register && npm run outlayer:policy" },
    { step: "Deploy the Buffer contract", detail: "The same tested contract as the Research Desk, with your accounts and split. Needs near-cli", command: `near contract deploy ${contractId} use-file buffer_desk.wasm with-init-call new json-args '${JSON.stringify(initArgs)}' prepaid-gas "100 Tgas" attached-deposit "0 NEAR" network-config testnet sign-with-keychain send` },
    { step: "List the product", detail: `${input.productTitle} at ${input.price} USDC, at most ${input.maxExpense} USDC of expenses per order`, ...fn("set_product", { sku: input.productSku, price: toUnits(input.price).toString(), max_expense: toUnits(input.maxExpense).toString(), active: true }) },
    input.vendorChain === "near"
      ? { step: "Approve the vendor", detail: `${input.vendorName}, paid on NEAR from each order's escrow`, ...fn("set_vendor", { vendor: input.vendorAccount.toLowerCase(), approved: true }) }
      : { step: "Approve the vendor on Ethereum", detail: `${input.vendorName}, paid on Sepolia from the contract's Chain Signatures treasury. Configure Ethereum first (set_evm_config), then approve the address`, ...fn("set_evm_vendor", { vendor: input.vendorAccount.toLowerCase(), approved: true }) },
    { step: "Sign the policy", detail: `Anchors policy v1 (sha256 ${hash.slice(0, 12)}…). The agent refuses to act under any other rules`, ...fn("set_policy_hash", { version: 1, hash }) },
  ];
  return { contractId, policy: edited, policyHash: hash, changes: edit ? describeChanges(base, { ...edited, version: base.version }) : [], warnings: lint.warnings, errors: lint.errors.filter((e) => !e.startsWith("Version must")), initArgs, checklist };
}
