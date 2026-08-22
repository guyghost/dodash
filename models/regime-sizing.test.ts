import { describe, expect, it } from "vitest";

import {
  isValidRegimeConditionalSizingPolicy,
  resolveRegimeSizingProfile,
  type RegimeConditionalSizingPolicy,
} from "./regime-sizing.js";

const policy: RegimeConditionalSizingPolicy = {
  bullish: "POWER_QUARTER",
  bearish: "POWER_HALF",
  range: "POWER_THIRD",
  warmUp: "IDENTITY",
};

describe("resolveRegimeSizingProfile — INV-S3 totalité", () => {
  it("BULLISH → bras bullish", () => {
    expect(resolveRegimeSizingProfile(policy, "BULLISH")).toBe(
      "POWER_QUARTER",
    );
  });

  it("BEARISH → bras bearish", () => {
    expect(resolveRegimeSizingProfile(policy, "BEARISH")).toBe("POWER_HALF");
  });

  it("RANGE → bras range", () => {
    expect(resolveRegimeSizingProfile(policy, "RANGE")).toBe("POWER_THIRD");
  });

  it("null (warm-up) → bras warmUp, jamais de défaut implicite", () => {
    expect(resolveRegimeSizingProfile(policy, null)).toBe("IDENTITY");
  });
});

describe("isValidRegimeConditionalSizingPolicy", () => {
  it("accepte une politique à quatre bras valides", () => {
    expect(isValidRegimeConditionalSizingPolicy(policy)).toBe(true);
  });

  it("rejette un bras invalide", () => {
    expect(
      isValidRegimeConditionalSizingPolicy({
        ...policy,
        bullish: "NOT_A_PROFILE" as RegimeConditionalSizingPolicy["bullish"],
      }),
    ).toBe(false);
    expect(
      isValidRegimeConditionalSizingPolicy({ ...policy, warmUp: null as never }),
    ).toBe(false);
  });
});
