/**
 * Politique d'exposition cible P7 (models/target-exposure.md).
 *
 * Pure et sans horloge : la décision ne dépend que des bougies closes
 * fournies et de l'état `(cash, position)` du créneau. Elle ne choisit
 * aucune transition de machine ; l'interpréteur l'utilise comme étape
 * d'allocation pour la politique `TARGET_EXPOSURE` (paper uniquement).
 */
export const TARGET_EXPOSURE_POLICY = Object.freeze({
  volTarget: 0.5,
  trendSmaPeriod: 200,
  volPeriod: 30,
  driftThreshold: 0.1,
  minOrderNotional: 10,
});

/** Bougies requises : SMA200 à l'ancre et la veille (≤ 7 jours) + marge (§2). */
export const TARGET_EXPOSURE_MIN_CANDLES = 240;

export interface TargetExposureCandle {
  readonly start: number;
  readonly close: number;
}

export type TargetExposureReason =
  | "ANCHOR"
  | "MONTH_START"
  | "DRIFT"
  | "IN_BAND"
  | "BELOW_MIN_ORDER"
  | "INSUFFICIENT_HISTORY";

export interface TargetExposureInput {
  readonly candles: readonly TargetExposureCandle[];
  readonly positionQuantity: number;
  readonly cash: number;
  readonly feeBps: number;
  readonly slippageBps: number;
}

export interface TargetExposureDecision {
  readonly side: "BUY" | "SELL" | "HOLD";
  readonly quantity: number;
  readonly notional: number;
  readonly reason: TargetExposureReason;
  readonly target: number | null;
  readonly exposure: number | null;
  readonly trend: boolean | null;
  readonly vol30: number | null;
  readonly anchorStart: number | null;
}

export const simpleMovingAverage = (
  closes: readonly number[],
  period: number,
): number | null => {
  if (period < 1 || closes.length < period) return null;
  let sum = 0;
  for (let index = closes.length - period; index < closes.length; index += 1) {
    sum += closes[index] ?? 0;
  }
  return sum / period;
};

