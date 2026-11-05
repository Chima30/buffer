import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ db: () => ({}), must: (x: unknown) => x }));
const { vendorPrice } = await import("./procurement");

describe("vendorPrice", () => {
  const v = { id: "vendor-1", unit_price_units: "10000000" };
  it("is the same for the same vendor and hour, so anyone can recompute it", () => {
    const at = new Date("2026-11-05T10:15:00Z");
    expect(vendorPrice(v, at)).toBe(vendorPrice(v, new Date("2026-11-05T10:59:59Z")));
  });
  it("stays within 15% of the base price and on 0.10 USDC steps", () => {
    for (let h = 0; h < 200; h++) {
      const p = vendorPrice(v, new Date(Date.UTC(2026, 10, 5, h)));
      expect(p).toBeGreaterThanOrEqual(8_500_000n);
      expect(p).toBeLessThanOrEqual(11_500_000n);
      expect(p % 100_000n).toBe(0n);
    }
  });
  it("moves between hours and between vendors", () => {
    const hours = new Set(Array.from({ length: 24 }, (_, h) => vendorPrice(v, new Date(Date.UTC(2026, 10, 5, h))).toString()));
    expect(hours.size).toBeGreaterThan(5);
    const at = new Date("2026-11-05T10:00:00Z");
    expect(vendorPrice({ id: "vendor-2", unit_price_units: "10000000" }, at)).not.toBe(vendorPrice(v, at));
  });
});
