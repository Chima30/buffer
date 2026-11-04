import { describe, expect, it } from "vitest";
import { toUnits } from "./money";
import { computeRefund, computeSettlement, SettlementBlockedError, type ExpenseInput } from "./revenue";

const exp = (over: Partial<ExpenseInput>): ExpenseInput => ({
  id: over.id ?? "e1",
  category: over.category ?? "supplier",
  amount: over.amount ?? toUnits("1"),
  status: over.status ?? (over.category === "inference" ? "METERED" : "PAID"),
  evidenceRef: over.evidenceRef === undefined ? "tx:abc" : over.evidenceRef,
});

const demo = [
  exp({ id: "dataset", category: "supplier", amount: toUnits("12") }),
  exp({ id: "llm", category: "inference", amount: toUnits("0.4"), evidenceRef: "chat:1" }),
];

describe("computeSettlement (formula v2, mirrors the contract)", () => {
  it("matches the demo numbers and the contract unit test", () => {
    const r = computeSettlement({ gross: toUnits("20"), maxExpense: toUnits("13"), contributorBps: 3000, expenses: demo });
    expect(r.paidToVendors).toBe(toUnits("12"));
    expect(r.expensesCounted).toBe(toUnits("12.4"));
    expect(r.distributable).toBe(toUnits("7.6"));
    expect(r.contributorShare).toBe(toUnits("2.28"));
    expect(r.ownerShare).toBe(toUnits("5.32"));
    expect(r.reimbOwner).toBe(toUnits("0.4"));
    expect(r.legs.map((l) => l.leg)).toEqual(["owner", "contributor", "reimb_owner"]);
    expect(r.overCap).toBe(false);
  });

  it("caps inference reimbursement at the expense cap and flags the rest", () => {
    const r = computeSettlement({
      gross: toUnits("20"),
      maxExpense: toUnits("13"),
      contributorBps: 3000,
      expenses: [demo[0], exp({ id: "llm", category: "inference", amount: toUnits("5") })],
    });
    expect(r.expensesCounted).toBe(toUnits("13"));
    expect(r.reimbOwner).toBe(toUnits("1"));
    expect(r.expensesUncounted).toBe(toUnits("4"));
    expect(r.overCap).toBe(true);
  });

  it("refuses vendor payments above the cap (the contract cannot produce them)", () => {
    expect(() =>
      computeSettlement({ gross: toUnits("20"), maxExpense: toUnits("10"), contributorBps: 3000, expenses: [demo[0]] }),
    ).toThrow(/exceed the expense cap/);
  });

  it("blocks settlement while an expense is pending", () => {
    expect(() =>
      computeSettlement({ gross: toUnits("20"), maxExpense: toUnits("13"), contributorBps: 3000, expenses: [exp({ id: "p", status: "PENDING" })] }),
    ).toThrow(SettlementBlockedError);
  });

  it("excludes rejected, failed-status and evidence-less expenses", () => {
    const r = computeSettlement({
      gross: toUnits("20"),
      maxExpense: toUnits("13"),
      contributorBps: 3000,
      expenses: [
        exp({ id: "rej", status: "REJECTED" }),
        exp({ id: "noev", category: "inference", evidenceRef: null }),
        exp({ id: "wrongstatus", category: "inference", status: "PAID" }),
      ],
    });
    expect(r.expensesCounted).toBe(0n);
    expect(r.excludedExpenseIds.sort()).toEqual(["noev", "rej", "wrongstatus"]);
  });

  it("gives rounding dust to the owner", () => {
    const r = computeSettlement({ gross: 7n, maxExpense: 0n, contributorBps: 3000, expenses: [] });
    expect(r.contributorShare).toBe(2n);
    expect(r.ownerShare).toBe(5n);
  });

  it("rejects invalid inputs", () => {
    expect(() => computeSettlement({ gross: 0n, maxExpense: 0n, contributorBps: 3000, expenses: [] })).toThrow();
    expect(() => computeSettlement({ gross: 10n, maxExpense: 0n, contributorBps: 10001, expenses: [] })).toThrow();
    expect(() => computeSettlement({ gross: 10n, maxExpense: 0n, contributorBps: 30.5, expenses: [] })).toThrow();
  });

  it("holds the sum invariant across many generated cases", () => {
    let seed = 42;
    const rand = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % max;
    };
    for (let i = 0; i < 5000; i++) {
      const gross = BigInt(1 + rand(100_000_000));
      const rawCap = BigInt(rand(100_000_000));
      const cap = rawCap > gross ? gross : rawCap;
      const vendor = cap === 0n ? 0n : BigInt(rand(Number(cap) + 1));
      const expenses: ExpenseInput[] = [
        exp({ id: "v", category: "supplier", amount: vendor }),
        exp({ id: "i", category: "inference", amount: BigInt(rand(50_000_000)) }),
      ];
      const r = computeSettlement({ gross, maxExpense: cap, contributorBps: rand(10_001), expenses });
      expect(r.paidToVendors + r.reimbOwner + r.contributorShare + r.ownerShare).toBe(gross);
      expect(r.expensesCounted <= cap).toBe(true);
    }
  });
});

