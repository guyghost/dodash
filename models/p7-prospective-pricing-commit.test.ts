import { describe, expect, it } from "vitest";
import { isP7PricingCommitRequest, evaluateP7PricingCommitClock } from "./p7-prospective-pricing-commit.js";
const start = Date.UTC(2026, 9, 16);
const manifest = { campaignId: "fixture", startAt: start, endAt: start + 180 * 86_400_000 };
const request = { campaignId: "fixture", commandId: "resolve", productId: "BTC-USD", candleClosedAt: start };
describe("P7 pricing commit gates", () => {
  it("accepts only a price-free closed request in campaign scope", () => {
    expect(isP7PricingCommitRequest(request, manifest)).toBe(true);
    for (const invalid of [null, {}, { ...request, price: 1 }, { ...request, commandId: "__manifest__" },
      { ...request, campaignId: "wrong" }, { ...request, productId: "BTC-PERP" }, { ...request, candleClosedAt: manifest.endAt }])
      expect(isP7PricingCommitRequest(invalid, manifest)).toBe(false);
  });
  it("checks the final clock without claiming disk flush time", () => {
    const args = { recordedAt: start + 1_000, commitCheckedAt: start + 6_000,
      sourceObservedAt: start + 1_000, candleClosedAt: start, campaignEndAt: manifest.endAt, simulatedFill: true };
    expect(evaluateP7PricingCommitClock(args)).toBeNull();
    expect(evaluateP7PricingCommitClock({ ...args, commitCheckedAt: start + 6_001 })).toBe("PRICING_EXPIRED_BEFORE_COMMIT");
    expect(evaluateP7PricingCommitClock({ ...args, commitCheckedAt: start })).toBe("COMMIT_CLOCK_INVALID");
    expect(evaluateP7PricingCommitClock({ ...args, commitCheckedAt: NaN })).toBe("COMMIT_CLOCK_INVALID");
    expect(evaluateP7PricingCommitClock({ ...args, sourceObservedAt: null })).toBe("PRICING_EXPIRED_BEFORE_COMMIT");
  });
  it("allows persisted refusals after expiry but never a fill at T1", () => {
    const args = { recordedAt: manifest.endAt, commitCheckedAt: manifest.endAt, sourceObservedAt: manifest.endAt,
      candleClosedAt: manifest.endAt - 86_400_000, campaignEndAt: manifest.endAt, simulatedFill: true };
    expect(evaluateP7PricingCommitClock(args)).toBe("PRICING_EXPIRED_BEFORE_COMMIT");
    expect(evaluateP7PricingCommitClock({ ...args, simulatedFill: false })).toBeNull();
  });
});
