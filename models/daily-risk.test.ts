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

describe("resolvePaperDailyRisk (amendement 2026-09-28)", () => {
  const day = Date.UTC(2026, 8, 27);
  const valuation = (equity: number | null, quality: "fresh" | "stale" | "unavailable") =>
    ({
      ok: true as const,
      value: {
        asOf: day,
        equity,
        exposureNotional: null,
        exposureQuality: quality,
        markPrice: null,
        markSource: null,
        timeframe: null,
        candleClosedAt: null,
        ageMs: null,
        quality,
      },
    });
  const call = (
    current: Window | null,
    currentDailyPnl: number,
    now: number,
    projected: unknown,
  ) => {
    const exported = modelExports as Record<string, unknown>;
    expect(typeof exported.resolvePaperDailyRisk).toBe("function");
    return (
      exported.resolvePaperDailyRisk as (
        ...args: readonly unknown[]
      ) => { readonly window: Window | null; readonly dailyPnl: number }
    )(current, currentDailyPnl, now, projected);
  };

  it("résout la fenêtre depuis une équité marquée fraîche", () => {
    expect(call(null, 0, day + 3_600_000, valuation(10_000, "fresh"))).toEqual({
      window: { utcDayStart: day, openingEquity: 10_000 },
      dailyPnl: 0,
    });
  });

  it("garde une équité stale comme dernière valeur connue", () => {
    expect(
      call({ utcDayStart: day, openingEquity: 10_000 }, 0, day + 7_200_000, valuation(9_990, "stale")),
    ).toEqual({
      window: { utcDayStart: day, openingEquity: 10_000 },
      dailyPnl: -10,
    });
  });

  it("porte la fenêtre et le PnL inchangés quand l'équité est indisponible", () => {
    const current = { utcDayStart: day, openingEquity: 9_990.29 };
    expect(call(current, -9.71, day + 86_400_000 + 46_000, valuation(null, "unavailable"))).toEqual({
      window: current,
      dailyPnl: -9.71,
    });
  });

  it("n'ouvre aucune fenêtre au premier cycle du jour sans mark", () => {
    expect(call(null, 0, day + 46_000, valuation(null, "unavailable"))).toEqual({
      window: null,
      dailyPnl: 0,
    });
  });

  it("porte l'état inchangé sur une projection en échec", () => {
    const current = { utcDayStart: day, openingEquity: 10_000 };
    expect(
      call(current, 3, day + 10, { ok: false, error: { code: "INVALID_MARK" } }),
    ).toEqual({ window: current, dailyPnl: 3 });
  });
});
