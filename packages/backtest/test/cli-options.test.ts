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
    expect(result.value.startAt).toBe(Date.UTC(2025, 7, 18));
    expect(result.value.endAt).toBe(Date.UTC(2026, 7, 18));
    expect(result.value.outputPath).toBe(
      ".artifacts/backtests/BTC-USD-ONE_DAY-2025-08-18-2026-08-18.json",
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
});
