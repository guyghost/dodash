import {
  DEFAULT_INDICATOR_CONFIG,
  requiredIndicatorCandles,
  type IndicatorConfig,
} from "@dodash/indicators-prolog";
import { createProductId, err, ok, type ProductId, type Result, type Timeframe } from "@dodash/domain";
import type { PaperBrokerConfig } from "@dodash/backtest";
import {
  assessLiveTradingPolicy,
  LIVE_TRADING_POLICY,
  type LiveTradingAdmission,
} from "@dodash/models";
import type { RiskConfig } from "@dodash/risk";
import { z } from "zod";

export const STRATEGY_IDS = [
  "rsi-reversion",
  "ema-cross",
  "breakout",
] as const;

export type StrategyId = (typeof STRATEGY_IDS)[number];

export type AgentSizingPolicy =
  | { readonly type: "NATIVE" }
  | {
      readonly type: "TARGET_SIGNAL_NOTIONAL";
      readonly targetSignalNotional: number;
      readonly confidenceCalibration: "POWER_THIRD";
    };

export interface AgentConfiguration {
  readonly productId: ProductId;
  readonly timeframe: Timeframe;
  readonly strategyIds: readonly StrategyId[];
  readonly intervalSeconds: number;
  readonly maxMarketStalenessMs: number;
  readonly candleLimit: number;
  readonly initialCapital: number;
  readonly maxDecisionNotional: number;
  readonly minNetQuantity: number;
  readonly executionMode: "paper" | "live";
  readonly sizingPolicy: AgentSizingPolicy;
  readonly indicators: IndicatorConfig;
  readonly risk: RiskConfig;
  readonly broker: PaperBrokerConfig;
}

export type AgentConfigurationError =
  | { readonly code: "INVALID_CONFIGURATION" }
  | { readonly code: "INVALID_PRODUCT_ID" }
  | { readonly code: "INSUFFICIENT_CANDLE_LIMIT" };

const indicatorSchema = z
  .object({
    rsiPeriod: z.number().int().positive().default(DEFAULT_INDICATOR_CONFIG.rsiPeriod),
    emaFastPeriod: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_INDICATOR_CONFIG.emaFastPeriod),
    emaSlowPeriod: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_INDICATOR_CONFIG.emaSlowPeriod),
    atrPeriod: z.number().int().positive().default(DEFAULT_INDICATOR_CONFIG.atrPeriod),
    historicalVolatilityPeriod: z
      .number()
      .int()
      .min(2)
      .default(DEFAULT_INDICATOR_CONFIG.historicalVolatilityPeriod),
    momentumPeriod: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_INDICATOR_CONFIG.momentumPeriod),
    returnPeriods: z
      .array(z.number().int().positive())
      .min(1)
      .refine((periods) =>
        periods.every(
          (period, index) => index === 0 || period > (periods[index - 1] ?? 0),
        ),
      )
      .default([...DEFAULT_INDICATOR_CONFIG.returnPeriods]),
    vwapPeriod: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_INDICATOR_CONFIG.vwapPeriod),
    relativeVolumePeriod: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_INDICATOR_CONFIG.relativeVolumePeriod),
    volumeSpikeThreshold: z
      .number()
      .positive()
      .default(DEFAULT_INDICATOR_CONFIG.volumeSpikeThreshold),
    volumeTrendPeriod: z
      .number()
      .int()
      .min(2)
      .default(DEFAULT_INDICATOR_CONFIG.volumeTrendPeriod),
    trendStrengthPeriod: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_INDICATOR_CONFIG.trendStrengthPeriod),
  })
  .refine((value) => value.emaFastPeriod < value.emaSlowPeriod);

const riskSchema = z.object({
  maxOrderNotional: z.number().positive().default(2_000),
  maxPositionNotional: z.number().positive().default(10_000),
  maxGrossExposure: z.number().positive().default(20_000),
  maxDailyLoss: z.number().positive().default(1_000),
  cooldownMs: z.number().int().nonnegative().default(60_000),
  stopLossBps: z.number().positive().max(9_999).default(150),
  takeProfitBps: z.number().positive().max(99_999).default(300),
});

const brokerSchema = z.object({
  feeBps: z.number().nonnegative().max(9_999).default(6),
  slippageBps: z.number().nonnegative().max(9_999).default(2),
});

const sizingPolicySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("NATIVE") }),
  z.object({
    type: z.literal("TARGET_SIGNAL_NOTIONAL"),
    targetSignalNotional: z.number().positive(),
    confidenceCalibration: z.literal("POWER_THIRD"),
  }),
]);

