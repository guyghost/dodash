import { describe, expect, it } from "vitest";

import { hasValidBearerToken } from "../src/auth.js";

describe("hasValidBearerToken", () => {
  const secret = "x".repeat(32);

  it("accepts the exact bearer secret", () => {
    expect(hasValidBearerToken(`Bearer ${secret}`, secret)).toBe(true);
  });

  it("fails closed for absent, short, or mismatched secrets", () => {
    expect(hasValidBearerToken(null, secret)).toBe(false);
    expect(hasValidBearerToken("Bearer short", "short")).toBe(false);
    expect(hasValidBearerToken(`Bearer ${"y".repeat(32)}`, secret)).toBe(false);
  });
});
