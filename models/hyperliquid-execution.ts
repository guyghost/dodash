import type {
  HyperliquidPerpAdmission,
  HyperliquidPerpCandidate,
  HyperliquidPerpProduct,
  PerpOrderAssessment,
  PerpOrderIntent,
  PerpRefusalCode,
} from "./hyperliquid-execution.types.js";

/**
 * Enveloppe de risque perp Hyperliquid, figée par l'opérateur le 28 août
 * 2026 en confirmation de la proposition du modèle. Venue routée par
 * l'app Base. Source de vérité : models/hyperliquid-execution.md.
 * Toute activation live exige en outre : préflight vérifiant les
 * incréments de taille et les tailles minimales réelles du marché,
 * flag live dédié côté shell, et éligibilité géographique de l'opérateur.
 */
export const HYPERLIQUID_PERP_POLICY = Object.freeze({
  id: "HYPERLIQUID_PERP_2026_08",
  venue: "HYPERLIQUID",
  products: Object.freeze(["BTC-PERP", "ETH-PERP"] as const),
  maxLeverage: 2,
  timeframe: "ONE_DAY",
  // Incréments de taille (szDecimals) à re-vérifier lors du préflight live.
  sizeDecimals: Object.freeze({
    "BTC-PERP": 5,
    "ETH-PERP": 4,
  } satisfies Readonly<Record<HyperliquidPerpProduct, number>>),
  risk: Object.freeze({
    maxOrderNotional: 600,
    maxPositionNotional: 10_000,
    maxGrossExposure: 10_000,
    maxDailyLoss: 1_000,
  }),
});

const isAllowedProduct = (
  productId: string,
): productId is HyperliquidPerpProduct =>
  (HYPERLIQUID_PERP_POLICY.products as readonly string[]).includes(productId);

const TOLERANCE = 1e-9;

const sameNumber = (left: number, right: number): boolean =>
  Math.abs(left - right) <= TOLERANCE;

const matchesRisk = (candidate: HyperliquidPerpCandidate): boolean => {
  const expected = HYPERLIQUID_PERP_POLICY.risk;
  const actual = candidate.risk;
  return (
    sameNumber(actual.maxOrderNotional, expected.maxOrderNotional) &&
    sameNumber(actual.maxPositionNotional, expected.maxPositionNotional) &&
    sameNumber(actual.maxGrossExposure, expected.maxGrossExposure) &&
    sameNumber(actual.maxDailyLoss, expected.maxDailyLoss)
  );
};

/**
 * Admission fermée placée avant tout événement d'ordre : seule la
 * configuration exacte de l'enveloppe figée est approuvée. Le mode paper
 * reste hors de cette politique (exécution simulée existante).
 */
export const admitHyperliquidPerpConfiguration = (
  candidate: HyperliquidPerpCandidate,
): HyperliquidPerpAdmission => {
  if (candidate.executionMode !== "live") {
    return { status: "OUT_OF_SCOPE" };
  }
  if (!isAllowedProduct(candidate.productId)) {
    return { status: "REJECTED", reasonCode: "PERP_PRODUCT_NOT_ALLOWED" };
  }
  const matches =
    candidate.venue === HYPERLIQUID_PERP_POLICY.venue &&
    candidate.timeframe === HYPERLIQUID_PERP_POLICY.timeframe &&
    candidate.maxLeverage === HYPERLIQUID_PERP_POLICY.maxLeverage &&
    matchesRisk(candidate);
  return matches
    ? { status: "APPROVED" }
    : { status: "REJECTED", reasonCode: "PERP_POLICY_MISMATCH" };
};

const invalidIntent = (intent: PerpOrderIntent): boolean =>
  !isAllowedProduct(intent.productId) ||
  (intent.side !== "BUY" && intent.side !== "SELL") ||
  !Number.isFinite(intent.quantity) ||
  intent.quantity <= 0 ||
  !Number.isFinite(intent.markPrice) ||
  intent.markPrice <= 0 ||
  !Number.isSafeInteger(intent.leverage) ||
  intent.leverage < 1;