/** Écart-type échantillon des `period` derniers rendements simples, ×√365. */
export const annualizedRealizedVolatility = (
  closes: readonly number[],
  period: number,
): number | null => {
  if (period < 2 || closes.length < period + 1) return null;
  const returns: number[] = [];
  for (let index = closes.length - period; index < closes.length; index += 1) {
    const previous = closes[index - 1] ?? 0;
    returns.push((closes[index] ?? 0) / previous - 1);
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(365);
};

const DAY_MS = 86_400_000;
const isUtcMonday = (start: number): boolean => new Date(start).getUTCDay() === 1;
const isUtcMonthStart = (start: number): boolean => new Date(start).getUTCDate() === 1;

const hold = (
  reason: TargetExposureReason,
  fields: Partial<TargetExposureDecision> = {},
): TargetExposureDecision =>
  Object.freeze({
    side: "HOLD",
    quantity: 0,
    notional: 0,
    reason,
    target: null,
    exposure: null,
    trend: null,
    vol30: null,
    anchorStart: null,
    ...fields,
  });

export const planTargetExposure = (input: TargetExposureInput): TargetExposureDecision => {
  const policy = TARGET_EXPOSURE_POLICY;
  const candles = input.candles;
  // Série contiguë exigée (§2) : défensif, le runtime valide déjà INV-I7.
  for (let index = 1; index < candles.length; index += 1) {
    if ((candles[index]?.start ?? 0) - (candles[index - 1]?.start ?? 0) !== DAY_MS) {
      return hold("INSUFFICIENT_HISTORY");
    }
  }
  const closes = candles.map((candle) => candle.close);
  const last = candles.length - 1;
  const trendAt = (index: number): boolean | null => {
    const sma = simpleMovingAverage(closes.slice(0, index + 1), policy.trendSmaPeriod);
    return sma === null ? null : (closes[index] ?? 0) > sma;
  };

  // Ancre : bougie la plus récente qui débute un lundi ou change de tendance (§2).
  let anchor: number | null = null;
  for (let index = last; index >= 0; index -= 1) {
    const current = trendAt(index);
    const previous = index > 0 ? trendAt(index - 1) : null;
    if (current === null || previous === null) break;
    const candle = candles[index];
    if (candle === undefined) break;
    if (isUtcMonday(candle.start) || current !== previous) {
      anchor = index;
      break;
    }
  }
  const lastCandle = candles[last];
  if (anchor === null || lastCandle === undefined) return hold("INSUFFICIENT_HISTORY");
  const anchorTrend = trendAt(anchor);
  const anchorVol = annualizedRealizedVolatility(closes.slice(0, anchor + 1), policy.volPeriod);
  const currentTrend = trendAt(last);
  const currentVol = annualizedRealizedVolatility(closes, policy.volPeriod);
  if (anchorTrend === null || anchorVol === null || anchorVol <= 0) {
    return hold("INSUFFICIENT_HISTORY");
  }

  const target = anchorTrend ? Math.min(1, policy.volTarget / anchorVol) : 0;
  const price = lastCandle.close;
  const holding = Math.max(0, input.positionQuantity) * price;
  const equity = Math.max(0, input.cash) + holding;
  const exposure = equity > 0 ? holding / equity : 0;
  const fields = {
    target,
    exposure,
    trend: currentTrend,
    vol30: currentVol,
    anchorStart: candles[anchor]?.start ?? null,
  } as const;

  const reason: TargetExposureReason | null =
    anchor === last
      ? "ANCHOR"
      : isUtcMonthStart(lastCandle.start)
        ? "MONTH_START"
        : Math.abs(exposure - target) > policy.driftThreshold
          ? "DRIFT"
          : null;
  if (reason === null) return hold("IN_BAND", fields);

  const delta = target * equity - holding;
  // Coût d'achat réel de l'exécution paper : prix × (1 + slippage), puis
  // frais sur ce notionnel ⇒ facteur (1 + s)(1 + f). Marge 1e-9 relative.
  const buyCostFactor = (1 + input.slippageBps / 10_000) * (1 + input.feeBps / 10_000);
  const notional =
    delta > 0
      ? Math.min(delta, (Math.max(0, input.cash) / buyCostFactor) * (1 - 1e-9))
      : Math.min(-delta, holding);
  if (notional < policy.minOrderNotional) return hold("BELOW_MIN_ORDER", fields);
  const quantity =
    delta > 0 ? notional / price : Math.min(notional / price, Math.max(0, input.positionQuantity));
  return Object.freeze({
    side: delta > 0 ? "BUY" : "SELL",
    quantity,
    notional: quantity * price,
    reason,
    ...fields,
  });
};

/** Plafond absolu minimal exigé sous cette politique (§5.5, neutralisation). */
export const TARGET_EXPOSURE_MIN_ABSOLUTE_CAP = 1_000_000_000;

/**
 * Variation du créneau sur la bougie de décision (§4) : la position ne change
 * qu'aux clôtures, donc `q × (clôture_t − clôture_{t−1})` est exacte.
 * `null` si moins de deux bougies (la porte retombe alors sur `dailyPnl`).
 */
export const decisionCandlePnl = (
  candles: readonly TargetExposureCandle[],
  positionQuantity: number,
): number | null => {
  const last = candles.at(-1);
  const previous = candles.at(-2);
  if (last === undefined || previous === undefined) return null;
  const pnl = Math.max(0, positionQuantity) * (last.close - previous.close);
  return pnl === 0 ? 0 : pnl; // normalise -0
};

/**
 * Porte de risque (§4, INV-T7) : une réduction n'est jamais bloquée par la
 * perte journalière ni par l'admission portefeuille ; un achat est soumis à
 * la pire des deux pertes (fenêtre du runtime, bougie de décision) puis à
 * l'admission.
 */
export const targetExposureRiskGate = (
  side: "BUY" | "SELL",
  dailyPnl: number,
  candlePnl: number | null,
): { readonly dailyPnlForRisk: number; readonly portfolioAdmission: boolean } =>
  Object.freeze({
    dailyPnlForRisk: side === "SELL" ? 0 : Math.min(dailyPnl, candlePnl ?? dailyPnl),
    portfolioAdmission: side === "BUY",
  });
