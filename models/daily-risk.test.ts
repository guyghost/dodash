import * as modelExports from "./index.js";
import { describe, expect, it } from "vitest";

type Window = {
  readonly utcDayStart: number;
  readonly openingEquity: number;
};

const resolve = (
  current: Window | null,
  now: number,
  markedEquity: number,
) => {
  const exported = modelExports as Record<string, unknown>;
  expect(typeof exported.resolveDailyRiskWindow).toBe("function");
  if (typeof exported.resolveDailyRiskWindow !== "function") return null;
  return (
    exported.resolveDailyRiskWindow as (
      value: Window | null,
      timestamp: number,
      equity: number,
    ) => { readonly window: Window; readonly dailyPnl: number }
  )(current, now, markedEquity);
};

describe("resolveDailyRiskWindow", () => {
  it("ouvre la première journée avec un PnL nul", () => {
    expect(resolve(null, Date.UTC(2026, 7, 20, 9), 10_250)).toEqual({
      window: {
        utcDayStart: Date.UTC(2026, 7, 20),
        openingEquity: 10_250,
      },
      dailyPnl: 0,
    });
  });

  it("mesure le PnL contre l'equity d'ouverture du même jour", () => {
    expect(
      resolve(
        { utcDayStart: Date.UTC(2026, 7, 20), openingEquity: 10_000 },
        Date.UTC(2026, 7, 20, 18),
        9_125,
      ),
    ).toEqual({
      window: {
        utcDayStart: Date.UTC(2026, 7, 20),
        openingEquity: 10_000,
      },
      dailyPnl: -875,
    });
  });

  it("ouvre le nouveau jour depuis la dernière equity marquée", () => {
    expect(
      resolve(
        { utcDayStart: Date.UTC(2026, 7, 20), openingEquity: 10_000 },
        Date.UTC(2026, 7, 21, 0, 0, 1),
        9_400,
      ),
    ).toEqual({
      window: {
        utcDayStart: Date.UTC(2026, 7, 21),
        openingEquity: 9_400,
      },
      dailyPnl: 0,
    });
  });
});
