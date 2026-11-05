import { describe, expect, it } from "vitest";
import { computeHealth, DAY_MS, leanMode, windowStats, type HealthInput } from "./health";

const U = 1_000_000n;
const NOW = Date.UTC(2026, 10, 5, 12);
const YOCTO = 10n ** 24n;

function base(over: Partial<HealthInput> = {}): HealthInput {
  return {
    now: NOW,
    payments: [],
    vendorSpend: [],
    inference: [],
    openOrders: [],
    subscriptions: [],
    openQuotes: [],
    pendingApprovals: [],
    treasury: { reserveBalance: 5n * U, reserveTarget: 20n * U, reserveBps: 1000, gasReserveYocto: 3n * YOCTO, gasRefillYocto: YOCTO / 2n, agentGasYocto: 2n * YOCTO },
    chains: [],
    competitions: [],
    ...over,
  };
}
const ago = (days: number) => NOW - days * DAY_MS;

describe("windowStats", () => {
  it("counts only real records inside the window", () => {
    const s = windowStats(base({ payments: [{ amount: 20n * U, at: ago(1) }, { amount: 20n * U, at: ago(9) }], vendorSpend: [{ amount: 8n * U, at: ago(1) }], inference: [{ amount: 10_000n, at: ago(1) }] }), ago(7), NOW + 1);
    expect(s.orders).toBe(1);
    expect(s.revenue).toBe(20n * U);
    expect(s.net).toBe(20n * U - 8n * U - 10_000n);
    expect(s.costPerOrder).toBe(8n * U + 10_000n);
  });
});

describe("forecast", () => {
  it("refuses to forecast on too little data and says why", () => {
    const h = computeHealth(base({ payments: [{ amount: 20n * U, at: ago(1) }] }));
    expect(h.forecast.enoughData).toBe(false);
    expect(h.forecast.next7Revenue).toBeNull();
    expect(h.forecast.assumptions[0]).toContain("1 paid order");
  });
  it("states its method and keeps the band ordered", () => {
    const pays = [1, 2, 3, 5, 8].map((d) => ({ amount: 20n * U, at: ago(d) }));
    const h = computeHealth(base({ payments: pays }));
    expect(h.forecast.enoughData).toBe(true);
    const f = h.forecast.next7Revenue!;
    expect(f.low).toBeLessThanOrEqual(f.mid);
    expect(f.mid).toBeLessThanOrEqual(f.high);
    // 100 USDC over 14 days -> about 50 over the next 7.
    expect(Number(f.mid) / 1e6).toBeCloseTo(50, 0);
    expect(h.forecast.assumptions.join(" ")).toMatch(/standard deviation/);
  });
});

describe("lean mode (spends less, never more)", () => {
  const squeezed = base({
    payments: [1, 2, 3].map((d) => ({ amount: 20n * U, at: ago(d) })),
    vendorSpend: [1, 2, 3].map((d) => ({ amount: 17n * U, at: ago(d) })),
  });
  it("turns on when net margin falls under 20% with enough orders", () => {
    const h = computeHealth(squeezed);
    expect(h.lean.active).toBe(true);
    expect(h.risks.map((r) => r.code)).toContain("margin_squeeze");
    const lean = h.interventions.find((i) => i.code === "lean_mode")!;
    expect(lean.kind).toBe("autonomous");
    expect(lean.effect).toBe("reduce_spend");
  });
  it("stays off with too few orders to judge", () => {
    expect(leanMode(windowStats(base({ payments: [{ amount: 20n * U, at: ago(1) }], vendorSpend: [{ amount: 19n * U, at: ago(1) }] }), ago(7), NOW + 1)).active).toBe(false);
  });
  it("stays off with healthy margins", () => {
    const h = computeHealth(base({ payments: [1, 2, 3].map((d) => ({ amount: 20n * U, at: ago(d) })), vendorSpend: [{ amount: 8n * U, at: ago(1) }] }));
    expect(h.lean.active).toBe(false);
  });
});

