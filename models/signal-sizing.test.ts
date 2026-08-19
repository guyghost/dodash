import { describe, expect, it } from "vitest";

import { resolveTargetSignalQuantity } from "./signal-sizing.js";

describe("target signal notional sizing", () => {
  it("dérive des quantités différentes pour un même notionnel", () => {
    expect(resolveTargetSignalQuantity(1_000, 10)).toEqual({
      ok: true,
      value: 100,
    });
    expect(resolveTargetSignalQuantity(1_000, 250)).toEqual({
      ok: true,
      value: 4,
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuse le notionnel cible invalide %s",
    (targetSignalNotional) => {
      expect(resolveTargetSignalQuantity(targetSignalNotional, 100)).toEqual({
        ok: false,
        error: { code: "INVALID_TARGET_SIGNAL_NOTIONAL" },
      });
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuse le prix de référence invalide %s",
    (referencePrice) => {
      expect(resolveTargetSignalQuantity(1_000, referencePrice)).toEqual({
        ok: false,
        error: { code: "INVALID_SIGNAL_REFERENCE_PRICE" },
      });
    },
  );

  it("refuse une quantité calculée nulle", () => {
    expect(
      resolveTargetSignalQuantity(Number.MIN_VALUE, Number.MAX_VALUE),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_RESOLVED_SIGNAL_QUANTITY" },
    });
  });
});
