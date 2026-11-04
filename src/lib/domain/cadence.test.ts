import { describe, expect, it } from "vitest";
import { cadence } from "./cadence";

describe("cadence", () => {
  it("names production intervals plainly and labels short ones as testnet pace", () => {
    expect(cadence(604800)).toBe("every week");
    expect(cadence(86400)).toBe("every day");
    expect(cadence(3600)).toBe("every hour (testnet demo pace)");
    expect(cadence(600)).toBe("every 10 minutes (testnet demo pace)");
  });
});
