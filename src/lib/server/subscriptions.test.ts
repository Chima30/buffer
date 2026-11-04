import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ db: () => ({}), must: (x: unknown) => x }));
const { issueBrief } = await import("./subscriptions");

describe("issueBrief", () => {
  it("keeps the topic and tells later issues what earlier ones covered", () => {
    expect(issueBrief("NEAR stablecoin activity", 1, 4, [])).toBe("NEAR stablecoin activity\n\n(Issue 1 of 4 of a subscription.)");
    const b = issueBrief("NEAR stablecoin activity", 3, 4, ["USDC supply on NEAR", "Intents volume"]);
    expect(b).toContain("Issue 3 of 4");
    expect(b).toContain('"USDC supply on NEAR"; "Intents volume"');
    expect(b).toContain("do not repeat them");
  });
  it("never exceeds the order brief limit", () => {
    expect(issueBrief("x".repeat(2000), 2, 2, ["y".repeat(3000)]).length).toBeLessThanOrEqual(4000);
  });
});
