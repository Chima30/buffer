import { describe, expect, it } from "vitest";
import { resolutionOf } from "./ledger-view";

const e = (event_type: string, status: string, at: string, order_id = "o1") => ({ event_type, status, at, order_id });

describe("resolutionOf", () => {
  it("marks a pending approval resolved by a later approval on the same order", () => {
    const pending = e("purchase_awaiting_approval", "PENDING", "2026-11-03T20:28:09Z");
    const all = [pending, e("purchase_approved", "REAL", "2026-11-03T20:30:08Z"), e("vendor_paid", "REAL", "2026-11-03T20:30:08Z")];
    expect(resolutionOf(pending, all)?.event_type).toBe("purchase_approved");
  });
  it("ignores other orders, earlier entries and non-pending rows", () => {
    const pending = e("purchase_awaiting_approval", "PENDING", "2026-11-03T20:28:09Z");
    expect(resolutionOf(pending, [pending, e("purchase_approved", "REAL", "2026-11-03T20:30:08Z", "o2")])).toBeNull();
    expect(resolutionOf(pending, [pending, e("purchase_approved", "REAL", "2026-11-03T20:00:00Z")])).toBeNull();
    expect(resolutionOf(e("payment_received", "REAL", "2026-11-03T20:00:00Z"), [])).toBeNull();
  });
});