describe("interventions never exceed the agent's permissions", () => {
  // A deliberately bad business: every rule fires.
  const worst = computeHealth(
    base({
      payments: [1, 2, 3].map((d) => ({ amount: 10n * U, at: ago(d) })).concat([8, 9, 10, 11].map((d) => ({ amount: 30n * U, at: ago(d) }))),
      vendorSpend: [1, 2, 3].map((d) => ({ amount: 9n * U, at: ago(d) })),
      inference: [1, 2, 3].map((d) => ({ amount: 500_000n, at: ago(d) })).concat([8, 9, 10, 11].map((d) => ({ amount: 10_000n, at: ago(d) }))),
      openOrders: [{ onchainId: "o-1", state: "DRAFTING", gross: 20n * U, vendorPaid: 12n * U, paidAt: ago(1) }],
      pendingApprovals: [{ onchainOrderId: "o-2", amount: 12n * U, since: NOW - 2 * 3600_000 }],
      treasury: { reserveBalance: 0n, reserveTarget: 20n * U, reserveBps: 1000, gasReserveYocto: 0n, gasRefillYocto: YOCTO / 2n, agentGasYocto: YOCTO / 10n },
      chains: [{ name: "Base Sepolia", configured: true, usdc: 2n * U, gasOk: true, cheapestPrice: 8n * U }],
    }),
  );
  it("flags the business as at risk", () => {
    expect(worst.status).toBe("at_risk");
    expect(worst.risks.map((r) => r.code)).toEqual(expect.arrayContaining(["reserve_empty", "refund_exposure", "gas_stranded", "chain_short:Base Sepolia", "inference_rising", "revenue_down", "margin_squeeze", "approvals_stale"]));
  });
  it("only ever acts on its own to spend less or use a power the contract already grants", () => {
    for (const i of worst.interventions.filter((x) => x.kind === "autonomous")) {
      expect(["reduce_spend", "contract_granted"]).toContain(i.effect);
    }
  });
  it("leaves every money-moving fix to the owner", () => {
    const owner = worst.interventions.filter((x) => x.kind === "needs_owner").map((x) => x.code);
    expect(owner).toEqual(expect.arrayContaining(["topup_reserve", "fund_gas_reserve", "fund_chain:Base Sepolia", "raise_price", "approve_or_raise"]));
    for (const i of worst.interventions.filter((x) => x.kind === "needs_owner")) expect(i.effect).toBe("none");
  });
  it("does not offer a gas refill the contract would refuse", () => {
    expect(worst.interventions.map((i) => i.code)).not.toContain("gas_refill");
  });
});

describe("obligations and runway", () => {
  it("adds up what the business owes and what it can still buy", () => {
    const h = computeHealth(
      base({
        subscriptions: [{ onchainId: "s-1", unstartedIssues: 3, issuePrice: 10n * U, nextDueAt: NOW + 3600_000 }],
        openOrders: [{ onchainId: "o-1", state: "PAID", gross: 20n * U, vendorPaid: 0n, paidAt: ago(0) }],
        openQuotes: [{ onchainId: "q-1", amount: 8n * U, maxExpense: U, expiresAt: NOW + 60_000 }, { onchainId: "q-2", amount: 9n * U, maxExpense: U, expiresAt: NOW - 1 }],
        chains: [{ name: "A", configured: true, usdc: 20n * U, gasOk: true, cheapestPrice: 8n * U }, { name: "B", configured: false, usdc: 20n * U, gasOk: true, cheapestPrice: 8n * U }],
      }),
    );
    expect(h.obligations.subscriptionEscrow).toBe(30n * U);
    expect(h.obligations.openQuotes).toBe(1);
    expect(h.runway.purchasesLeft).toBe(2);
    expect(h.runway.gasOrdersLeft).toBe(166); // 5 NEAR / 0.03
    expect(h.status).toBe("healthy");
  });
  it("counts competition savings only where the winner was cheaper", () => {
    const h = computeHealth(base({ competitions: [{ winner: 8n * U, dearest: 11n * U, at: ago(1) }, { winner: 9n * U, dearest: 9n * U, at: ago(1) }] }));
    expect(h.savings).toEqual({ competitions: 2, savedUnits: 3n * U });
  });
});
