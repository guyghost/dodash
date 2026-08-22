import type {
  AllocationDiagnosticObservation,
  AllocationDiagnostics,
  BacktestDiagnosticSamplesResult,
  BacktestDiagnosticsErrorCode,
  BacktestDiagnosticsResult,
  NumericDistribution,
  RiskRejectionReasonCode,
  SignalDiagnosticObservation,
  StrategySignalDiagnostics,
} from "./backtest-diagnostics.types.js";
import { RISK_REJECTION_REASON_CODES } from "./backtest-diagnostics.types.js";

const nonNegativeFinite = (value: number): boolean =>
  Number.isFinite(value) && value >= 0;
const positiveFinite = (value: number): boolean =>
  Number.isFinite(value) && value > 0;
const validConfidence = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= 1;

const failure = (
  code: BacktestDiagnosticsErrorCode,
): Extract<BacktestDiagnosticsResult, { readonly ok: false }> =>
  Object.freeze({ ok: false as const, error: Object.freeze({ code }) });

const quantile = (sorted: readonly number[], probability: number): number | null => {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) return null;
  return lower + (upper - lower) * (position - lowerIndex);
};

const distribution = (values: readonly number[]): NumericDistribution => {
  if (values.length === 0) {
    return Object.freeze({
      count: 0,
      min: null,
      median: null,
      p95: null,
      max: null,
    });
  }
  const sorted = [...values].sort((left, right) => left - right);
  return Object.freeze({
    count: sorted.length,
    min: sorted[0] ?? null,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted.at(-1) ?? null,
  });
};

const tolerance = (reference: number): number =>
  Math.max(1, reference) * Number.EPSILON * 64;

const validSignalObservation = (
  observation: SignalDiagnosticObservation,
): boolean => {
  const validSide =
    observation.side === "BUY" ||
    observation.side === "SELL" ||
    observation.side === "HOLD";
  const requestedNotional =
    observation.suggestedSize *
    observation.confidence *
    observation.referencePrice;
  return (
    observation.strategyId.trim().length > 0 &&
    validSide &&
    validConfidence(observation.confidence) &&
    nonNegativeFinite(observation.suggestedSize) &&
    positiveFinite(observation.referencePrice) &&
    (observation.side !== "HOLD" || observation.suggestedSize === 0) &&
    nonNegativeFinite(requestedNotional)
  );
};

const validReasonCode = (code: string): code is RiskRejectionReasonCode =>
  (RISK_REJECTION_REASON_CODES as readonly string[]).includes(code);

const validAllocationObservation = (
  observation: AllocationDiagnosticObservation,
): boolean =>
  positiveFinite(observation.requestedNetNotional) &&
  nonNegativeFinite(observation.allocatedNotional) &&
  nonNegativeFinite(observation.riskApprovedNotional) &&
  observation.rejectedReasonCodes.every(validReasonCode) &&
  observation.allocatedNotional <=
    observation.requestedNetNotional +
      tolerance(observation.requestedNetNotional) &&
  observation.riskApprovedNotional <=
    observation.allocatedNotional + tolerance(observation.allocatedNotional);

export const extractBacktestDiagnosticSamples = (
  signalObservations: readonly SignalDiagnosticObservation[],
): BacktestDiagnosticSamplesResult => {
  if (!signalObservations.every(validSignalObservation)) {
    return failure("INVALID_SIGNAL_DIAGNOSTIC_OBSERVATION");
  }
  const strategyIds = [
    ...new Set(signalObservations.map(({ strategyId }) => strategyId)),
  ].sort();
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      requestedNotionalByStrategy: Object.freeze(
        strategyIds.map((strategyId) =>
          Object.freeze({
            strategyId,
            values: Object.freeze(
              signalObservations
                .filter(
                  (observation) =>
                    observation.strategyId === strategyId &&
                    observation.side !== "HOLD",
                )
                .map(
                  ({ suggestedSize, confidence, referencePrice }) =>
                    suggestedSize * confidence * referencePrice,
                ),
            ),
          }),
        ),
      ),
    }),
  });
};

export const summarizeBacktestDiagnostics = (
  signalObservations: readonly SignalDiagnosticObservation[],
  allocationObservations: readonly AllocationDiagnosticObservation[],
): BacktestDiagnosticsResult => {
  if (!signalObservations.every(validSignalObservation)) {
    return failure("INVALID_SIGNAL_DIAGNOSTIC_OBSERVATION");
  }
  if (!allocationObservations.every(validAllocationObservation)) {
    return failure("INVALID_ALLOCATION_DIAGNOSTIC_OBSERVATION");
  }

  const strategyIds = [...new Set(signalObservations.map(({ strategyId }) => strategyId))]
    .sort();
  const byStrategy: StrategySignalDiagnostics[] = strategyIds.map((strategyId) => {
    const observations = signalObservations.filter(
      (observation) => observation.strategyId === strategyId,
    );
    const active = observations.filter(({ side }) => side !== "HOLD");
    const buySignalCount = active.filter(({ side }) => side === "BUY").length;
    const sellSignalCount = active.filter(({ side }) => side === "SELL").length;
    return Object.freeze({
      strategyId,
      evaluationCount: observations.length,
      activeSignalCount: active.length,
      buySignalCount,
      sellSignalCount,
      activeSignalRate:
        observations.length === 0 ? 0 : active.length / observations.length,
      confidence: distribution(active.map(({ confidence }) => confidence)),
      requestedNotional: distribution(
        active.map(
          ({ suggestedSize, confidence, referencePrice }) =>
            suggestedSize * confidence * referencePrice,
        ),
      ),
    });
  });

  const cappedCount = allocationObservations.filter(
    ({ requestedNetNotional, allocatedNotional }) =>
      allocatedNotional <
      requestedNetNotional - tolerance(requestedNetNotional),
  ).length;
  const riskEvaluated = allocationObservations.filter(
    ({ allocatedNotional }) => allocatedNotional > 0,
  );
  const riskRejectedCount = riskEvaluated.filter(
    ({ allocatedNotional, riskApprovedNotional }) =>
      riskApprovedNotional <
      allocatedNotional - tolerance(allocatedNotional),
  ).length;
  const riskRejectionReasons = Object.freeze(
    Object.fromEntries(
      RISK_REJECTION_REASON_CODES.map((code) => [
        code,
        allocationObservations.reduce(
          (total, { rejectedReasonCodes }) =>
            total +
            rejectedReasonCodes.filter((reason) => reason === code).length,
          0,
        ),
      ]),
    ),
  ) as Readonly<Record<RiskRejectionReasonCode, number>>;
  const opportunityCount = allocationObservations.length;
  const allocation: AllocationDiagnostics = Object.freeze({
    opportunityCount,
    cappedCount,
    capRate: opportunityCount === 0 ? 0 : cappedCount / opportunityCount,
    riskEvaluationCount: riskEvaluated.length,
    riskRejectedCount,
    riskRejectionRate:
      riskEvaluated.length === 0
        ? 0
        : riskRejectedCount / riskEvaluated.length,
    riskRejectionReasons,
    requestedNetNotional: distribution(
      allocationObservations.map(({ requestedNetNotional }) => requestedNetNotional),
    ),
    allocatedNotional: distribution(
      allocationObservations.map(({ allocatedNotional }) => allocatedNotional),
    ),
    riskApprovedNotional: distribution(
      allocationObservations.map(
        ({ riskApprovedNotional }) => riskApprovedNotional,
      ),
    ),
  });

  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      signals: Object.freeze({ byStrategy: Object.freeze(byStrategy) }),
      allocation,
    }),
  });
};
