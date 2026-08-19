import { describe, expect, it } from "vitest";

import { summarizeProtectiveExits } from "./protective-order.js";

describe("protective exit summary", () => {
  it("sépare stops, objectifs et ambiguïtés sans double compter le total", () => {
    const result = summarizeProtectiveExits([
      { kind: "STOP_LOSS", reason: "GAP_OPEN" },
      { kind: "STOP_LOSS", reason: "AMBIGUOUS_STOP_FIRST" },
      { kind: "TAKE_PROFIT", reason: "INTRABAR" },
    ]);

    expect(result).toEqual({
      protectiveExitCount: 3,
      stopLossExitCount: 2,
      takeProfitExitCount: 1,
      ambiguousExitCount: 1,
    });
    expect(result.protectiveExitCount).toBe(
      result.stopLossExitCount + result.takeProfitExitCount,
    );
    expect(result.ambiguousExitCount).toBeLessThanOrEqual(
      result.stopLossExitCount,
    );
  });

  it("retourne des compteurs nuls sans sortie", () => {
    expect(summarizeProtectiveExits([])).toEqual({
      protectiveExitCount: 0,
      stopLossExitCount: 0,
      takeProfitExitCount: 0,
      ambiguousExitCount: 0,
    });
  });
});
