import { describe, expect, it } from "vitest";

import {
  FUNDING_TREND_ENTER_THRESHOLD,
  FUNDING_TREND_THRESHOLD_PERCENTILE,
} from "./funding-rate-strategy.js";

describe("seuil funding-trend (dao #38, models/funding-rate-strategy.md §5)", () => {
  it("constante figée : valeur verrouillée au modèle (C3)", () => {
    expect(FUNDING_TREND_ENTER_THRESHOLD).toBe(0.0000088750099537037);
  });

  it("percentile figé de la règle de calibration", () => {
    expect(FUNDING_TREND_THRESHOLD_PERCENTILE).toBe(75);
  });

  it("seuil strictement positif et fini (décision pure, INV-F4)", () => {
    expect(Number.isFinite(FUNDING_TREND_ENTER_THRESHOLD)).toBe(true);
    expect(FUNDING_TREND_ENTER_THRESHOLD).toBeGreaterThan(0);
  });
});
