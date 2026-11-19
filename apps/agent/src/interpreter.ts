import { allocateSignals, type AllocationDecision } from "@dodash/allocator";
import {
  computeIndicators,
  FUNDING_AVG_PERIOD,
} from "@dodash/indicators-prolog";
import { checkRisk } from "@dodash/risk";
import { FUNDING_TREND_STRATEGY_ID } from "@dodash/strategies";
import {
  planMarketRetry,
  planCycleWake,
  decisionCandlePnl,
  planTargetExposure,
  resolveDailyRiskWindow,
  targetExposureRiskGate,
  type TradingCycleEvent,
  type WorkflowError,
  type WorkflowErrorCode,
  type WorkflowPhase,
} from "@dodash/models";
import {
  createClientOrderId,
  createOrderIntent,
  createSignal,
  err,
  ok,
  type Candle,
  type Result,
  type Signal,
  type Timeframe,
} from "@dodash/domain";

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

/**
 * Couture funding (models/funding-rate-strategy.md §3) : double porte
 * (mode perp ∧ funding-trend configuré ∧ effet câblé) puis
 * pré-validation fail-closed — toute forme hors contrat est traitée
 * comme une indisponibilité (null), jamais un échec de cycle pour un
 * input optionnel (C3). Une indisponibilité attendue est télémétrée.
 */
