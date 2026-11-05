/**
 * Quote pricing. The AI only estimates the scope (depth, whether data is needed);
 * this deterministic formula turns that into a price, and the contract refuses
 * anything outside the owner's rules.
 *
 *   costs  = dataset price (if needed) + estimated AI cost + research work for the depth
 *   price  = costs / (1 - margin), rounded up to 0.50 USDC, clamped to [min, max]
 *   cap    = min(dataset + AI allowance, price * max_expense_bps)   (what the agent may spend)
 *
 * All amounts are USDC smallest units (6 decimals) as bigint.
 */
export type Depth = "brief" | "standard" | "deep";

const USDC = 1_000_000n;
/** The business's charge for the agent's research work, by depth. */
export const WORK_UNITS: Record<Depth, bigint> = { brief: 2n * USDC, standard: 5n * USDC, deep: 10n * USDC };
/** Expected private-inference cost, by depth (generous: real calls cost far less). */
export const AI_ESTIMATE_UNITS: Record<Depth, bigint> = { brief: 20_000n, standard: 50_000n, deep: 100_000n };
/** What the agent may spend on inference for one quoted order. */
export const AI_ALLOWANCE_UNITS = USDC;
/** Report length by depth, for the writer. */
export const DEPTH_WORDS: Record<Depth, string> = { brief: "450-700", standard: "800-1100", deep: "1200-1600" };
export const DEPTH_TOKENS: Record<Depth, number> = { brief: 1600, standard: 2600, deep: 3600 };

export interface QuoteRulesUnits {
  minUnits: bigint;
  maxUnits: bigint;
  maxExpenseBps: number;
  marginBps: number;
}

export interface QuotePrice {
  priceUnits: bigint;
  maxExpenseUnits: bigint;
  breakdown: { dataUnits: bigint; aiUnits: bigint; workUnits: bigint; marginUnits: bigint; roundingUnits: bigint };
  clamped: "min" | "max" | null;
}

const HALF = USDC / 2n;
const ceilTo = (v: bigint, step: bigint) => ((v + step - 1n) / step) * step;

export function priceQuote(scope: { depth: Depth; needsDataset: boolean }, datasetUnits: bigint, rules: QuoteRulesUnits): QuotePrice {
  if (rules.marginBps < 0 || rules.marginBps >= 10_000) throw new Error("margin must be below 100%");
  const dataUnits = scope.needsDataset ? datasetUnits : 0n;
  const aiUnits = AI_ESTIMATE_UNITS[scope.depth];
  const workUnits = WORK_UNITS[scope.depth];
  const costs = dataUnits + aiUnits + workUnits;
  const raw = ceilTo((costs * 10_000n) / BigInt(10_000 - rules.marginBps), 1n);
  let price = ceilTo(raw, HALF);
  let clamped: QuotePrice["clamped"] = null;
  if (price < rules.minUnits) {
    price = rules.minUnits;
    clamped = "min";
  } else if (price > rules.maxUnits) {
    price = rules.maxUnits;
    clamped = "max";
  }
  const capByShare = (price * BigInt(rules.maxExpenseBps)) / 10_000n;
  const wanted = dataUnits + AI_ALLOWANCE_UNITS;
  const maxExpenseUnits = wanted < capByShare ? wanted : capByShare;
  const marginUnits = raw > costs ? raw - costs : 0n;
  return {
    priceUnits: price,
    maxExpenseUnits,
    breakdown: { dataUnits, aiUnits, workUnits, marginUnits, roundingUnits: price - costs - marginUnits },
    clamped,
  };
}
