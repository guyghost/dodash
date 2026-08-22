import { describe, expect, it } from "vitest";

import * as backtest from "../src/index.js";

describe("backtest CLI options", () => {
  it("expose un parseur d’options déterministe", () => {
    expect(
      typeof (backtest as Record<string, unknown>).parseBacktestCliOptions,
    ).toBe("function");
  });

  it("utilise les 365 dernières bougies journalières complètement closes", () => {
    const result = backtest.parseBacktestCliOptions(
      [],
      Date.UTC(2026, 7, 18, 12, 30),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.productId).toBe("BTC-USD");
    expect(result.value.timeframe).toBe("ONE_DAY");
    expect(result.value.executionTimeframe).toBeNull();
    expect(result.value.targetSignalNotional).toBe(1_000);
    expect(result.value.confidenceCalibration).toBe("IDENTITY");
    expect(result.value.protectiveExit).toEqual({ mode: "NONE" });
    expect(result.value.startAt).toBe(Date.UTC(2025, 7, 18));
    expect(result.value.endAt).toBe(Date.UTC(2026, 7, 18));
    expect(result.value.outputPath).toBe(
      ".artifacts/backtests/BTC-USD-ONE_DAY-notional-1000-2025-08-18-2026-08-18.json",
    );
    expect(backtest.createBacktestRunId(result.value)).toBe(
      "bt:BTC-USD:ONE_DAY:notional:1000:1755475200000:1787011200000",
    );
  });

  it("fige une calibration non identité dans le manifeste", () => {
    const result = backtest.parseBacktestCliOptions(
      ["--confidence-calibration", "POWER_THIRD"],
      Date.UTC(2026, 7, 18),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.confidenceCalibration).toBe("POWER_THIRD");
    expect(result.value.outputPath).toBe(
      ".artifacts/backtests/BTC-USD-ONE_DAY-notional-1000-confidence-power-third-2025-08-18-2026-08-18.json",
    );
    expect(backtest.createBacktestRunId(result.value)).toBe(
      "bt:BTC-USD:ONE_DAY:notional:1000:confidence:POWER_THIRD:1755475200000:1787011200000",
    );
  });

  it("accepte une fenêtre UTC explicite", () => {
    const result = backtest.parseBacktestCliOptions(
      ["--start", "2024-01-01", "--end", "2025-01-01", "--output", "report.json"],
      Date.UTC(2026, 7, 18),
    );

    expect(result.ok && result.value).toMatchObject({
      startAt: Date.UTC(2024, 0, 1),
      endAt: Date.UTC(2025, 0, 1),
      outputPath: "report.json",
    });
  });

  it("accepte le séparateur initial transmis par pnpm", () => {
    const result = backtest.parseBacktestCliOptions(
      ["--", "--product", "ETC-USD"],
      Date.UTC(2026, 7, 18),
    );

    expect(result.ok && result.value.productId).toBe("ETC-USD");
    expect(
      backtest.parseBacktestCliOptions(
        ["--product", "ETC-USD", "--", "ignored"],
        Date.UTC(2026, 7, 18),
      ),
    ).toEqual({ ok: false, error: { code: "INVALID_CLI_OPTIONS" } });
  });

  it("fige une résolution fine et un bracket fixe dans le manifeste", () => {
    const result = backtest.parseBacktestCliOptions(
      [
        "--target-signal-notional",
        "750.5",
        "--timeframe",
        "ONE_DAY",
        "--execution-timeframe",
        "SIX_HOUR",
        "--protective-exit",
        "FIXED_BPS",
        "--stop-loss-bps",
        "150",
        "--take-profit-bps",
        "300",
        "--start",
        "2025-01-01",
        "--end",
        "2026-01-01",
      ],
      Date.UTC(2026, 7, 18),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.executionTimeframe).toBe("SIX_HOUR");
    expect(result.value.targetSignalNotional).toBe(750.5);
    expect(result.value.protectiveExit).toEqual({
      mode: "FIXED_BPS",
      stopLossBps: 150,
      takeProfitBps: 300,
    });
    expect(result.value.outputPath).toBe(
      ".artifacts/backtests/BTC-USD-ONE_DAY-notional-750.5-exec-SIX_HOUR-fixed-150-300-2025-01-01-2026-01-01.json",
    );
    expect(backtest.createBacktestRunId(result.value)).toBe(
      "bt:BTC-USD:ONE_DAY:notional:750.5:exec:SIX_HOUR:protective:FIXED_BPS:150:300:1735689600000:1767225600000",
    );
  });

  it.each(["0", "-1", "NaN", "Infinity"])(
    "refuse le notionnel cible invalide %s",
    (value) => {
      expect(
        backtest.parseBacktestCliOptions(
          ["--target-signal-notional", value],
          Date.UTC(2026, 7, 18),
        ),
      ).toEqual({ ok: false, error: { code: "INVALID_CLI_OPTIONS" } });
    },
  );

  it("refuse un profil de calibration inconnu", () => {
    expect(
      backtest.parseBacktestCliOptions(
        ["--confidence-calibration", "POWER_FIFTH"],
        Date.UTC(2026, 7, 18),
      ),
    ).toEqual({ ok: false, error: { code: "INVALID_CLI_OPTIONS" } });
  });

  it("refuse une résolution égale ou plus grossière", () => {
    expect(
      backtest.parseBacktestCliOptions(
        [
          "--timeframe",
          "ONE_HOUR",
          "--execution-timeframe",
          "SIX_HOUR",
        ],
        Date.UTC(2026, 7, 18),
      ),
    ).toEqual({ ok: false, error: { code: "INVALID_CLI_OPTIONS" } });
  });

  it("refuse un bracket partiel ou des seuils avec NONE", () => {
    expect(
      backtest.parseBacktestCliOptions(
        ["--protective-exit", "FIXED_BPS", "--stop-loss-bps", "150"],
        Date.UTC(2026, 7, 18),
      ),
    ).toEqual({ ok: false, error: { code: "INVALID_CLI_OPTIONS" } });
    expect(
      backtest.parseBacktestCliOptions(
        ["--protective-exit", "NONE", "--stop-loss-bps", "150"],
        Date.UTC(2026, 7, 18),
      ),
    ).toEqual({ ok: false, error: { code: "INVALID_CLI_OPTIONS" } });
  });

  it("rejette une borne inconnue ou une fenêtre inversée", () => {
    expect(
      backtest.parseBacktestCliOptions(
        ["--start", "2025-01-02", "--end", "2025-01-01"],
        Date.UTC(2026, 7, 18),
      ),
    ).toEqual({ ok: false, error: { code: "INVALID_CLI_OPTIONS" } });
    expect(
      backtest.parseBacktestCliOptions(["--unknown", "value"], Date.UTC(2026, 7, 18)),
    ).toEqual({ ok: false, error: { code: "INVALID_CLI_OPTIONS" } });
  });

  it("fige REGIME_CONDITIONAL (stop/take requis, régime requis) dans le manifeste", () => {
    const result = backtest.parseBacktestCliOptions(
      [
        "--protective-exit",
        "REGIME_CONDITIONAL",
        "--stop-loss-bps",
        "300",
        "--take-profit-bps",
        "600",
        "--regime-filter",
        "EMA_THRESHOLD",
        "--start",
        "2025-01-01",
        "--end",
        "2026-01-01",
      ],
      Date.UTC(2026, 7, 18),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.protectiveExit).toEqual({
      mode: "REGIME_CONDITIONAL",
      bullish: { mode: "NONE" },
      bearish: { mode: "FIXED_BPS", stopLossBps: 300, takeProfitBps: 600 },
      range: { mode: "FIXED_BPS", stopLossBps: 300, takeProfitBps: 600 },
      warmUp: { mode: "FIXED_BPS", stopLossBps: 300, takeProfitBps: 600 },
    });
    expect(result.value.outputPath).toBe(
      ".artifacts/backtests/BTC-USD-ONE_DAY-notional-1000-regime-exit-300-600-regime-100-5-3-2025-01-01-2026-01-01.json",
    );
    expect(backtest.createBacktestRunId(result.value)).toBe(
      "bt:BTC-USD:ONE_DAY:notional:1000:protective:regime-exit:300:600:regime:100:5:3:1735689600000:1767225600000",
    );
  });

  it("refuse REGIME_CONDITIONAL sans stop/take ou sans regime-filter (RE7)", () => {
    expect(
      backtest.parseBacktestCliOptions(
        [
          "--protective-exit",
          "REGIME_CONDITIONAL",
          "--stop-loss-bps",
          "300",
          "--regime-filter",
          "EMA_THRESHOLD",
        ],
        Date.UTC(2026, 7, 18),
      ),
    ).toEqual({ ok: false, error: { code: "INVALID_CLI_OPTIONS" } });
    expect(
      backtest.parseBacktestCliOptions(
        [
          "--protective-exit",
          "REGIME_CONDITIONAL",
          "--stop-loss-bps",
          "300",
          "--take-profit-bps",
          "600",
        ],
        Date.UTC(2026, 7, 18),
      ),
    ).toEqual({ ok: false, error: { code: "INVALID_CLI_OPTIONS" } });
  });
});
