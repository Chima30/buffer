import { describe, expect, it } from "vitest";
import { planGasRefill } from "./treasury";

const N = 10n ** 24n;
const t = (over: Record<string, unknown> = {}) => ({ reserve_bps: 1000, reserve_target: "20000000", reserve_balance: "0", gas_reserve: String(5n * N), gas_refill_amount: String(N / 2n), gas_week_cap: String(2n * N), gas_week_start_ns: 0, gas_spent_week: "0", ...over });
const now = 10n ** 18n;

describe("gas refill planning", () => {
  it("refills only when the agent is low", () => {
    expect(planGasRefill(t(), 2n * N, now).needed).toBe(false);
    expect(planGasRefill(t(), N / 10n, now).needed).toBe(true);
  });
  it("respects the weekly cap and resets after a week", () => {
    expect(planGasRefill(t({ gas_spent_week: String(2n * N), gas_week_start_ns: Number(now - 1000n) }), 0n, now).needed).toBe(false);
    expect(planGasRefill(t({ gas_spent_week: String(2n * N), gas_week_start_ns: 0 }), 0n, now).needed).toBe(true);
  });
  it("does nothing without rules, reserve or a readable balance", () => {
    expect(planGasRefill(null, 0n, now).needed).toBe(false);
    expect(planGasRefill(t({ gas_refill_amount: "0" }), 0n, now).needed).toBe(false);
    expect(planGasRefill(t({ gas_reserve: "1" }), 0n, now).reason).toMatch(/owner must fund/);
    expect(planGasRefill(t(), null, now).needed).toBe(false);
  });
});
