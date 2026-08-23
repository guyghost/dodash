import { describe, expect, it } from "vitest";

import {
  extractBacktestDiagnosticSamples,
  summarizeBacktestDiagnostics,
} from "./backtest-diagnostics.js";

describe("backtest exposure diagnostics", () => {
  it("résume les signaux actifs par stratégie avec des quantiles interpolés", () => {
    const result = summarizeBacktestDiagnostics(
      [
        {
          strategyId: "rsi",
          side: "HOLD",
          confidence: 0,
          suggestedSize: 0,
          referencePrice: 100,
        },
        {
          strategyId: "rsi",
          side: "BUY",
          confidence: 0.25,
          suggestedSize: 4,
          referencePrice: 100,
        },
        {
          strategyId: "rsi",
          side: "SELL",
          confidence: 0.75,
          suggestedSize: 2,
          referencePrice: 200,
        },
      ],
      [],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.signals.byStrategy).toEqual([
      {
        strategyId: "rsi",
        evaluationCount: 3,
        activeSignalCount: 2,
        buySignalCount: 1,
        sellSignalCount: 1,
        activeSignalRate: 2 / 3,
        confidence: {
          count: 2,
          min: 0.25,
          median: 0.5,
          p95: 0.725,
          max: 0.75,
        },
        requestedNotional: {
          count: 2,
          min: 100,
          median: 200,
          p95: 290,
          max: 300,
        },
      },
    ]);
  });

  it("sépare plafonnement d’allocation et rejet risque", () => {
    const result = summarizeBacktestDiagnostics([], [
      {
        requestedNetNotional: 100,
        allocatedNotional: 100,
        spotInexecutableNotional: 0,
        riskApprovedNotional: 100,
        rejectedReasonCodes: [],
      },
      {
        requestedNetNotional: 1_000,
        allocatedNotional: 800,
        spotInexecutableNotional: 0,
        riskApprovedNotional: 800,
        rejectedReasonCodes: [],
      },
      {
        requestedNetNotional: 500,
        allocatedNotional: 500,
        spotInexecutableNotional: 0,
        riskApprovedNotional: 0,
        rejectedReasonCodes: ["SPOT_SHORT_FORBIDDEN", "DAILY_LOSS_LIMIT"],
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allocation).toEqual({
      opportunityCount: 3,
      cappedCount: 1,
      capRate: 1 / 3,
      spotInexecutableCount: 0,
      riskEvaluationCount: 3,
      riskRejectedCount: 1,
      riskRejectionRate: 1 / 3,
      riskRejectionReasons: {
        KILL_SWITCH_ACTIVE: 0,
        DAILY_LOSS_LIMIT: 1,
        COOLDOWN_ACTIVE: 0,
        SPOT_SHORT_FORBIDDEN: 1,
        ORDER_NOTIONAL_LIMIT: 0,
        POSITION_NOTIONAL_LIMIT: 0,
        GROSS_EXPOSURE_LIMIT: 0,
      },
      requestedNetNotional: {
        count: 3,
        min: 100,
        median: 500,
        p95: 950,
        max: 1_000,
      },
      allocatedNotional: {
        count: 3,
        min: 100,
        median: 500,
        p95: 770,
        max: 800,
      },
      riskApprovedNotional: {
        count: 3,
        min: 0,
        median: 100,
        p95: expect.closeTo(730, 10),
        max: 800,
      },
    });
  });

  it("représente explicitement les populations vides", () => {
    const result = summarizeBacktestDiagnostics([], []);

    expect(result).toEqual({
      ok: true,
      value: {
        signals: { byStrategy: [] },
        allocation: {
          opportunityCount: 0,
          cappedCount: 0,
          capRate: 0,
          spotInexecutableCount: 0,
          riskEvaluationCount: 0,
          riskRejectedCount: 0,
          riskRejectionRate: 0,
          riskRejectionReasons: {
            KILL_SWITCH_ACTIVE: 0,
            DAILY_LOSS_LIMIT: 0,
            COOLDOWN_ACTIVE: 0,
            SPOT_SHORT_FORBIDDEN: 0,
            ORDER_NOTIONAL_LIMIT: 0,
            POSITION_NOTIONAL_LIMIT: 0,
            GROSS_EXPOSURE_LIMIT: 0,
          },
          requestedNetNotional: {
            count: 0,
            min: null,
            median: null,
            p95: null,
            max: null,
          },
          allocatedNotional: {
            count: 0,
            min: null,
            median: null,
            p95: null,
            max: null,
          },
          riskApprovedNotional: {
            count: 0,
            min: null,
            median: null,
            p95: null,
            max: null,
          },
        },
      },
    });
  });

  it("projette les notionnels actifs bruts dans l'ordre d'évaluation", () => {
    const result = extractBacktestDiagnosticSamples([
      {
        strategyId: "rsi",
        side: "BUY",
        confidence: 0.5,
        suggestedSize: 2,
        referencePrice: 100,
      },
      {
        strategyId: "ema",
        side: "SELL",
        confidence: 0.25,
        suggestedSize: 4,
        referencePrice: 200,
      },
      {
        strategyId: "rsi",
        side: "HOLD",
        confidence: 0,
        suggestedSize: 0,
        referencePrice: 150,
      },
      {
        strategyId: "rsi",
        side: "SELL",
        confidence: 0.75,
        suggestedSize: 2,
        referencePrice: 200,
      },
    ]);

    expect(result).toEqual({
      ok: true,
      value: {
        requestedNotionalByStrategy: [
          { strategyId: "ema", values: [200] },
          { strategyId: "rsi", values: [100, 300] },
        ],
      },
    });
  });

  it("refuse de projeter une observation de signal invalide", () => {
    expect(
      extractBacktestDiagnosticSamples([
        {
          strategyId: "rsi",
          side: "BUY",
          confidence: Number.NaN,
          suggestedSize: 1,
          referencePrice: 100,
        },
      ]),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_SIGNAL_DIAGNOSTIC_OBSERVATION" },
    });
  });

  it("refuse une observation contraire à l’ordre du pipeline", () => {
    expect(
      summarizeBacktestDiagnostics([], [
        {
          requestedNetNotional: 100,
          allocatedNotional: 101,
          spotInexecutableNotional: 0,
          riskApprovedNotional: 100,
          rejectedReasonCodes: [],
        },
      ]),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_ALLOCATION_DIAGNOSTIC_OBSERVATION" },
    });
  });

  it("refuse un motif de rejet hors du référentiel", () => {
    expect(
      summarizeBacktestDiagnostics([], [
        {
          requestedNetNotional: 100,
          allocatedNotional: 100,
          spotInexecutableNotional: 0,
          riskApprovedNotional: 100,
          rejectedReasonCodes: ["NOT_A_REASON" as never],
        },
      ]),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_ALLOCATION_DIAGNOSTIC_OBSERVATION" },
    });
  });

  it("refuse un notionnel spot inexécutable supérieur au notionnel alloué", () => {
    expect(
      summarizeBacktestDiagnostics([], [
        {
          requestedNetNotional: 200,
          allocatedNotional: 100,
          spotInexecutableNotional: 150,
          riskApprovedNotional: 0,
          rejectedReasonCodes: [],
        },
      ]),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_ALLOCATION_DIAGNOSTIC_OBSERVATION" },
    });
  });

  it("exclut les décisions entièrement inexécutables de la mesure risk", () => {
    const result = summarizeBacktestDiagnostics([], [
      {
        requestedNetNotional: 100,
        allocatedNotional: 100,
        spotInexecutableNotional: 100,
        riskApprovedNotional: 0,
        rejectedReasonCodes: [],
      },
      {
        requestedNetNotional: 200,
        allocatedNotional: 200,
        spotInexecutableNotional: 0,
        riskApprovedNotional: 200,
        rejectedReasonCodes: [],
      },
      {
        requestedNetNotional: 300,
        allocatedNotional: 300,
        spotInexecutableNotional: 0,
        riskApprovedNotional: 0,
        rejectedReasonCodes: ["POSITION_NOTIONAL_LIMIT"],
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allocation.opportunityCount).toBe(3);
    expect(result.value.allocation.spotInexecutableCount).toBe(1);
    expect(result.value.allocation.riskEvaluationCount).toBe(2);
    expect(result.value.allocation.riskRejectedCount).toBe(1);
    expect(result.value.allocation.riskRejectionRate).toBe(1 / 2);
  });

  it.each([
    {
      strategyId: "",
      side: "BUY" as const,
      confidence: 1,
      suggestedSize: 1,
      referencePrice: 100,
    },
    {
      strategyId: "invalid-confidence",
      side: "BUY" as const,
      confidence: 1.1,
      suggestedSize: 1,
      referencePrice: 100,
    },
    {
      strategyId: "invalid-hold",
      side: "HOLD" as const,
      confidence: 0,
      suggestedSize: 1,
      referencePrice: 100,
    },
    {
      strategyId: "invalid-price",
      side: "SELL" as const,
      confidence: 1,
      suggestedSize: 1,
      referencePrice: 0,
    },
  ])("refuse une observation de signal invalide", (observation) => {
    expect(summarizeBacktestDiagnostics([observation], [])).toEqual({
      ok: false,
      error: { code: "INVALID_SIGNAL_DIAGNOSTIC_OBSERVATION" },
    });
  });
});
