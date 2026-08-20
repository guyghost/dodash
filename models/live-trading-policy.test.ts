import * as modelExports from "./index.js";
import { describe, expect, it } from "vitest";

type Candidate = {
  readonly executionMode: "live";
  readonly productId: string;
  readonly timeframe: "ONE_DAY";
  readonly strategyIds: readonly string[];
  readonly intervalSeconds: number;
  readonly maxMarketStalenessMs: number;
  readonly candleLimit: number;
  readonly initialCapital: number;
  readonly maxDecisionNotional: number;
  readonly minNetQuantity: number;
  readonly sizingPolicy: {
    readonly type: "TARGET_SIGNAL_NOTIONAL";
    readonly targetSignalNotional: number;
    readonly confidenceCalibration: "POWER_THIRD";
  };
  readonly risk: {
    readonly maxOrderNotional: number;
    readonly maxPositionNotional: number;
    readonly maxGrossExposure: number;
    readonly maxDailyLoss: number;
    readonly cooldownMs: number;
    readonly stopLossBps: number;
    readonly takeProfitBps: number;
  };
};

const candidate = (productId = "XTZ-USD"): Candidate => ({
  executionMode: "live",
  productId,
  timeframe: "ONE_DAY",
  strategyIds: ["breakout", "ema-cross", "rsi-reversion"],
  intervalSeconds: 3_600,
  maxMarketStalenessMs: 7_200_000,
  candleLimit: 200,
  initialCapital: 10_000,
  maxDecisionNotional: 600,
  minNetQuantity: 0.000_001,
  sizingPolicy: {
    type: "TARGET_SIGNAL_NOTIONAL",
    targetSignalNotional: 1_000,
    confidenceCalibration: "POWER_THIRD",
  },
  risk: {
    maxOrderNotional: 600,
    maxPositionNotional: 10_000,
    maxGrossExposure: 20_000,
    maxDailyLoss: 1_000,
    cooldownMs: 0,
    stopLossBps: 150,
    takeProfitBps: 300,
  },
});

const assess = (input: Candidate) => {
  const exported = modelExports as Record<string, unknown>;
  expect(typeof exported.assessLiveTradingPolicy).toBe("function");
  if (typeof exported.assessLiveTradingPolicy !== "function") return null;
  return (
    exported.assessLiveTradingPolicy as (
      value: Candidate,
    ) => { readonly status: string; readonly reasonCode?: string }
  )(input);
};

describe("assessLiveTradingPolicy", () => {
  it("fige les incréments de base Coinbase vérifiés avant déploiement", () => {
    expect(modelExports.LIVE_TRADING_POLICY.baseIncrements).toEqual({
      "GRT-USD": 0.01,
      "MANA-USD": 0.01,
      "XTZ-USD": 0.01,
      "ZEC-USD": 0.000_000_01,
    });
  });

  it.each(["XTZ-USD", "ZEC-USD", "GRT-USD", "MANA-USD"])(
    "admet l'enveloppe confirmée pour %s",
    (productId) => {
      expect(assess(candidate(productId))).toEqual({ status: "APPROVED" });
    },
  );

  it("refuse un produit absent de l'allowlist", () => {
    expect(assess(candidate("BTC-USD"))).toEqual({
      status: "REJECTED",
      reasonCode: "LIVE_PRODUCT_NOT_ALLOWED",
    });
  });

  it("lie chaque produit live à un nom d'Agent stable", () => {
    const exported = modelExports as Record<string, unknown>;
    expect(typeof exported.assessLiveTradingAgentIdentity).toBe("function");
    if (typeof exported.assessLiveTradingAgentIdentity !== "function") return;
    const assessIdentity = exported.assessLiveTradingAgentIdentity as (
      productId: string,
      agentName: string,
    ) => { readonly status: string; readonly reasonCode?: string };
    expect(assessIdentity("GRT-USD", "grt-usd--multi")).toEqual({
      status: "APPROVED",
    });
    expect(assessIdentity("GRT-USD", "second-grt-agent")).toEqual({
      status: "REJECTED",
      reasonCode: "LIVE_AGENT_NAME_MISMATCH",
    });
  });

  it.each([
    ["timeframe", { timeframe: "SIX_HOUR" }],
    ["strategies", { strategyIds: ["ema-cross"] }],
    ["capital", { initialCapital: 20_000 }],
    ["ordre", { maxDecisionNotional: 601 }],
    ["fraîcheur", { maxMarketStalenessMs: 7_200_001 }],
    [
      "sizing",
      {
        sizingPolicy: {
          type: "TARGET_SIGNAL_NOTIONAL",
          targetSignalNotional: 1_000,
          confidenceCalibration: "IDENTITY",
        },
      },
    ],
    [
      "risque",
      {
        risk: {
          ...candidate().risk,
          maxDailyLoss: 1_001,
        },
      },
    ],
  ])("refuse toute divergence de %s", (_label, override) => {
    expect(assess({ ...candidate(), ...override } as Candidate)).toEqual({
      status: "REJECTED",
      reasonCode: "LIVE_POLICY_MISMATCH",
    });
  });
});