const resolveFundingInput = async (
  input: RunTradingCycleInput,
  candles: readonly Candle[],
): Promise<{ readonly rates: readonly number[]; readonly avgPeriod: number } | undefined> => {
  const { configuration, effects } = input;
  if (
    configuration.executionMode !== "perp" ||
    !configuration.strategyIds.includes(FUNDING_TREND_STRATEGY_ID) ||
    effects.fetchFundingData === undefined
  ) {
    return undefined;
  }
  const rates = await effects.fetchFundingData(configuration, candles);
  const valid =
    rates !== null &&
    rates.length >= 1 &&
    rates.length <= candles.length &&
    rates.every((rate) => Number.isFinite(rate));
  if (!valid) {
    console.warn(JSON.stringify({ event: "funding_data_unavailable" }));
    return undefined;
  }
  return { rates, avgPeriod: FUNDING_AVG_PERIOD };
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
  const wake = planCycleWake(input.machine.value, input.triggerAlarm);
  let dailyRiskWindow = input.dailyRiskWindow ?? null;
  let dailyPnl = input.dailyPnl;
  let accountEquity: number | null = null;
  let otherExposureNotional = 0;

  // models/daily-risk.md §3 : en paper, la fenêtre journalière est résolue par
  // le runtime sur le mark daté ; les réconciliations paper (équité au coût)
  // ne la ré-ancrent jamais. Live et perp gardent leur ancrage réel.
  const anchorReconciledDailyRisk = (observedAt: number, equity: number): void => {
    if (input.configuration.executionMode === "paper") return;
    const dailyRisk = resolveDailyRiskWindow(dailyRiskWindow, observedAt, equity);
    dailyRiskWindow = dailyRisk.window;
    dailyPnl = dailyRisk.dailyPnl;
  };

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
          if (!wake.triggerAlarm || alarmTriggered) {
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

        case "retryingMarketData": {
          // models/market-retry-schedule.md §3 : aucun refetch immédiat. Le
          // planificateur pur fixe l'échéance ; elle est persistée avant
          // l'alarme ; RETRY_TIMER_ELAPSED n'est émis qu'à échéance atteinte.
          const now = (input.now ?? Date.now)();
          const context = session.context;
          const checkpointed = artifacts?.marketRetry;
          if (
            checkpointed === undefined ||
            checkpointed.attempt !== context.attempts.marketData
          ) {
            // `attempts.marketData` est déjà incrémenté par la machine :
            // le retry planifié porte l'index 0-based `attempts − 1`.
            const plan = planMarketRetry({
              attempt: Math.max(0, context.attempts.marketData - 1),
              retryLimit: context.retryLimits.marketData,
              retryable: context.lastError?.retryable ?? true,
              retryAfterMs: context.lastError?.retryAfterMs ?? null,
              now,
              triggeredAt: artifacts?.triggeredAt ?? input.triggeredAt,
              timeframeMs: timeframeMilliseconds[input.configuration.timeframe],
              maxMarketStalenessMs: input.configuration.maxMarketStalenessMs,
            });
            if (plan.kind === "exhausted") {
              await send({ type: "RETRY_TIMER_ELAPSED" });
              break;
            }
            const current = artifacts ?? {
              cycleId: input.cycleId,
              triggeredAt: input.triggeredAt,
            };
            const next = Object.freeze({
              ...current,
              marketRetry: {
                // `attempt` = tentatives déjà consommées, pour rejouer
                // l'identité `checkpointed.attempt === attempts.marketData`.
                attempt: context.attempts.marketData,
                nextRetryAt: plan.nextRetryAt,
                deadlineAt: plan.deadlineAt,
                errorCode: context.lastError?.code ?? null,
              },
            });
            // Persistance avant programmation (§3). Un échec de checkpoint
            // laisse le cycle en attente : le prochain réveil rejouera la
            // planification ; aucun événement n'est envoyé à la machine.
            const persisted = await input.effects.checkpoint(next);
            if (!persisted.ok) return currentResult();
            artifacts = next;
            await input.effects.scheduleRetry?.(plan.nextRetryAt, plan.attempt);
            return currentResult();
          }
          if (now < checkpointed.nextRetryAt) return currentResult();
          await send({ type: "RETRY_TIMER_ELAPSED" });
          break;
        }

        case "retryingSchedule":
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
          anchorReconciledDailyRisk(result.value.observedAt, result.value.accountEquity);
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
            evaluatedAt: (input.now ?? Date.now)(),
          });
          break;
        }

        case "computingIndicators": {
          if (artifacts?.market === undefined) {
            await send({ type: "INDICATORS_FAILED", error: missingArtifact("indicators") });
            break;
          }
          const fundingInput = await resolveFundingInput(
            input,
            artifacts.market.candles,
          );
          const result = await computeIndicators(
            artifacts.market.candles,
            input.configuration.indicators,
            undefined,
            fundingInput,
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
            positionSide:
              portfolio.positionQuantity > 0
                ? "LONG"
                : portfolio.positionQuantity < 0
                  ? "SHORT"
                  : "FLAT",
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
          const signals = artifacts.signals;
          const decisionId = `decision:${artifacts.cycleId}`;
          // Politique P7 (models/target-exposure.md §4) : l'ordre vient de la
          // décision d'exposition cible, pas de l'allocateur — qui plafonne
          // aussi les ventes par le cash et bloquerait toute réduction.
          const policy = input.configuration.sizingPolicy;
          const result =
            policy.type === "TARGET_EXPOSURE"
              ? targetExposureAllocation({
                  agentId: input.agentId,
                  cycleId: artifacts.cycleId,
                  decisionId,
                  productId: input.configuration.productId,
                  candles: artifacts.market?.candles ?? [],
                  positionQuantity: portfolio.positionQuantity,
                  cash: portfolio.cash,
                  feeBps: input.configuration.broker.feeBps,
                  slippageBps: input.configuration.broker.slippageBps,
                  ...(policy.costAwareRebalance === undefined
                    ? {}
                    : { costAwareRebalance: policy.costAwareRebalance }),
                  ...(policy.costMultiple === undefined
                    ? {}
                    : { costMultiple: policy.costMultiple }),
                  ...(policy.minCostEdgeMultiple === undefined
                    ? {}
                    : { minCostEdgeMultiple: policy.minCostEdgeMultiple }),
                })
              : await (async () => {
                  const needsBook =
                    input.configuration.executionStyle === "LIMIT_PASSIVE" ||
                    input.configuration.maxSpreadBps !== undefined;
                  const fetchedBook =
                    needsBook && input.effects.fetchOrderBook !== undefined
                      ? await input.effects.fetchOrderBook(input.configuration)
                      : null;
                  const book =
                    fetchedBook !== null
                      ? fetchedBook
                      : input.configuration.executionMode === "paper" &&
                          input.configuration.executionStyle === "LIMIT_PASSIVE"
                        ? Object.freeze({
                            bestBid: last.close,
                            bestAsk: last.close,
                            spreadBps: 0,
                          })
                        : null;
                  const positionAware =
                    input.configuration.strategyOptions?.positionAware === true;
                  let effectiveSignals: readonly Signal[] = signals;
                  if (
                    input.configuration.executionMode === "paper" &&
                    positionAware &&
                    portfolio.positionQuantity > 0 &&
                    portfolio.averagePrice > 0
                  ) {
                    const riskCfg = input.configuration.risk;
                    const atrVal = artifacts.indicators?.atr;
                    const useAtr =
                      atrVal !== undefined &&
                      Number.isFinite(atrVal) &&
                      atrVal > 0 &&
                      riskCfg.atrStopLossMultiple !== undefined &&
                      riskCfg.atrTakeProfitMultiple !== undefined;
                    const bpsStopDistance =
                      portfolio.averagePrice * (riskCfg.stopLossBps / 10_000);
                    const bpsTakeDistance =
                      portfolio.averagePrice * (riskCfg.takeProfitBps / 10_000);
                    const stopDistance = useAtr
                      ? Math.max(
                          atrVal * (riskCfg.atrStopLossMultiple ?? 2),
                          bpsStopDistance,
                        )
                      : bpsStopDistance;
                    const takeDistance = useAtr
                      ? Math.max(
                          atrVal * (riskCfg.atrTakeProfitMultiple ?? 3),
                          bpsTakeDistance,
                        )
                      : bpsTakeDistance;
                    const baseStopLossPrice =
                      portfolio.averagePrice - stopDistance;
                    const takeProfitPrice =
                      portfolio.averagePrice + takeDistance;
                    // Axe 2 : Plus haut observé depuis l'entrée (lastTradeAt) pour
                    // Breakeven Stop (+22 bps -> +5 bps) et Trailing Stop (+35 bps).
                    const candlesSinceEntry =
                      input.lastTradeAt !== null
                        ? (artifacts.market?.candles ?? []).filter(
                            (c) => c.start >= input.lastTradeAt!,
                          )
                        : [];
                    const highWaterMark = Math.max(
                      portfolio.averagePrice,
                      last.close,
                      ...candlesSinceEntry.map((c) => c.high),
                    );
                    const peakGainBps =
                      ((highWaterMark - portfolio.averagePrice) /
                        portfolio.averagePrice) *
                      10_000;
                    const dynamicFloorStop =
                      peakGainBps >= 35
                        ? Math.max(
                            portfolio.averagePrice * 1.001,
                            highWaterMark -
                              Math.max(
                                useAtr ? atrVal * 1.0 : 0,
                                highWaterMark * 0.0018,
                              ),
                          )
                        : peakGainBps >= 22
                          ? portfolio.averagePrice * 1.0005
                          : baseStopLossPrice;
                    const stopLossPrice = Math.max(
                      baseStopLossPrice,
                      dynamicFloorStop,
                    );
                    if (
                      last.close <= stopLossPrice ||
                      last.close >= takeProfitPrice
                    ) {
                      const exitSignal = createSignal({
                        strategyId:
                          input.configuration.strategyIds[0] ?? "rsi-reversion",
                        productId: input.configuration.productId,
                        side: "SELL",
                        confidence: 1,
                        suggestedSize: portfolio.positionQuantity,
                        reasonCode:
                          last.close >= takeProfitPrice
                            ? "PAPER_TAKE_PROFIT"
                            : stopLossPrice > portfolio.averagePrice
                              ? "PAPER_TRAILING_STOP"
                              : "PAPER_STOP_LOSS",
                      });
                      if (exitSignal.ok) {
                        effectiveSignals = Object.freeze([exitSignal.value]);
                      }
                    } else if (
                      artifacts.indicators !== undefined &&
                      artifacts.indicators.rsi < 65 &&
                      last.close <= portfolio.averagePrice * 1.0025
                    ) {
                      // À l'intérieur du corridor [stopLossPrice, takeProfitPrice],
                      // tant que le rebond n'a pas atteint RSI >= 65 et que la
                      // position n'est pas en gain significatif (> +25 bps), ignorer
                      // les signaux SELL prématurés pour laisser les gagnants atteindre
                      // le Breakeven (+22 bps), le Trailing Stop (+35 bps) ou le TP.
                      effectiveSignals = Object.freeze(
                        signals.filter((signal) => signal.side !== "SELL"),
                      );
                    }
                  } else if (
                    input.configuration.executionMode === "paper" &&
                    positionAware &&
                    portfolio.positionQuantity === 0 &&
                    artifacts.indicators !== undefined
                  ) {
                    const nowMs = (input.now ?? Date.now)();
                    const postCloseCooldownMs = Math.max(
                      input.configuration.risk.cooldownMs,
                      300_000,
                    );
                    if (
                      input.lastTradeAt !== null &&
                      nowMs - input.lastTradeAt < postCloseCooldownMs
                    ) {
                      // Anti-revenge-buying : bloquer tout nouveau BUY pendant au
                      // moins 5 minutes après la clôture précédente.
                      effectiveSignals = Object.freeze(
                        signals.filter((sig) => sig.side !== "BUY"),
                      );
                    } else {
                      // Axe 1 (calibré 1m) : Filtre de régime directionnel (+DI / -DI / ADX)
                      // et sizing défensif sous EMA (BEARISH / BULLISH / COUNTER-TREND).
                      const ind = artifacts.indicators;
                      const isBearishRegime =
                        ind.minusDi !== undefined &&
                        ind.plusDi !== undefined &&
                        ind.minusDi > ind.plusDi * 1.2 &&
                        ind.trendStrength >= 15 &&
                        ind.emaFast < ind.emaSlow;
                      const isBullishRegime =
                        ind.plusDi !== undefined &&
                        ind.minusDi !== undefined &&
                        ind.plusDi > ind.minusDi * 1.25 &&
                        ind.trendStrength >= 20 &&
                        ind.emaFast >= ind.emaSlow;
                      const isCounterTrendEma = ind.emaFast < ind.emaSlow;
                      if (isBearishRegime) {
                        const adjusted: Signal[] = [];
                        for (const sig of signals) {
                          if (sig.side !== "BUY") {
                            adjusted.push(sig);
                            continue;
                          }
                          if (sig.strategyId === "rsi-reversion" && ind.rsi <= 22) {
                            const scaled = createSignal({
                              strategyId: sig.strategyId,
                              productId: sig.productId,
                              side: "BUY",
                              confidence: sig.confidence,
                              suggestedSize: sig.suggestedSize * 0.4,
                              reasonCode: sig.reasonCode,
                            });
                            if (scaled.ok) adjusted.push(scaled.value);
                          }
                        }
                        effectiveSignals = Object.freeze(adjusted);
                      } else if (isBullishRegime) {
                        const adjusted: Signal[] = [];
                        for (const sig of signals) {
                          if (sig.side !== "BUY") {
                            adjusted.push(sig);
                            continue;
                          }
                          const scaled = createSignal({
                            strategyId: sig.strategyId,
                            productId: sig.productId,
                            side: "BUY",
                            confidence: sig.confidence,
                            suggestedSize: sig.suggestedSize * 1.15,
                            reasonCode: sig.reasonCode,
                          });
                          if (scaled.ok) adjusted.push(scaled.value);
                        }
                        effectiveSignals = Object.freeze(adjusted);
                      } else if (isCounterTrendEma) {
                        const adjusted: Signal[] = [];
                        for (const sig of signals) {
                          if (sig.side !== "BUY") {
                            adjusted.push(sig);
                            continue;
                          }
                          const scaled = createSignal({
                            strategyId: sig.strategyId,
                            productId: sig.productId,
                            side: "BUY",
                            confidence: sig.confidence,
                            suggestedSize: sig.suggestedSize * 0.4,
                            reasonCode: sig.reasonCode,
                          });
                          if (scaled.ok) adjusted.push(scaled.value);
                        }
                        effectiveSignals = Object.freeze(adjusted);
                      }
                    }
                  }
                  return allocateSignals({
                    agentId: input.agentId,
                    cycleId: artifacts.cycleId,
                    decisionId,
                    signals: effectiveSignals,
                    marketPrices: { [input.configuration.productId]: last.close },
                    capitalAvailable: Math.max(0, portfolio.cash),
                    maxDecisionNotional: input.configuration.maxDecisionNotional,
                    minNetQuantity: input.configuration.minNetQuantity,
                    ...(input.configuration.executionStyle === undefined
                      ? {}
                      : { executionStyle: input.configuration.executionStyle }),
                    ...(input.configuration.maxSpreadBps === undefined
                      ? {}
                      : { maxSpreadBps: input.configuration.maxSpreadBps }),
                    ...(book === null
                      ? {}
                      : { orderBooks: { [input.configuration.productId]: book } }),
                    ...(positionAware
                      ? {
                          positionQuantities: {
                            [input.configuration.productId]: Math.max(
                              0,
                              portfolio.positionQuantity,
                            ),
                          },
                          closeFullPositionOnSell: true,
                        }
                      : {}),
                  });
                })();
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
          // Porte de risque P7 (models/target-exposure.md §4, INV-T7) : une
          // réduction n'est bloquée ni par la perte journalière ni par
          // l'admission portefeuille ; un achat est soumis à la pire perte
          // entre la fenêtre du runtime (non encore valorisée sur la bougie
          // de décision en paper) et la variation du créneau sur cette bougie.
          const targetExposureGate =
            input.configuration.sizingPolicy.type === "TARGET_EXPOSURE"
              ? targetExposureRiskGate(
                  order.side,
                  dailyPnl,
                  decisionCandlePnl(current.market?.candles ?? [], portfolio.positionQuantity),
                )
              : null;
          const atr = current.indicators?.atr;
          const result = checkRisk(
            order,
            {
              marketPrice: price,
              currentPositionQuantity: portfolio.positionQuantity,
              otherExposureNotional,
              dailyPnl: targetExposureGate?.dailyPnlForRisk ?? dailyPnl,
              lastTradeAt: input.lastTradeAt,
              now: current.triggeredAt,
              killSwitchActive: session.context.shutdownMode === "kill-switch",
              ...(atr !== undefined && Number.isFinite(atr) && atr > 0 ? { atr } : {}),
            },
            input.configuration.risk,
          );
          if (!result.ok) {
            await send({ type: "RISK_FAILED", error: workflowError("risk", "RISK_FAILURE") });
            break;
          }
          // Couture portefeuille (models/multi-product-portfolio.md §9.3) :
          // après un checkRisk local approuvé, l'interpréteur du produit
          // propose l'exposition projetée à l'orchestrateur du §5 et ne
          // poursuit (RISK_APPROVED) que sur décision `approved` (INV-P5).
          // Sans couture câblée (mono-produit), comportement strictement
          // identique (C2). Un refus consolidé ne checkpointe jamais un
          // risque approuvé (C3) et se consolide en RISK_REJECTED produit.
          if (
            result.value.status === "APPROVED" &&
            input.effects.proposePortfolioRisk !== undefined &&
            targetExposureGate?.portfolioAdmission !== false
          ) {
            const admission = await input.effects.proposePortfolioRisk(
              input.configuration.productId,
              result.value.projectedPositionNotional,
            );
            if (!admission.approved) {
              await send({ type: "RISK_REJECTED" });
              break;
            }
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
              anchorReconciledDailyRisk(result.observedAt, result.accountEquity);
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
            anchorReconciledDailyRisk(result.observedAt, result.accountEquity);
            await send({ type: "ORDER_NO_LONGER_NEEDED" });
          } else if (result.status === "PROTECTION_FAILED") {
            portfolio = result.portfolio;
            accountEquity = result.accountEquity;
            otherExposureNotional = result.otherExposureNotional;
            anchorReconciledDailyRisk(result.observedAt, result.accountEquity);
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
              anchorReconciledDailyRisk(result.value.observedAt, result.value.accountEquity);
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
            anchorReconciledDailyRisk(result.value.observedAt, result.value.accountEquity);
            await send({ type: "ORDER_NO_LONGER_NEEDED" });
          } else if (result.value.status === "PROTECTION_FAILED") {
            portfolio = result.value.portfolio;
            accountEquity = result.value.accountEquity;
            otherExposureNotional = result.value.otherExposureNotional;
            anchorReconciledDailyRisk(result.value.observedAt, result.value.accountEquity);
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

/**
 * Étape d'allocation de la politique P7 (models/target-exposure.md §3–§4) :
 * décision pure `planTargetExposure` traduite en au plus une intention
 * MARKET, avec le schéma d'identifiant de l'allocateur.
 */
const targetExposureAllocation = (input: {
  readonly agentId: string;
  readonly cycleId: string;
  readonly decisionId: string;
  readonly productId: Parameters<typeof createOrderIntent>[0]["productId"];
  readonly candles: readonly Candle[];
  readonly positionQuantity: number;
  readonly cash: number;
  readonly feeBps: number;
  readonly slippageBps: number;
  readonly costAwareRebalance?: boolean;
  readonly costMultiple?: number;
  readonly minCostEdgeMultiple?: number;
}): Result<AllocationDecision, unknown> => {
  const decision = planTargetExposure({
    candles: input.candles,
    positionQuantity: input.positionQuantity,
    cash: input.cash,
    feeBps: input.feeBps,
    slippageBps: input.slippageBps,
    ...(input.costAwareRebalance === undefined
      ? {}
      : { costAwareRebalance: input.costAwareRebalance }),
    ...(input.costMultiple === undefined ? {} : { costMultiple: input.costMultiple }),
    ...(input.minCostEdgeMultiple === undefined
      ? {}
      : { minCostEdgeMultiple: input.minCostEdgeMultiple }),
  });
  const net = decision.side === "BUY" ? decision.quantity : decision.side === "SELL" ? -decision.quantity : 0;
  if (decision.side === "HOLD") {
    return ok(
      Object.freeze({
        decisionId: input.decisionId,
        outcome: "NO_ACTION" as const,
        orders: Object.freeze([]),
        netQuantities: Object.freeze({ [input.productId]: net }),
      }),
    );
  }
  const clientOrderId = createClientOrderId(input.agentId, input.cycleId, input.decisionId, 0);
  if (!clientOrderId.ok) return err(clientOrderId.error);
  const intent = createOrderIntent({
    clientOrderId: clientOrderId.value,
    decisionId: input.decisionId,
    strategyIds: ["target-exposure"],
    productId: input.productId,
    side: decision.side,
    type: "MARKET",
    quantity: decision.quantity,
    limitPrice: null,
  });
  if (!intent.ok) return err(intent.error);
  return ok(
    Object.freeze({
      decisionId: input.decisionId,
      outcome: "ALLOCATED" as const,
      orders: Object.freeze([intent.value]),
      netQuantities: Object.freeze({ [input.productId]: net }),
    }),
  );
};
