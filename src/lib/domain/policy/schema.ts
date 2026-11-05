import { z } from "zod";

/**
 * The Buffer business policy document. Amounts are integer smallest-unit
 * strings (USDC has 6 decimals, so "10000000" = 10 USDC). USD inference
 * budgets are in micro-dollars ("20000000" = $20).
 *
 * The document is owner-signed; its canonical hash is anchored on the business
 * contract. Agents can read the active version but have no tool that writes it.
 */

const unitsString = z.string().regex(/^\d+$/, "must be an integer string of smallest units");
const nearAccount = z
  .string()
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "invalid NEAR account id")
  .min(2)
  .max(64);

export const TOOL_NAMES = [
  "get_vendor_catalog",
  "run_inference",
  "request_purchase",
  "request_crosschain_purchase",
  "deliver_report",
  "request_settlement",
] as const;
export const toolName = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof toolName>;

const evmAddress = z.string().regex(/^0x[0-9a-f]{40}$/, "must be a lowercase 0x address");

const matchCondition = z
  .object({
    tools: z.array(toolName).optional(),
    agent_ids: z.array(z.string()).optional(),
    amount_above_units: unitsString.optional(),
    destination_not_in_allowlist: z.boolean().optional(),
    destinations: z.array(nearAccount).optional(),
  })
  .strict();

export const policyRulesSchema = z
  .object({
    emergency: z.object({ shutdown: z.boolean() }).strict(),
    token_id: z.string().min(2),
    limits: z
      .object({
        per_transaction_units: unitsString,
        daily_units: unitsString,
        monthly_units: unitsString,
      })
      .strict(),
    inference: z
      .object({
        daily_usd_micros: unitsString,
        monthly_usd_micros: unitsString,
      })
      .strict(),
    procurement: z
      .object({
        max_per_purchase_units: unitsString,
        approved_vendor_ids: z.array(z.string()),
      })
      .strict(),
    destinations: z.object({ allowlist: z.array(nearAccount) }).strict(),
    /** Optional: purchases on another chain through Chain Signatures (policy v3+). */
    crosschain: z
      .object({
        chain_id: z.number().int().positive(),
        /** The token cross-chain purchases pay in (USDC on that chain). */
        token: evmAddress,
        approved_vendors: z.array(evmAddress),
      })
      .strict()
      .optional(),
    /** Optional: more EVM chains the treasury may pay vendors on, each with its own token and vendors (policy v6+). */
    crosschain_chains: z
      .array(
        z
          .object({
            chain_id: z.number().int().positive(),
            token: evmAddress,
            approved_vendors: z.array(evmAddress),
          })
          .strict(),
      )
      .optional(),
    pricing: z.object({ min_price_units: z.record(z.string(), unitsString) }).strict(),
    revenue: z
      .object({
        basis: z.literal("net"),
        contributor_bps: z.number().int().min(0).max(10_000),
      })
      .strict(),
    agent_permissions: z.record(z.string(), z.array(toolName)),
    approvals: z.array(
      z.object({ id: z.string(), description: z.string(), when: matchCondition }).strict(),
    ),
    prohibitions: z.array(
      z.object({ id: z.string(), description: z.string(), when: matchCondition }).strict(),
    ),
  })
  .strict();

export type PolicyRules = z.infer<typeof policyRulesSchema>;
export type MatchCondition = z.infer<typeof matchCondition>;

export const policyDocumentSchema = z
  .object({
    version: z.number().int().positive(),
    business_id: z.string(),
    rules: policyRulesSchema,
  })
  .strict();

export type PolicyDocument = z.infer<typeof policyDocumentSchema>;
