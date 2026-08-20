export const LIVE_TRADING_POLICY_ID = "CONFIDENCE_POWER_THIRD_2026_08" as const;

export const LIVE_TRADING_PRODUCTS = Object.freeze([
  "GRT-USD",
  "MANA-USD",
  "XTZ-USD",
  "ZEC-USD",
] as const);

export type LiveTradingProduct = (typeof LIVE_TRADING_PRODUCTS)[number];

export interface LiveTradingSizingPolicy {
  readonly type: "TARGET_SIGNAL_NOTIONAL";
  readonly targetSignalNotional: number;
  readonly confidenceCalibration: "POWER_THIRD";
}

export interface LiveTradingRiskPolicy {
  readonly maxOrderNotional: number;
  readonly maxPositionNotional: number;
  readonly maxGrossExposure: number;
  readonly maxDailyLoss: number;
  readonly cooldownMs: number;
  readonly stopLossBps: number;
  readonly takeProfitBps: number;
}

export interface LiveTradingCandidate {
  readonly executionMode: string;
  readonly productId: string;
  readonly timeframe: string;
  readonly strategyIds: readonly string[];
  readonly intervalSeconds: number;
  readonly maxMarketStalenessMs: number;
  readonly candleLimit: number;
  readonly initialCapital: number;
  readonly maxDecisionNotional: number;
  readonly minNetQuantity: number;
  readonly sizingPolicy: {
    readonly type: string;
    readonly targetSignalNotional?: number;
    readonly confidenceCalibration?: string;
  };
  readonly risk: LiveTradingRiskPolicy;
}

export const LIVE_TRADING_POLICY = Object.freeze({
  id: LIVE_TRADING_POLICY_ID,
  products: LIVE_TRADING_PRODUCTS,
  baseIncrements: Object.freeze({
    "GRT-USD": 0.01,
    "MANA-USD": 0.01,
    "XTZ-USD": 0.01,
    "ZEC-USD": 0.000_000_01,
  } satisfies Readonly<Record<LiveTradingProduct, number>>),
  timeframe: "ONE_DAY" as const,
  strategyIds: Object.freeze([
    "breakout",
    "ema-cross",
    "rsi-reversion",
  ] as const),
  intervalSeconds: 3_600,
  maxMarketStalenessMs: 7_200_000,
  candleLimit: 200,
  initialCapital: 10_000,
  maxDecisionNotional: 600,
  minNetQuantity: 0.000_001,
  sizingPolicy: Object.freeze({
    type: "TARGET_SIGNAL_NOTIONAL" as const,
    targetSignalNotional: 1_000,
    confidenceCalibration: "POWER_THIRD" as const,
  }),
  risk: Object.freeze({
    maxOrderNotional: 600,
    maxPositionNotional: 10_000,
    maxGrossExposure: 20_000,
    maxDailyLoss: 1_000,
    cooldownMs: 0,
    stopLossBps: 150,
    takeProfitBps: 300,
  }),
});

export type LiveTradingAdmission =
  | { readonly status: "APPROVED" }
  | {
      readonly status: "REJECTED";
      readonly reasonCode:
        | "LIVE_PRODUCT_NOT_ALLOWED"
        | "LIVE_POLICY_MISMATCH";
    };

export type LiveTradingIdentityAdmission =
  | { readonly status: "APPROVED" }
  | {
      readonly status: "REJECTED";
      readonly reasonCode: "LIVE_AGENT_NAME_MISMATCH";
    };

export const liveTradingAgentName = (productId: string): string =>
  `${productId.toLowerCase()}--multi`;

export const assessLiveTradingAgentIdentity = (
  productId: string,
  agentName: string,
): LiveTradingIdentityAdmission =>
  agentName === liveTradingAgentName(productId)
    ? { status: "APPROVED" }
    : { status: "REJECTED", reasonCode: "LIVE_AGENT_NAME_MISMATCH" };

const sameOrderedStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const matchesSizing = (candidate: LiveTradingCandidate): boolean =>
  candidate.sizingPolicy.type === LIVE_TRADING_POLICY.sizingPolicy.type &&
  candidate.sizingPolicy.targetSignalNotional ===
    LIVE_TRADING_POLICY.sizingPolicy.targetSignalNotional &&
  candidate.sizingPolicy.confidenceCalibration ===
    LIVE_TRADING_POLICY.sizingPolicy.confidenceCalibration;

const matchesRisk = (candidate: LiveTradingCandidate): boolean => {
  const expected = LIVE_TRADING_POLICY.risk;
  const actual = candidate.risk;
  return (
    actual.maxOrderNotional === expected.maxOrderNotional &&
    actual.maxPositionNotional === expected.maxPositionNotional &&
    actual.maxGrossExposure === expected.maxGrossExposure &&
    actual.maxDailyLoss === expected.maxDailyLoss &&
    actual.cooldownMs === expected.cooldownMs &&
    actual.stopLossBps === expected.stopLossBps &&
    actual.takeProfitBps === expected.takeProfitBps
  );
};

export const assessLiveTradingPolicy = (
  candidate: LiveTradingCandidate,
): LiveTradingAdmission => {
  if (
    !LIVE_TRADING_PRODUCTS.includes(
      candidate.productId as LiveTradingProduct,
    )
  ) {
    return {
      status: "REJECTED",
      reasonCode: "LIVE_PRODUCT_NOT_ALLOWED",
    };
  }

  const matches =
    candidate.executionMode === "live" &&
    candidate.timeframe === LIVE_TRADING_POLICY.timeframe &&
    sameOrderedStrings(candidate.strategyIds, LIVE_TRADING_POLICY.strategyIds) &&
    candidate.intervalSeconds === LIVE_TRADING_POLICY.intervalSeconds &&
    candidate.maxMarketStalenessMs ===
      LIVE_TRADING_POLICY.maxMarketStalenessMs &&
    candidate.candleLimit === LIVE_TRADING_POLICY.candleLimit &&
    candidate.initialCapital === LIVE_TRADING_POLICY.initialCapital &&
    candidate.maxDecisionNotional ===
      LIVE_TRADING_POLICY.maxDecisionNotional &&
    candidate.minNetQuantity === LIVE_TRADING_POLICY.minNetQuantity &&
    matchesSizing(candidate) &&
    matchesRisk(candidate);

  return matches
    ? { status: "APPROVED" }
    : { status: "REJECTED", reasonCode: "LIVE_POLICY_MISMATCH" };
};
