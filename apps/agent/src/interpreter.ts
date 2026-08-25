import { allocateSignals } from "@dodash/allocator";
import { computeIndicators } from "@dodash/indicators-prolog";
import { checkRisk } from "@dodash/risk";
import {
  resolveDailyRiskWindow,
  type TradingCycleEvent,
  type WorkflowError,
  type WorkflowErrorCode,
  type WorkflowPhase,
} from "@dodash/models";
import type { Timeframe } from "@dodash/domain";

import { createTradingMachineSession } from "./machine-session.js";
import { createConfiguredStrategyRegistry } from "./strategy-registry.js";
import type {
  CycleArtifacts,
  ExecutionAuthorization,
  RunTradingCycleInput,
  RunTradingCycleResult,
} from "./types.js";

const MAX_INTERPRETER_STEPS = 64;

const timeframeMilliseconds: Readonly<Record<Timeframe, number>> = Object.freeze({
  ONE_MINUTE: 60_000,
  FIVE_MINUTE: 300_000,
  FIFTEEN_MINUTE: 900_000,
  ONE_HOUR: 3_600_000,
  SIX_HOUR: 21_600_000,
  ONE_DAY: 86_400_000,
});

const workflowError = (
  phase: WorkflowPhase,
  code: WorkflowErrorCode,
  retryable = false,
): WorkflowError => ({ phase, code, retryable });

const missingArtifact = (phase: WorkflowPhase): WorkflowError => {
  const code: WorkflowErrorCode =
    phase === "indicators"
      ? "INVALID_INDICATORS"
      : phase === "strategies"
        ? "STRATEGY_FAILURE"
        : phase === "allocation"
          ? "ALLOCATION_FAILURE"
          : phase === "risk"
            ? "RISK_FAILURE"
            : phase === "order-intent"
              ? "ORDER_INTENT_FAILURE"
              : phase === "authorization"
                ? "AUTHENTICATION_FAILURE"
                : phase === "reconciliation"
                  ? "RECONCILIATION_FAILURE"
                  : "PERSISTENCE_FAILURE";
  return workflowError(phase, code);
};

