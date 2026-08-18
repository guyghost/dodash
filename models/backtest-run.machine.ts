import { assign, setup } from "xstate";

import type {
  BacktestError,
  BacktestRunContext,
  BacktestRunEvent,
  BacktestRunInput,
} from "./backtest-run.types.js";

const eventError = (event: BacktestRunEvent): BacktestError | null =>
  "error" in event ? event.error : null;

export const backtestRunMachine = setup({
  types: {
    context: {} as BacktestRunContext,
    events: {} as BacktestRunEvent,
    input: {} as BacktestRunInput,
  },
  guards: {
    canStart: ({ event }) =>
      event.type === "START_REQUESTED" &&
      event.runId.trim().length > 0 &&
      event.permissions.canRunBacktest,
    canRetryLoad: ({ context, event }) =>
      event.type === "HISTORICAL_DATA_FAILED" &&
      event.error.retryable &&
      context.loadAttempts < context.maxLoadRetries,
    validDataset: ({ event }) =>
      event.type === "HISTORICAL_DATA_READY" &&
      event.datasetId.trim().length > 0 &&
      Number.isSafeInteger(event.candleCount) &&
      event.candleCount > 0,
    validProgress: ({ context, event }) =>
      event.type === "REPLAY_PROGRESS" &&
      Number.isSafeInteger(event.processedCandles) &&
      event.processedCandles >= context.processedCandles &&
      event.processedCandles <= context.candleCount,
    cancelRequested: ({ context }) => context.cancelRequested,
  },
  actions: {
    initializeRun: assign(({ event }) =>
      event.type === "START_REQUESTED"
        ? {
            runId: event.runId,
            datasetId: null,
            candleCount: 0,
            processedCandles: 0,
            tradesId: null,
            tradeCount: 0,
            metricsId: null,
            loadAttempts: 0,
            cancelRequested: false,
            lastError: null,
          }
        : {},
    ),
    recordPermissionDenied: assign({
      lastError: {
        code: "BACKTEST_PERMISSION_REQUIRED",
        retryable: false,
      },
    }),
    recordDataset: assign(({ event }) =>
      event.type === "HISTORICAL_DATA_READY"
        ? { datasetId: event.datasetId, candleCount: event.candleCount }
        : {},
    ),
    recordInvalidDataset: assign({
      lastError: { code: "INVALID_HISTORICAL_DATA", retryable: false },
    }),
    recordError: assign(({ event }) => ({ lastError: eventError(event) })),
    incrementLoadAttempt: assign(({ context }) => ({
      loadAttempts: context.loadAttempts + 1,
    })),
    requestCancel: assign({ cancelRequested: true }),
    recordProgress: assign(({ event }) =>
      event.type === "REPLAY_PROGRESS"
        ? { processedCandles: event.processedCandles }
        : {},
    ),
    recordReplay: assign(({ context, event }) =>
      event.type === "REPLAY_COMPLETED"
        ? {
            tradesId: event.tradesId,
            tradeCount: event.tradeCount,
            processedCandles: context.candleCount,
          }
        : {},
    ),
    recordMetrics: assign(({ event }) =>
      event.type === "METRICS_COMPUTED" ? { metricsId: event.metricsId } : {},
    ),
  },
}).createMachine({
  id: "backtestRun",
  context: ({ input }) => ({
    runId: null,
    datasetId: null,
    candleCount: 0,
    processedCandles: 0,
    tradesId: null,
    tradeCount: 0,
    metricsId: null,
    loadAttempts: 0,
    maxLoadRetries: input.maxLoadRetries ?? 3,
    cancelRequested: false,
    lastError: null,
  }),
  initial: "idle",
  on: {
    CANCEL_REQUESTED: { actions: "requestCancel" },
  },
  states: {
    idle: {
      on: {
        START_REQUESTED: [
          { guard: "canStart", target: "loadingHistoricalData", actions: "initializeRun" },
          { actions: "recordPermissionDenied" },
        ],
      },
    },
    loadingHistoricalData: {
      always: { guard: "cancelRequested", target: "cancelling" },
      on: {
        HISTORICAL_DATA_READY: [
          { guard: "validDataset", target: "replaying", actions: "recordDataset" },
          { target: "failed", actions: "recordInvalidDataset" },
        ],
        HISTORICAL_DATA_FAILED: [
          {
            guard: "canRetryLoad",
            target: "retryingLoad",
            actions: ["recordError", "incrementLoadAttempt"],
          },
          { target: "failed", actions: "recordError" },
        ],
      },
    },
    retryingLoad: {
      always: { guard: "cancelRequested", target: "cancelling" },
      on: { RETRY_TIMER_ELAPSED: "loadingHistoricalData" },
    },
    replaying: {
      always: { guard: "cancelRequested", target: "cancelling" },
      on: {
        REPLAY_PROGRESS: { guard: "validProgress", actions: "recordProgress" },
        REPLAY_COMPLETED: { target: "computingMetrics", actions: "recordReplay" },
        REPLAY_FAILED: { target: "failed", actions: "recordError" },
      },
    },
    computingMetrics: {
      always: { guard: "cancelRequested", target: "cancelling" },
      on: {
        METRICS_COMPUTED: { target: "completed", actions: "recordMetrics" },
        METRICS_FAILED: { target: "failed", actions: "recordError" },
      },
    },
    cancelling: {
      on: {
        EFFECT_CANCELLED: "cancelled",
        EFFECT_CANCEL_FAILED: { target: "failed", actions: "recordError" },
      },
    },
    completed: { type: "final" },
    cancelled: { type: "final" },
    failed: { type: "final" },
  },
});

