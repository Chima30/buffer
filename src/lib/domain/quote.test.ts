import { describe, expect, it } from "vitest";
import { priceQuote, type QuoteRulesUnits } from "./quote";

const U = 1_000_000n;
const rules: QuoteRulesUnits = { minUnits: 5n * U, maxUnits: 50n * U, maxExpenseBps: 6000, marginBps: 4000 };

describe("priceQuote", () => {
  it("prices a deep brief with a 12 USDC dataset", () => {
    const q = priceQuote({ depth: "deep", needsDataset: true }, 12n * U, rules);
    // (12 + 0.1 + 10) / 0.6 = 36.8333.. -> 37.00
    expect(q.priceUnits).toBe(37n * U);
    expect(q.maxExpenseUnits).toBe(13n * U); // dataset + 1 USDC AI allowance, under 60% of 37
    const b = q.breakdown;
    expect(b.dataUnits + b.aiUnits + b.workUnits + b.marginUnits + b.roundingUnits).toBe(q.priceUnits);
    expect(q.clamped).toBeNull();
  });

  it("never quotes below the owner's minimum", () => {
    const q = priceQuote({ depth: "brief", needsDataset: false }, 12n * U, rules);
    expect(q.priceUnits).toBe(5n * U);
    expect(q.clamped).toBe("min");
    expect(q.maxExpenseUnits).toBe(1n * U);
  });

  it("never quotes above the maximum, and the cap stays within the owner's share", () => {
    const q = priceQuote({ depth: "deep", needsDataset: true }, 40n * U, rules);
    expect(q.priceUnits).toBe(50n * U);
    expect(q.clamped).toBe("max");
    expect(q.maxExpenseUnits).toBe(30n * U); // 60% of 50, below the 41 it wanted
  });

  it("rounds up to the next 0.50", () => {
    const q = priceQuote({ depth: "standard", needsDataset: false }, 0n, rules);
    // (5 + 0.05) / 0.6 = 8.4166.. -> 8.50
    expect(q.priceUnits).toBe(8_500_000n);
  });

  it("always leaves the dataset room inside the cap when it is needed", () => {
    for (const depth of ["brief", "standard", "deep"] as const) {
      for (const data of [1n, 6n, 12n, 20n]) {
        const q = priceQuote({ depth, needsDataset: true }, data * U, rules);
        if (q.clamped !== "max") expect(q.maxExpenseUnits).toBeGreaterThanOrEqual(data * U);
        expect(q.maxExpenseUnits * 10_000n).toBeLessThanOrEqual(q.priceUnits * 6000n);
      }
    }
  });
});