export const runTradingCycle = async (
  input: RunTradingCycleInput,
): Promise<RunTradingCycleResult> => {
  const session = createTradingMachineSession(
    {
      agentId: input.agentId,
      strategyIds: input.configuration.strategyIds,
      maxMarketStalenessMs: input.configuration.maxMarketStalenessMs,
    },
    input.machine,
  );
  const registry = createConfiguredStrategyRegistry(input.configuration);
  let artifacts = input.artifacts;
  let previousIndicators = input.previousIndicators;
  let portfolio = input.portfolio;
  let authorization: ExecutionAuthorization | undefined;
  let alarmTriggered = false;
  let dailyRiskWindow = input.dailyRiskWindow ?? null;
  let dailyPnl = input.dailyPnl;
  let accountEquity: number | null = null;
  let otherExposureNotional = 0;

  const currentResult = (): RunTradingCycleResult => ({
    machine: session.record,
    artifacts,
    previousIndicators,
    portfolio,
    dailyRiskWindow,
    dailyPnl,
    accountEquity,
    otherExposureNotional,
  });

  const send = async (event: TradingCycleEvent): Promise<void> => {
    session.send(event);
    await input.effects.persistMachine(session.record);
  };

  const checkpoint = async (
    next: CycleArtifacts,
    failureEvent: (error: WorkflowError) => TradingCycleEvent,
  ): Promise<boolean> => {
    artifacts = Object.freeze(next);
    const result = await input.effects.checkpoint(artifacts);
    if (result.ok) return true;
    await send(failureEvent(result.error));
    return false;
  };

  try {
    for (let step = 0; step < MAX_INTERPRETER_STEPS; step += 1) {
      switch (session.phase) {
        case "stopped":
        case "failed":
        case "halted":
          return currentResult();

        case "waiting":
          if (!input.triggerAlarm || alarmTriggered) {
            return currentResult();
          }
          artifacts = Object.freeze({
            cycleId: input.cycleId,
            triggeredAt: input.triggeredAt,
          });
          await send({
            type: "ALARM_FIRED",
            cycleId: input.cycleId,
            triggeredAt: input.triggeredAt,
          });
          alarmTriggered = true;
          break;

        case "scheduling": {
          const result = await input.effects.ensureSchedule(
            input.configuration.intervalSeconds,
          );
          await send(
            result.ok
              ? { type: "SCHEDULE_SUCCEEDED", nextWakeAt: result.value.nextWakeAt }
              : { type: "SCHEDULE_FAILED", error: result.error },
          );
          break;
        }

        case "retryingSchedule":
        case "retryingMarketData":
        case "retryingAuthorization":
        case "retryingExecution":
        case "retryingReconciliation":
        case "retryingAccountReconciliation":
        case "retryingPersistence":
          await send({ type: "RETRY_TIMER_ELAPSED" });
          break;

        case "reconcilingAccount": {
          const result = await input.effects.reconcileAccount(
            portfolio,
            artifacts?.triggeredAt ?? input.triggeredAt,
          );
          if (!result.ok) {
            await send({
              type: "ACCOUNT_RECONCILIATION_FAILED",
              error: result.error,
            });
            break;
          }
          portfolio = result.value.portfolio;
          accountEquity = result.value.accountEquity;
          otherExposureNotional = result.value.otherExposureNotional;
          const dailyRisk = resolveDailyRiskWindow(
            dailyRiskWindow,
            result.value.observedAt,
            result.value.accountEquity,
          );
          dailyRiskWindow = dailyRisk.window;
          dailyPnl = dailyRisk.dailyPnl;
          await send({
            type: "ACCOUNT_RECONCILED",
            snapshotId: result.value.snapshotId,
          });
          break;
        }

        case "fetchingMarketData": {
          const result = await input.effects.fetchMarketData(
            input.configuration,
            artifacts?.triggeredAt ?? input.triggeredAt,
          );
          if (!result.ok) {
            await send({ type: "MARKET_DATA_FAILED", error: result.error });
            break;
          }
          const current = artifacts ?? {
            cycleId: input.cycleId,
            triggeredAt: input.triggeredAt,
          };
          const next = Object.freeze({ ...current, market: result.value });
          if (
            !(await checkpoint(next, (error) => ({
              type: "MARKET_DATA_FAILED",
              error,
            })))
          ) {
            break;
          }
          const last = result.value.candles.at(-1);
          if (last === undefined) {
            await send({
              type: "MARKET_DATA_FAILED",
              error: workflowError("market-data", "INVALID_RESPONSE"),
            });
            break;
          }
          await send({
            type: "MARKET_DATA_READY",
            snapshotId: `market:${result.value.productId}:${last.start}:${result.value.candles.length}`,
            candleClosedAt:
              last.start + timeframeMilliseconds[result.value.timeframe],
          });
          break;
        }

        case "computingIndicators": {
          if (artifacts?.market === undefined) {
            await send({ type: "INDICATORS_FAILED", error: missingArtifact("indicators") });
            break;
          }
          const result = await computeIndicators(
            artifacts.market.candles,
            input.configuration.indicators,
          );
          if (!result.ok) {
            await send({
              type: "INDICATORS_FAILED",
              error: workflowError("indicators", "INVALID_INDICATORS"),
            });
            break;
          }
          const next = Object.freeze({ ...artifacts, indicators: result.value });
          if (
            !(await checkpoint(next, (error) => ({
              type: "INDICATORS_FAILED",
              error,
            })))
          ) {
            break;
          }
          await send({ type: "INDICATORS_COMPUTED", indicatorsId: result.value.snapshotId });
          break;
        }

        case "evaluatingStrategies": {
          if (artifacts?.market === undefined || artifacts.indicators === undefined) {
            await send({ type: "STRATEGIES_FAILED", error: missingArtifact("strategies") });
            break;
          }
          const result = registry.evaluateAll({
            productId: input.configuration.productId,
            candles: artifacts.market.candles,
            indicators: artifacts.indicators,
            previousIndicators,
          });
          if (!result.ok) {
            await send({
              type: "STRATEGIES_FAILED",
              error: workflowError("strategies", "STRATEGY_FAILURE"),
            });
            break;
          }
          const next = Object.freeze({ ...artifacts, signals: result.value });
          if (
            !(await checkpoint(next, (error) => ({
              type: "STRATEGIES_FAILED",
              error,
            })))
          ) {
            break;
          }
          await send({
            type: "STRATEGIES_EVALUATED",
            signalsId: `signals:${artifacts.cycleId}`,
          });
          break;
        }

        case "allocating": {
          const last = artifacts?.market?.candles.at(-1);
          if (artifacts?.signals === undefined || last === undefined) {
            await send({ type: "ALLOCATION_FAILED", error: missingArtifact("allocation") });
            break;
          }
          const decisionId = `decision:${artifacts.cycleId}`;
          const result = allocateSignals({
            agentId: input.agentId,
            cycleId: artifacts.cycleId,
            decisionId,
            signals: artifacts.signals,
            marketPrices: { [input.configuration.productId]: last.close },
            capitalAvailable: Math.max(0, portfolio.cash),
            maxDecisionNotional: input.configuration.maxDecisionNotional,
            minNetQuantity: input.configuration.minNetQuantity,
          });
          if (!result.ok) {
            await send({
              type: "ALLOCATION_FAILED",
              error: workflowError("allocation", "ALLOCATION_FAILURE"),
            });
            break;
          }
          const order = result.value.orders.at(0);
          const next = Object.freeze({
            ...artifacts,
            allocation: result.value,
            ...(order === undefined ? {} : { order }),
          });
          if (
            !(await checkpoint(next, (error) => ({
              type: "ALLOCATION_FAILED",
              error,
            })))
          ) {
            break;
          }
          await send({
            type: "ALLOCATION_COMPLETED",
            decisionId,
            orderCount: result.value.orders.length,
          });
          break;
        }

        case "checkingRisk": {
          const current = artifacts;
          const order = current?.order;
          const price = current?.market?.candles.at(-1)?.close;
          if (current === null || order === undefined || price === undefined) {
            await send({ type: "RISK_FAILED", error: missingArtifact("risk") });
            break;
          }
          const result = checkRisk(
            order,
            {
              marketPrice: price,
              currentPositionQuantity: portfolio.positionQuantity,
              otherExposureNotional,
              dailyPnl,
              lastTradeAt: input.lastTradeAt,
              now: current.triggeredAt,
              killSwitchActive: session.context.shutdownMode === "kill-switch",
            },
            input.configuration.risk,
          );
          if (!result.ok) {
            await send({ type: "RISK_FAILED", error: workflowError("risk", "RISK_FAILURE") });
            break;
          }
          const next = Object.freeze({ ...current, risk: result.value });
          if (
            !(await checkpoint(next, (error) => ({
              type: "RISK_FAILED",
              error,
            })))
          ) {
            break;
          }
          await send({
            type: result.value.status === "APPROVED" ? "RISK_APPROVED" : "RISK_REJECTED",
          });
          break;
        }

        case "persistingOrderIntent": {
          if (artifacts?.order === undefined) {
            await send({
              type: "ORDER_INTENT_FAILED",
              error: missingArtifact("order-intent"),
            });
            break;
          }
          const result = await input.effects.persistOrderIntent(
            artifacts.cycleId,
            artifacts.order,
          );
          await send(
            result.ok
              ? {
                  type: "ORDER_INTENT_PERSISTED",
                  clientOrderId: artifacts.order.clientOrderId,
                }
              : { type: "ORDER_INTENT_FAILED", error: result.error },
          );
          break;
        }

        case "authorizing": {
          if (artifacts?.order === undefined) {
            await send({
              type: "AUTHORIZATION_FAILED",
              error: missingArtifact("authorization"),
            });
            break;
          }
          const result = await input.effects.authorize(artifacts.order);
          if (result.ok) authorization = result.value;
          await send(
            result.ok
              ? {
                  type: "AUTHORIZATION_READY",
                  issuedAt: result.value.issuedAt,
                  expiresAt: result.value.expiresAt,
                }
              : { type: "AUTHORIZATION_FAILED", error: result.error },
          );
          break;
        }

        case "submittingOrder": {
          const current = artifacts;
          const order = current?.order;
          const risk = current?.risk;
          const price = current?.market?.candles.at(-1)?.close;
          if (
            current === null ||
            order === undefined ||
            risk?.status !== "APPROVED" ||
            price === undefined ||
            authorization === undefined
          ) {
            await send({
              type: "ORDER_OUTCOME_UNKNOWN",
              error: workflowError("execution", "ORDER_OUTCOME_UNKNOWN", true),
            });
            break;
          }
          const result = await input.effects.submitOrder(
            order,
            risk,
            authorization,
            price,
            portfolio,
            current.triggeredAt,
          );
          authorization = undefined;
          if (result.status === "CONFIRMED") {
            portfolio = result.portfolio;
            if (
              result.accountEquity !== undefined &&
              result.otherExposureNotional !== undefined &&
              result.observedAt !== undefined
            ) {
              accountEquity = result.accountEquity;
              otherExposureNotional = result.otherExposureNotional;
              const dailyRisk = resolveDailyRiskWindow(
                dailyRiskWindow,
                result.observedAt,
                result.accountEquity,
              );
              dailyRiskWindow = dailyRisk.window;
              dailyPnl = dailyRisk.dailyPnl;
            }
            const next = Object.freeze({
              ...current,
              execution: {
                exchangeOrderId: result.exchangeOrderId,
                fill: result.fill,
                ...(result.protectiveOrderId === undefined
                  ? {}
                  : { protectiveOrderId: result.protectiveOrderId }),
              },
            });
            if (
              !(await checkpoint(next, (error) => ({
                type: "ORDER_OUTCOME_UNKNOWN",
                error,
              })))
            ) {
              break;
            }
            await send({
              type: "ORDER_CONFIRMED",
              exchangeOrderId: result.exchangeOrderId,
            });
          } else if (result.status === "REJECTED") {
            await send({ type: "ORDER_REJECTED", error: result.error });
          } else if (result.status === "NO_SELL_NEEDED") {
            portfolio = result.portfolio;
            accountEquity = result.accountEquity;
            otherExposureNotional = result.otherExposureNotional;
            const dailyRisk = resolveDailyRiskWindow(
              dailyRiskWindow,
              result.observedAt,
              result.accountEquity,
            );
            dailyRiskWindow = dailyRisk.window;
            dailyPnl = dailyRisk.dailyPnl;
            await send({ type: "ORDER_NO_LONGER_NEEDED" });
          } else if (result.status === "PROTECTION_FAILED") {
            portfolio = result.portfolio;
            accountEquity = result.accountEquity;
            otherExposureNotional = result.otherExposureNotional;
            const dailyRisk = resolveDailyRiskWindow(
              dailyRiskWindow,
              result.observedAt,
              result.accountEquity,
            );
            dailyRiskWindow = dailyRisk.window;
            dailyPnl = dailyRisk.dailyPnl;
            artifacts = Object.freeze({
              ...current,
              ...(result.exchangeOrderId === null
                ? {}
                : {
                    execution: {
                      exchangeOrderId: result.exchangeOrderId,
                      fill: result.fill,
                      ...(result.protectiveOrderId === undefined
                        ? {}
                        : { protectiveOrderId: result.protectiveOrderId }),
                    },
                  }),
            });
            await send({
              type: "ORDER_PROTECTION_FAILED",
              exchangeOrderId: result.exchangeOrderId,
              error: result.error,
            });
          } else if (result.status === "TERMINAL_FAILED") {
            if (result.exchangeOrderId !== null) {
              artifacts = Object.freeze({
                ...current,
                execution: {
                  exchangeOrderId: result.exchangeOrderId,
                  fill: result.fill,
                },
              });
            }
            await send({
              type: "ORDER_PROTECTION_FAILED",
              exchangeOrderId: result.exchangeOrderId,
              error: result.error,
            });
          } else {
            await send({ type: "ORDER_OUTCOME_UNKNOWN", error: result.error });
          }
          break;
        }

        case "reconcilingOrder": {
          if (
            artifacts?.order === undefined ||
            artifacts.risk?.status !== "APPROVED"
          ) {
            await send({
              type: "RECONCILIATION_FAILED",
              error: missingArtifact("reconciliation"),
            });
            break;
          }
          const result = await input.effects.reconcileOrder(
            artifacts.order,
            artifacts.risk,
            portfolio,
          );
          if (!result.ok) {
            await send({ type: "RECONCILIATION_FAILED", error: result.error });
            break;
          }
          if (result.value.status === "CONFIRMED") {
            portfolio = result.value.portfolio;
            if (
              result.value.accountEquity !== undefined &&
              result.value.otherExposureNotional !== undefined &&
              result.value.observedAt !== undefined
            ) {
              accountEquity = result.value.accountEquity;
              otherExposureNotional = result.value.otherExposureNotional;
              const dailyRisk = resolveDailyRiskWindow(
                dailyRiskWindow,
                result.value.observedAt,
                result.value.accountEquity,
              );
              dailyRiskWindow = dailyRisk.window;
              dailyPnl = dailyRisk.dailyPnl;
            }
            const next = Object.freeze({
              ...artifacts,
              execution: {
                exchangeOrderId: result.value.exchangeOrderId,
                fill: result.value.fill,
                ...(result.value.protectiveOrderId === undefined
                  ? {}
                  : { protectiveOrderId: result.value.protectiveOrderId }),
              },
            });
            if (
              !(await checkpoint(next, (error) => ({
                type: "RECONCILIATION_FAILED",
                error,
              })))
            ) {
              break;
            }
            await send({
              type: "ORDER_RECONCILED",
              exchangeOrderId: result.value.exchangeOrderId,
            });
          } else if (result.value.status === "REJECTED") {
            await send({ type: "ORDER_RECONCILED", exchangeOrderId: null });
          } else if (result.value.status === "NO_SELL_NEEDED") {
            portfolio = result.value.portfolio;
            accountEquity = result.value.accountEquity;
            otherExposureNotional = result.value.otherExposureNotional;
            const dailyRisk = resolveDailyRiskWindow(
              dailyRiskWindow,
              result.value.observedAt,
              result.value.accountEquity,
            );
            dailyRiskWindow = dailyRisk.window;
            dailyPnl = dailyRisk.dailyPnl;
            await send({ type: "ORDER_NO_LONGER_NEEDED" });
          } else if (result.value.status === "PROTECTION_FAILED") {
            portfolio = result.value.portfolio;
            accountEquity = result.value.accountEquity;
            otherExposureNotional = result.value.otherExposureNotional;
            const dailyRisk = resolveDailyRiskWindow(
              dailyRiskWindow,
              result.value.observedAt,
              result.value.accountEquity,
            );
            dailyRiskWindow = dailyRisk.window;
            dailyPnl = dailyRisk.dailyPnl;
            artifacts = Object.freeze({
              ...artifacts,
              ...(result.value.exchangeOrderId === null
                ? {}
                : {
                    execution: {
                      exchangeOrderId: result.value.exchangeOrderId,
                      fill: result.value.fill,
                      ...(result.value.protectiveOrderId === undefined
                        ? {}
                        : { protectiveOrderId: result.value.protectiveOrderId }),
                    },
                  }),
            });
            await send({
              type: "ORDER_PROTECTION_FAILED",
              exchangeOrderId: result.value.exchangeOrderId,
              error: result.value.error,
            });
          } else if (result.value.status === "TERMINAL_FAILED") {
            if (result.value.exchangeOrderId !== null) {
              artifacts = Object.freeze({
                ...artifacts,
                execution: {
                  exchangeOrderId: result.value.exchangeOrderId,
                  fill: result.value.fill,
                },
              });
            }
            await send({
              type: "ORDER_PROTECTION_FAILED",
              exchangeOrderId: result.value.exchangeOrderId,
              error: result.value.error,
            });
          } else {
            await send({
              type: "RECONCILIATION_FAILED",
              error: result.value.error,
            });
          }
          break;
        }

        case "cancelling": {
          const result = await input.effects.cancelCurrentEffect(
            session.context.shutdownMode,
          );
          await send(
            result.ok
              ? { type: "EFFECT_CANCELLED" }
              : { type: "EFFECT_CANCEL_FAILED", error: result.error },
          );
          break;
        }

        case "persisting": {
          const result = await input.effects.persistCycle(artifacts, session.record);
          if (artifacts?.indicators !== undefined) {
            previousIndicators = artifacts.indicators;
          }
          await send(
            result.ok
              ? { type: "PERSIST_SUCCEEDED" }
              : { type: "PERSIST_FAILED", error: result.error },
          );
          break;
        }

        default:
          throw new Error(`No effect mapping for trading phase ${session.phase}`);
      }
    }
    throw new Error("Trading interpreter exceeded its bounded step budget");
  } finally {
    session.stop();
  }
};
