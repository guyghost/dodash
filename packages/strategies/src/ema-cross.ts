import { createSignal } from "@dodash/domain";

import {
  strategySignal,
  type Strategy,
  type StrategyContext,
} from "./strategy.js";

export interface EmaCrossConfig {
  readonly id?: string;
  readonly baseSize: number;
}

// INV-E3 (models/ema-signal-decoupling.md) : la paire de signal est lue
// exclusivement si elle est active sur le snapshot courant ET le précédent ;
// sinon la paire historique emaFast/emaSlow (comportement V1). Aucun mélange
// des deux paires dans une décision. INV-E6 : warm-up (previous null ou
// paire absente) ⇒ HOLD.
const emaPair = (
  snapshot: { readonly signalEmaFast?: number; readonly signalEmaSlow?: number },
): { readonly fast: number; readonly slow: number; readonly active: boolean } => {
  const fast = snapshot.signalEmaFast ?? 0;
  const slow = snapshot.signalEmaSlow ?? 0;
  return fast > 0 && slow > 0
    ? { fast, slow, active: true }
    : { fast: 0, slow: 0, active: false };
};

export const createEmaCrossStrategy = (config: EmaCrossConfig): Strategy => {
  const id = config.id ?? "ema-cross";
  return Object.freeze({
    id,
    evaluate: (context: StrategyContext) => {
      if (!Number.isFinite(config.baseSize) || config.baseSize <= 0) {
        return {
          ok: false as const,
          error: { code: "INVALID_STRATEGY_CONFIG" as const, strategyId: id },
        };
      }

      const currentPair = emaPair(context.indicators);
      const previous = context.previousIndicators;
      const previousPair = previous === null ? null : emaPair(previous);
      // Décision sur la paire de signal si elle est active des deux côtés,
      // sinon sur la paire historique des deux côtés — jamais mixte.
      const useSignal = currentPair.active && previousPair?.active === true;
      const currentFast = useSignal ? currentPair.fast : context.indicators.emaFast;
      const currentSlow = useSignal ? currentPair.slow : context.indicators.emaSlow;
      const previousFast =
        useSignal && previousPair !== null ? previousPair.fast : previous?.emaFast ?? 0;
      const previousSlow =
        useSignal && previousPair !== null ? previousPair.slow : previous?.emaSlow ?? 0;

      const hasPrevious = previous !== null;
      const crossedUp =
        hasPrevious && previousFast <= previousSlow && currentFast > currentSlow;
      const crossedDown =
        hasPrevious && previousFast >= previousSlow && currentFast < currentSlow;
      const side = crossedUp ? "BUY" : crossedDown ? "SELL" : "HOLD";
      const denominator = Math.max(Math.abs(currentSlow), Number.EPSILON);
      const confidence = Math.min(1, Math.abs(currentFast - currentSlow) / denominator);

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
              ? "EMA_CROSS_UP"
              : side === "SELL"
                ? "EMA_CROSS_DOWN"
                : previous === null
                  ? "EMA_WARMUP"
                  : "EMA_NO_CROSS",
        }),
      );
    },
  });
};