describe("computeRefund", () => {
  it("makes the customer whole and tells the owner how much to top up", () => {
    const r = computeRefund(toUnits("20"), demo);
    expect(r.refundToCustomer).toBe(toUnits("20"));
    expect(r.escrowAvailable).toBe(toUnits("8"));
    expect(r.ownerTopUpRequired).toBe(toUnits("12"));
    expect(r.unrecoveredLoss).toBe(toUnits("12.4"));
  });

  it("needs no top-up when nothing was bought", () => {
    const r = computeRefund(toUnits("20"), []);
    expect(r.escrowAvailable).toBe(toUnits("20"));
    expect(r.ownerTopUpRequired).toBe(0n);
  });
});

describe("cross-chain (treasury) purchases", () => {
  it("reimburses the owner like the contract's settle (matches contract test numbers)", () => {
    const r = computeSettlement({
      gross: toUnits("20"),
      maxExpense: toUnits("13"),
      contributorBps: 3000,
      expenses: [exp({ id: "evm", category: "treasury", amount: toUnits("5"), evidenceRef: "sepolia:0xabc" }), exp({ id: "llm", category: "inference", amount: 1_000n, evidenceRef: "chat:1" })],
    });
    expect(r.paidToVendors).toBe(0n);
    expect(r.reimbOwner).toBe(5_001_000n);
    expect(r.contributorShare).toBe(4_499_700n);
    expect(r.ownerShare).toBe(10_499_300n);
  });
  it("ignores treasury expenses without evidence", () => {
    const r = computeSettlement({ gross: toUnits("20"), maxExpense: toUnits("13"), contributorBps: 3000, expenses: [exp({ id: "evm", category: "treasury", amount: toUnits("5"), evidenceRef: null })] });
    expect(r.excludedExpenseIds).toEqual(["evm"]);
    expect(r.reimbOwner).toBe(0n);
  });
});

describe("business reserve (mirrors the contract tests)", async () => {
  const { reserveCut } = await import("./revenue");
  const inf = [exp({ id: "llm", category: "inference", amount: toUnits("0.4"), evidenceRef: "chat:1" })];
  it("comes out of the owner's share only", () => {
    const r = computeSettlement({ gross: toUnits("20"), maxExpense: toUnits("13"), contributorBps: 3000, expenses: inf, reserve: { bps: 1000, target: toUnits("20"), balance: 0n } });
    expect(r.contributorShare).toBe(5_880_000n);
    expect(r.reserveKept).toBe(1_372_000n);
    expect(r.ownerPayout).toBe(12_348_000n);
    expect(r.legs.reduce((a, l) => a + l.amount, 0n)).toBe(toUnits("20"));
  });
  it("stops at the target", () => {
    expect(reserveCut(13_720_000n, 5000, toUnits("8"), 6_860_000n)).toBe(1_140_000n);
    expect(reserveCut(13_720_000n, 5000, toUnits("8"), toUnits("8"))).toBe(0n);
  });
  it("keeps nothing without a rule", () => {
    const r = computeSettlement({ gross: toUnits("20"), maxExpense: toUnits("13"), contributorBps: 3000, expenses: inf });
    expect(r.reserveKept).toBe(0n);
    expect(r.ownerPayout).toBe(r.ownerShare);
  });
});