const inputSchema = z.object({
  productId: z.string(),
  timeframe: z
    .enum([
      "ONE_MINUTE",
      "FIVE_MINUTE",
      "FIFTEEN_MINUTE",
      "ONE_HOUR",
      "SIX_HOUR",
      "ONE_DAY",
    ])
    .default("ONE_MINUTE"),
  strategyIds: z.array(z.enum(STRATEGY_IDS)).min(1).max(3).default([...STRATEGY_IDS]),
  intervalSeconds: z.number().int().min(10).max(86_400).default(60),
  maxMarketStalenessMs: z.number().int().positive().default(90_000),
  candleLimit: z.number().int().min(2).max(350).default(200),
  initialCapital: z.number().positive().default(10_000),
  maxDecisionNotional: z.number().positive().default(2_000),
  minNetQuantity: z.number().nonnegative().default(0.000_001),
  executionMode: z.enum(["paper", "live"]).default("paper"),
  sizingPolicy: sizingPolicySchema.default({ type: "NATIVE" }),
  indicators: indicatorSchema.default({
    ...DEFAULT_INDICATOR_CONFIG,
    returnPeriods: [...DEFAULT_INDICATOR_CONFIG.returnPeriods],
  }),
  risk: riskSchema.default({
    maxOrderNotional: 2_000,
    maxPositionNotional: 10_000,
    maxGrossExposure: 20_000,
    maxDailyLoss: 1_000,
    cooldownMs: 60_000,
    stopLossBps: 150,
    takeProfitBps: 300,
  }),
  broker: brokerSchema.default({ feeBps: 6, slippageBps: 2 }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withLivePolicyDefaults = (input: unknown): unknown => {
  if (!isRecord(input) || input.executionMode !== "live") return input;
  const risk = isRecord(input.risk) ? input.risk : {};
  const sizingPolicy = isRecord(input.sizingPolicy) ? input.sizingPolicy : {};
  return {
    timeframe: LIVE_TRADING_POLICY.timeframe,
    strategyIds: [...LIVE_TRADING_POLICY.strategyIds],
    intervalSeconds: LIVE_TRADING_POLICY.intervalSeconds,
    maxMarketStalenessMs: LIVE_TRADING_POLICY.maxMarketStalenessMs,
    candleLimit: LIVE_TRADING_POLICY.candleLimit,
    initialCapital: LIVE_TRADING_POLICY.initialCapital,
    maxDecisionNotional: LIVE_TRADING_POLICY.maxDecisionNotional,
    minNetQuantity: LIVE_TRADING_POLICY.minNetQuantity,
    ...input,
    // Preserve nested live defaults while allowing explicit divergences to be
    // surfaced by the admission model rather than silently overwritten.
    sizingPolicy: { ...LIVE_TRADING_POLICY.sizingPolicy, ...sizingPolicy },
    risk: { ...LIVE_TRADING_POLICY.risk, ...risk },
  };
};

export const parseAgentConfiguration = (
  input: unknown,
): Result<AgentConfiguration, AgentConfigurationError> => {
  const parsed = inputSchema.safeParse(withLivePolicyDefaults(input));
  if (!parsed.success) return err({ code: "INVALID_CONFIGURATION" });

  const product = createProductId(parsed.data.productId);
  if (!product.ok) return err({ code: "INVALID_PRODUCT_ID" });

  const requiredCandles = Math.max(
    requiredIndicatorCandles(parsed.data.indicators),
    parsed.data.strategyIds.includes("breakout") ? 21 : 0,
  );
  if (parsed.data.candleLimit < requiredCandles) {
    return err({ code: "INSUFFICIENT_CANDLE_LIMIT" });
  }

  return ok(
    Object.freeze({
      ...parsed.data,
      productId: product.value,
      strategyIds: Object.freeze([...new Set(parsed.data.strategyIds)].sort()) as readonly StrategyId[],
      indicators: Object.freeze({
        ...parsed.data.indicators,
        returnPeriods: Object.freeze([...parsed.data.indicators.returnPeriods]),
      }),
      risk: Object.freeze({ ...parsed.data.risk }),
      broker: Object.freeze({ ...parsed.data.broker }),
    }),
  );
};

export const admitAgentConfiguration = (
  configuration: AgentConfiguration,
): LiveTradingAdmission =>
  configuration.executionMode === "paper"
    ? { status: "APPROVED" }
    : assessLiveTradingPolicy(configuration);
