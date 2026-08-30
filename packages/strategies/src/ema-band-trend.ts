import { createSignal } from "@dodash/domain";

import {
  strategySignal,
  type Strategy,
  type StrategyContext,
} from "./strategy.js";

export interface EmaBandTrendConfig {
  readonly id?: string;
  readonly baseSize: number;
}

// INV-T4 (models/ema-band-trend.md) : la bande est la constante même du
// gate V1 (EMA_THRESHOLD thresholdBps 100) — zéro paramètre libre, tout
// autre seuil serait un balayage déguisé (hors périmètre §11 du modèle).
// Miroir de classifyRegimeObservation (models/regime-filter.ts) : au seuil
// exactement = pas d'événement (au-seuil = RANGE côté gate), inégalités
// strictes sans epsilon, et comparaisons sous la forme multiplicative du
// gate (emaFast vs emaSlow × (1 ± bps/10⁴)) pour une fidélité flottante
// bit-à-bit avec la classification brute que le gate consomme.
const BAND_BPS = 100;

const upperBand = (emaSlow: number): number => emaSlow * (1 + BAND_BPS / 10_000);
const lowerBand = (emaSlow: number): number => emaSlow * (2 - (1 + BAND_BPS / 10_000));

// INV-T2 : EMAs non finies ou non positives ⇒ warm-up fail-closed.
const validPair = (fast: number, slow: number): boolean =>
  Number.isFinite(fast) && fast > 0 && Number.isFinite(slow) && slow > 0;

// Confiance consignée §3 du modèle : min(1, |spread bps| / bande). À
// l'émission, le franchissement strict garantit |spread| > bande ⇒ 1.
const spreadBps = (fast: number, slow: number): number =>
  ((fast - slow) / slow) * 10_000;

export const createEmaBandTrendStrategy = (
  config: EmaBandTrendConfig,
): Strategy => {
  const id = config.id ?? "ema-band-trend";
  return Object.freeze({
    id,
    evaluate: (context: StrategyContext) => {
      // INV-T3 : validation fail-closed, jamais corrigée silencieusement.
      if (!Number.isFinite(config.baseSize) || config.baseSize <= 0) {
        return {
          ok: false as const,
          error: { code: "INVALID_STRATEGY_CONFIG" as const, strategyId: id },
        };
      }

      const indicators = context.indicators;
      const previous = context.previousIndicators;
      // INV-T1 : lecture exclusive des snapshots — jamais context.candles,
      // aucun recalcul d'EMA, aucun effet.
      if (
        !validPair(indicators.emaFast, indicators.emaSlow) ||
        previous === null ||
        !validPair(previous.emaFast, previous.emaSlow)
      ) {
        return strategySignal(
          id,
          createSignal({
            strategyId: id,
            productId: context.productId,
            side: "HOLD",
            confidence: 0,
            suggestedSize: 0,
            reasonCode: "EMA_BAND_WARMUP",
          }),
        );
      }

      // INV-T4 : émission uniquement à la bougie de franchissement
      // strict ; zéro émission répétée à l'intérieur d'une bande.
      const bullEntry =
        previous.emaFast <= upperBand(previous.emaSlow) &&
        indicators.emaFast > upperBand(indicators.emaSlow);
      const bearEntry =
        previous.emaFast >= lowerBand(previous.emaSlow) &&
        indicators.emaFast < lowerBand(indicators.emaSlow);
      const side = bullEntry ? "BUY" : bearEntry ? "SELL" : "HOLD";
      const confidence = Math.min(
        1,
        Math.abs(spreadBps(indicators.emaFast, indicators.emaSlow)) / BAND_BPS,
      );

      return strategySignal(
        id,
        createSignal({
          strategyId: id,
          productId: context.productId,
          side,
          confidence,
          suggestedSize: side === "HOLD" ? 0 : config.baseSize,
          reasonCode:
            side === "BUY"
              ? "EMA_BAND_BULL_ENTRY"
              : side === "SELL"
                ? "EMA_BAND_BEAR_EXIT"
                : "EMA_BAND_NO_EVENT",
        }),
      );
    },
  });
};
