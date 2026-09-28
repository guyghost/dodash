import { describe, expect, it } from "vitest";

import { resolveCycleSchedule, resolveMissedDecision } from "./cycle-schedule.js";

describe("resolveCycleSchedule", () => {
  it.each([
    [60, "* * * * *"],
    [300, "*/5 * * * *"],
    [900, "*/15 * * * *"],
    [3_600, "1 * * * *"],
    [21_600, "1 */6 * * *"],
    [86_400, "1 0 * * *"],
  ])("aligne %i s sur la grille %s", (interval, expression) => {
    expect(resolveCycleSchedule(interval)).toEqual({ kind: "cron", expression, intervalSeconds: interval });
  });

  it.each([7, 90, 7_200 + 60, 100_000])("retombe sur l'intervalle pour %i s", (interval) => {
    expect(resolveCycleSchedule(interval)).toEqual({ kind: "interval", intervalSeconds: interval });
  });
});

describe("resolveMissedDecision", () => {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;
  const candle = Date.UTC(2026, 8, 27);
  const input = (triggeredAt: number, last: number | null, reported: number | null) => ({
    triggeredAt,
    timeframeMs: DAY,
    maxMarketStalenessMs: 2 * HOUR,
    lastDecisionCandleClosedAt: last,
    lastMissedDecisionCandleClosedAt: reported,
  });

  it("signale la bougie manquée au premier cycle terminé après la fenêtre", () => {
    expect(resolveMissedDecision(input(candle + 3 * HOUR, candle - DAY, null))).toEqual({
      missed: true,
      decisionCandleClosedAt: candle,
    });
  });

  it("ne signale rien pendant la fenêtre de fraîcheur", () => {
    expect(resolveMissedDecision(input(candle + 1 * HOUR, null, null))).toEqual({ missed: false, decisionCandleClosedAt: candle });
    expect(resolveMissedDecision(input(candle + 2 * HOUR, null, null))).toEqual({ missed: false, decisionCandleClosedAt: candle });
  });

  it("ne signale rien quand la bougie a été décidée", () => {
    expect(resolveMissedDecision(input(candle + 3 * HOUR, candle, null))).toEqual({ missed: false, decisionCandleClosedAt: candle });
  });

  it("ne signale une bougie qu'une seule fois", () => {
    expect(resolveMissedDecision(input(candle + 4 * HOUR, null, candle))).toEqual({ missed: false, decisionCandleClosedAt: candle });
    expect(resolveMissedDecision(input(candle + DAY + 3 * HOUR, null, candle))).toEqual({
      missed: true,
      decisionCandleClosedAt: candle + DAY,
    });
  });
});
