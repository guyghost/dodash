import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import { backtestRunMachine } from "./backtest-run.machine.js";

const createBacktest = () =>
  createActor(backtestRunMachine, { input: { maxLoadRetries: 2 } }).start();

describe("backtestRunMachine", () => {
  it("refuse le démarrage sans permission", () => {
    const actor = createBacktest();
    actor.send({
      type: "START_REQUESTED",
      runId: "run-1",
      permissions: { canRunBacktest: false },
    });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.lastError?.code).toBe(
      "BACKTEST_PERMISSION_REQUIRED",
    );
  });

  it("termine le workflow nominal", () => {
    const actor = createBacktest();
    actor.send({
      type: "START_REQUESTED",
      runId: "run-1",
      permissions: { canRunBacktest: true },
    });
    actor.send({
      type: "HISTORICAL_DATA_READY",
      datasetId: "dataset-1",
      candleCount: 100,
      executionDatasetId: null,
      executionCandleCount: 0,
    });
    actor.send({ type: "REPLAY_PROGRESS", processedCandles: 50 });
    actor.send({ type: "REPLAY_COMPLETED", tradesId: "trades-1", tradeCount: 4 });
    actor.send({ type: "METRICS_COMPUTED", metricsId: "metrics-1" });

    expect(actor.getSnapshot().value).toBe("completed");
    expect(actor.getSnapshot().context.processedCandles).toBe(100);
    expect(actor.getSnapshot().context.executionDatasetId).toBeNull();
    expect(actor.getSnapshot().context.executionCandleCount).toBe(0);
  });

  it("mémorise une provenance d’exécution complète", () => {
    const actor = createBacktest();
    actor.send({
      type: "START_REQUESTED",
      runId: "run-1",
      permissions: { canRunBacktest: true },
    });
    actor.send({
      type: "HISTORICAL_DATA_READY",
      datasetId: "dataset-1",
      candleCount: 100,
      executionDatasetId: "execution-dataset-1",
      executionCandleCount: 400,
    });

    expect(actor.getSnapshot().value).toBe("replaying");
    expect(actor.getSnapshot().context.executionDatasetId).toBe(
      "execution-dataset-1",
    );
    expect(actor.getSnapshot().context.executionCandleCount).toBe(400);
  });

  it("refuse une provenance d’exécution partielle", () => {
    const actor = createBacktest();
    actor.send({
      type: "START_REQUESTED",
      runId: "run-1",
      permissions: { canRunBacktest: true },
    });
    actor.send({
      type: "HISTORICAL_DATA_READY",
      datasetId: "dataset-1",
      candleCount: 100,
      executionDatasetId: "execution-dataset-1",
      executionCandleCount: 0,
    });

    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.lastError?.code).toBe(
      "INVALID_HISTORICAL_DATA",
    );

    const missingId = createBacktest();
    missingId.send({
      type: "START_REQUESTED",
      runId: "run-2",
      permissions: { canRunBacktest: true },
    });
    missingId.send({
      type: "HISTORICAL_DATA_READY",
      datasetId: "dataset-1",
      candleCount: 100,
      executionDatasetId: null,
      executionCandleCount: 400,
    });
    expect(missingId.getSnapshot().value).toBe("failed");
  });

  it("borne les retries de chargement", () => {
    const actor = createBacktest();
    actor.send({
      type: "START_REQUESTED",
      runId: "run-1",
      permissions: { canRunBacktest: true },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      actor.send({
        type: "HISTORICAL_DATA_FAILED",
        error: { code: "HISTORICAL_DATA_UNAVAILABLE", retryable: true },
      });
      actor.send({ type: "RETRY_TIMER_ELAPSED" });
    }
    actor.send({
      type: "HISTORICAL_DATA_FAILED",
      error: { code: "HISTORICAL_DATA_UNAVAILABLE", retryable: true },
    });
    expect(actor.getSnapshot().value).toBe("failed");
  });

  it("annule explicitement un replay", () => {
    const actor = createBacktest();
    actor.send({
      type: "START_REQUESTED",
      runId: "run-1",
      permissions: { canRunBacktest: true },
    });
    actor.send({
      type: "HISTORICAL_DATA_READY",
      datasetId: "dataset-1",
      candleCount: 100,
      executionDatasetId: null,
      executionCandleCount: 0,
    });
    actor.send({ type: "CANCEL_REQUESTED" });
    expect(actor.getSnapshot().value).toBe("cancelling");
    actor.send({ type: "EFFECT_CANCELLED" });
    expect(actor.getSnapshot().value).toBe("cancelled");
  });
});