/**
 * Forme seule d'une intention (marché allowlist, side, quantité, prix,
 * levier) : utilisée par la reprise après crash, qui ne réévalue ni
 * admission ni garde de risque — elle ne fait que réconcilier.
 */
export const isWellFormedPerpIntent = (intent: PerpOrderIntent): boolean =>
  !invalidIntent(intent);

/**
 * Garde de risque pure, évaluée avant tout effet : coupe-circuit journalier,
 * levier, notionnels d'ordre, de position et d'exposition brute. Aucune
 * taille n'est jamais arrondie vers le haut : le shell arrondit vers zéro
 * via floorToSizeIncrement avant d'émettre l'intention.
 */
export const assessPerpOrderIntent = (
  intent: PerpOrderIntent,
  gate: {
    readonly admissionApproved: boolean;
    readonly positionQuantity: number;
    readonly dailyPnl: number;
    readonly otherGrossExposureNotional: number;
  },
): PerpOrderAssessment => {
  if (invalidIntent(intent) || !Number.isFinite(gate.dailyPnl)) {
    return Object.freeze({
      status: "REFUSED" as const,
      reasonCode: "PERP_INTENT_INVALID" as const,
    });
  }
  if (!gate.admissionApproved) {
    return Object.freeze({
      status: "REFUSED" as const,
      reasonCode: "PERP_ADMISSION_REQUIRED" as const,
    });
  }
  const refusal: PerpRefusalCode | null = (() => {
    if (
      gate.dailyPnl <=
      -HYPERLIQUID_PERP_POLICY.risk.maxDailyLoss + TOLERANCE
    ) {
      return "PERP_DAILY_LOSS_BREACHED";
    }
    if (intent.leverage > HYPERLIQUID_PERP_POLICY.maxLeverage) {
      return "PERP_LEVERAGE_EXCEEDED";
    }
    const notional = intent.quantity * intent.markPrice;
    if (notional > HYPERLIQUID_PERP_POLICY.risk.maxOrderNotional + TOLERANCE) {
      return "PERP_ORDER_NOTIONAL_EXCEEDED";
    }
    if (!Number.isFinite(gate.positionQuantity)) {
      return "PERP_INTENT_INVALID";
    }
    const signedQuantity =
      intent.side === "BUY" ? intent.quantity : -intent.quantity;
    const resultingPosition = gate.positionQuantity + signedQuantity;
    const positionNotional = Math.abs(resultingPosition) * intent.markPrice;
    if (
      positionNotional >
      HYPERLIQUID_PERP_POLICY.risk.maxPositionNotional + TOLERANCE
    ) {
      return "PERP_POSITION_EXCEEDED";
    }
    const currentOwnExposure = Math.abs(gate.positionQuantity) * intent.markPrice;
    const grossExposure =
      gate.otherGrossExposureNotional - currentOwnExposure + positionNotional;
    if (
      grossExposure >
      HYPERLIQUID_PERP_POLICY.risk.maxGrossExposure + TOLERANCE
    ) {
      return "PERP_EXPOSURE_EXCEEDED";
    }
    return null;
  })();
  return refusal === null
    ? Object.freeze({ status: "EXECUTABLE" as const })
    : Object.freeze({
        status: "REFUSED" as const,
        reasonCode: refusal,
      });
};

/**
 * Arrondit une quantité vers zéro à l'incrément de taille du marché
 * (szDecimals Hyperliquid). Jamais vers le haut : un résultat inférieur à
 * un incrément vaut zéro et l'ordre doit être abandonné en amont.
 */
export const floorToSizeIncrement = (
  productId: HyperliquidPerpProduct,
  quantity: number,
): number => {
  const decimals = HYPERLIQUID_PERP_POLICY.sizeDecimals[productId];
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  const factor = 10 ** decimals;
  return Math.floor(quantity * factor + TOLERANCE) / factor;
};
