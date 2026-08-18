import {
  DEFAULT_INDICATOR_CONFIG,
  type IndicatorConfig,
} from "@dodash/indicators-prolog";
import { createProductId, err, ok, type ProductId, type Result, type Timeframe } from "@dodash/domain";
import type { PaperBrokerConfig } from "@dodash/backtest";
import type { RiskConfig } from "@dodash/risk";
import { z } from "zod";

export const STRATEGY_IDS = [
  "rsi-reversion",
  "ema-cross",
  "breakout",
] as const;

export type StrategyId = (typeof STRATEGY_IDS)[number];

export interface AgentConfiguration {
  readonly productId: ProductId;
  readonly timeframe: Timeframe;
  readonly strategyIds: readonly StrategyId[];
  readonly intervalSeconds: number;
  readonly candleLimit: number;
  readonly initialCapital: number;
  readonly maxDecisionNotional: number;
  readonly minNetQuantity: number;
  readonly executionMode: "paper" | "live";
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
  candleLimit: z.number().int().min(2).max(350).default(200),
  initialCapital: z.number().positive().default(10_000),
  maxDecisionNotional: z.number().positive().default(2_000),
  minNetQuantity: z.number().nonnegative().default(0.000_001),
  executionMode: z.enum(["paper", "live"]).default("paper"),
  indicators: indicatorSchema.default(DEFAULT_INDICATOR_CONFIG),
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

export const parseAgentConfiguration = (
  input: unknown,
): Result<AgentConfiguration, AgentConfigurationError> => {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return err({ code: "INVALID_CONFIGURATION" });

  const product = createProductId(parsed.data.productId);
  if (!product.ok) return err({ code: "INVALID_PRODUCT_ID" });

  const requiredCandles = Math.max(
    parsed.data.indicators.rsiPeriod + 1,
    parsed.data.indicators.emaSlowPeriod,
    parsed.data.indicators.atrPeriod,
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
      indicators: Object.freeze({ ...parsed.data.indicators }),
      risk: Object.freeze({ ...parsed.data.risk }),
      broker: Object.freeze({ ...parsed.data.broker }),
    }),
  );
};
