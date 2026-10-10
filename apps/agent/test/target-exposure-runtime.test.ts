// Intégration runtime de la politique P7 (models/target-exposure.md §4–§9).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createOrderIntent, createProductId, ok, type Candle, type OrderIntent } from "@dodash/domain";
import { targetExposureRiskGate } from "@dodash/models";
import { checkRisk } from "@dodash/risk";
import { executePaperOrder, type PaperPortfolio } from "@dodash/paper-execution";
import { describe, expect, it } from "vitest";

import {
  parseAgentConfiguration,
  parseMultiProductAgentConfiguration,
} from "../src/configuration.js";
import { runTradingCycle } from "../src/interpreter.js";
import { createTradingMachineSession } from "../src/machine-session.js";
import type { MarketSnapshot, TradingCycleEffects } from "../src/types.js";

const DAY = 86_400_000;
// 2025-01-09 est un jeudi UTC : ni lundi ni 1er du mois.
const THURSDAY = Date.UTC(2025, 0, 9);
const POLICY = {
  type: "TARGET_EXPOSURE",
  volTarget: 0.5,
  trendSmaPeriod: 200,
  volPeriod: 30,
  driftThreshold: 0.1,
  minOrderNotional: 10,
} as const;
const UNCAPPED_RISK = {
  maxOrderNotional: 1e12,
  maxPositionNotional: 1e12,
  maxGrossExposure: 1e12,
  maxDailyLoss: 2_500,
  cooldownMs: 0,
  stopLossBps: 150,
  takeProfitBps: 300,
};

const singleInput = (overrides: Record<string, unknown> = {}) => ({
  productId: "BTC-USD",
  timeframe: "ONE_DAY",
  strategyIds: ["target-exposure"],
  intervalSeconds: 3_600,
  maxMarketStalenessMs: 7_200_000,
  candleLimit: 240,
  executionMode: "paper",
  sizingPolicy: POLICY,
  risk: UNCAPPED_RISK,
  broker: { feeBps: 60, slippageBps: 2 },
  ...overrides,
});

/** 240 bougies daily ; la dernière débute `lastStart`. */
const dailyCandles = (closes: readonly number[], lastStart: number): Candle[] =>
  closes.map((close, index) => ({
    start: lastStart - (closes.length - 1 - index) * DAY,
    open: close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    volume: 10,
  }));

const rising = (count: number): number[] =>
  Array.from({ length: count }, (_, index) => 100 * 1.002 ** index * (index % 2 === 0 ? 1.001 : 0.999));

const trendBreak = (): number[] => {
  const closes = rising(239);
  closes.push(60); // clôture sous la SMA200 : ancre de changement de tendance
  return closes;
};

const machineFor = (strategyIds: readonly string[], kill = false) => {
  const session = createTradingMachineSession({ agentId: "agent-p7", strategyIds });
  session.send({ type: "START_REQUESTED", permissions: { canControl: true, canTrade: true } });
  session.send({ type: "SCHEDULE_SUCCEEDED", nextWakeAt: 0 });
  if (kill) {
    session.send({
      type: "KILL_SWITCH_ENGAGED",
      permissions: { canControl: true, canTrade: true },
      controlId: "kill-p7",
    });
  }
  const record = session.record;
  session.stop();
  return record;
};

const run = async (input: {
  readonly closes: readonly number[];
  readonly portfolio: PaperPortfolio;
  readonly dailyPnl: number;
  readonly kill?: boolean;
  readonly portfolioAdmission?: boolean;
}) => {
  const parsed = parseAgentConfiguration(singleInput());
  if (!parsed.ok) throw new Error(`configuration invalide ${parsed.error.code}`);
  const configuration = parsed.value;
  const candles = dailyCandles(input.closes, THURSDAY);
  const market: MarketSnapshot = {
    productId: configuration.productId,
    timeframe: configuration.timeframe,
    candles,
    source: "coinbase",
    cached: false,
  };
  const triggeredAt = THURSDAY + DAY + 60_000;
  const submitted: OrderIntent[] = [];
  let proposals = 0;
  const effects: TradingCycleEffects = {
    reconcileAccount: async (portfolio, observedAt) =>
      ok({
        snapshotId: `paper:${observedAt}`,
        observedAt,
        portfolio,
        accountEquity: portfolio.cash + portfolio.positionQuantity * portfolio.averagePrice,
        otherExposureNotional: 0,
      }),
    fetchMarketData: async () => ok(market),
    ensureSchedule: async () => ok({ nextWakeAt: triggeredAt + 3_600_000 }),
    checkpoint: async () => ok(undefined),
    persistMachine: async () => undefined,
    persistOrderIntent: async () => ok(undefined),
    authorize: async () => ok({ issuedAt: triggeredAt, expiresAt: triggeredAt + 60_000 }),
    submitOrder: async (intent, _risk, _authorization, price, portfolio, at) => {
      submitted.push(intent);
      const execution = executePaperOrder(portfolio, intent, price, at, configuration.broker);
      if (!execution.ok) {
        return { status: "REJECTED", error: { phase: "execution", code: "ORDER_REJECTED", retryable: false } };
      }
      return {
        status: "CONFIRMED",
        exchangeOrderId: execution.value.trade.fill.exchangeOrderId,
        portfolio: execution.value.portfolio,
        fill: execution.value.trade.fill,
      };
    },
    reconcileOrder: async () =>
      ok({ status: "REJECTED" as const, error: { phase: "execution" as const, code: "ORDER_REJECTED" as const, retryable: false } }),
    cancelCurrentEffect: async () => ok(undefined),
    persistCycle: async () => ok(undefined),
    ...(input.portfolioAdmission === undefined
      ? {}
      : {
          proposePortfolioRisk: async () => {
            proposals += 1;
            return { approved: input.portfolioAdmission === true, reasonCode: null };
          },
        }),
  };
  const result = await runTradingCycle({
    agentId: "agent-p7",
    configuration,
    machine: machineFor(configuration.strategyIds, input.kill === true),
    artifacts: null,
    previousIndicators: null,
    portfolio: input.portfolio,
    dailyPnl: input.dailyPnl,
    lastTradeAt: null,
    triggeredAt,
    cycleId: "cycle-p7",
    triggerAlarm: true,
    effects,
  });
  return { result, submitted, proposals: () => proposals };
};

describe("configuration TARGET_EXPOSURE (INV-T5, INV-T6, §5)", () => {
  it("accepte la politique P7 en paper", () => {
    expect(parseAgentConfiguration(singleInput()).ok).toBe(true);
  });

  it("refuse la politique hors paper", () => {
    expect(parseAgentConfiguration(singleInput({ executionMode: "live" })).ok).toBe(false);
    expect(parseAgentConfiguration(singleInput({ executionMode: "perp" })).ok).toBe(false);
  });

  it("refuse un historique insuffisant", () => {
    expect(parseAgentConfiguration(singleInput({ candleLimit: 239 }))).toEqual({
      ok: false,
      error: { code: "INSUFFICIENT_CANDLE_LIMIT" },
    });
  });

  it("refuse un plafond absolu inférieur à 1e9", () => {
    for (const cap of ["maxOrderNotional", "maxPositionNotional", "maxGrossExposure"]) {
      expect(parseAgentConfiguration(singleInput({ risk: { ...UNCAPPED_RISK, [cap]: 20_000 } })).ok).toBe(false);
    }
  });

  it("exige un cooldown nul (INV-T7)", () => {
    expect(parseAgentConfiguration(singleInput({ risk: { ...UNCAPPED_RISK, cooldownMs: 60_000 } })).ok).toBe(false);
  });

  it("refuse un timeframe autre que ONE_DAY", () => {
    expect(parseAgentConfiguration(singleInput({ timeframe: "ONE_HOUR" })).ok).toBe(false);
  });

  it("rend stratégie et politique mutuellement exclusives", () => {
    expect(parseAgentConfiguration(singleInput({ strategyIds: ["target-exposure", "ema-cross"] })).ok).toBe(false);
    expect(parseAgentConfiguration(singleInput({ strategyIds: ["ema-cross"] })).ok).toBe(false);
    expect(
      parseAgentConfiguration(
        singleInput({
          sizingPolicy: { type: "TARGET_SIGNAL_NOTIONAL", targetSignalNotional: 1_000, confidenceCalibration: "POWER_THIRD" },
        }),
      ).ok,
    ).toBe(false);
  });

  it("valide la configuration paper versionnée et refuse un plafond consolidé faible", () => {
    const path = fileURLToPath(new URL("../../../docs/operations/paper-p7-start.json", import.meta.url));
    const start = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const parsed = parseMultiProductAgentConfiguration(start);
    expect(parsed.ok).toBe(true);
    const weak = { ...start, portfolioRisk: { ...(start.portfolioRisk as object), maxGrossExposure: 20_000 } };
    expect(parseMultiProductAgentConfiguration(weak).ok).toBe(false);
    // Coupe-circuit consolidé en retard d'une bougie : neutralisé sous P7 (§5.3).
    const lagged = { ...start, portfolioRisk: { ...(start.portfolioRisk as object), maxDailyLoss: 5_000 } };
    expect(parseMultiProductAgentConfiguration(lagged).ok).toBe(false);
  });
});

describe("interpréteur TARGET_EXPOSURE (§4, INV-T7)", () => {
  const invested = (): PaperPortfolio => ({ cash: 0, positionQuantity: 50, averagePrice: 100 });

  it("vend un créneau entièrement investi (cash nul) au changement de tendance", async () => {
    const { result, submitted } = await run({ closes: trendBreak(), portfolio: invested(), dailyPnl: 0 });
    expect(submitted.map((intent) => intent.side)).toEqual(["SELL"]);
    expect(submitted[0]?.quantity).toBeCloseTo(50, 9);
    expect(result.portfolio.positionQuantity).toBeCloseTo(0, 9);
    expect(result.machine.context.outcome).toBe("ORDER_CONFIRMED");
  });

  it("vend malgré une perte journalière au-delà du coupe-circuit", async () => {
    const { submitted } = await run({ closes: trendBreak(), portfolio: invested(), dailyPnl: -9_000 });
    expect(submitted.map((intent) => intent.side)).toEqual(["SELL"]);
  });

  it("bloque un achat quand la perte journalière dépasse le coupe-circuit", async () => {
    const closes = rising(240);
    const blocked = await run({ closes, portfolio: { cash: 10_000, positionQuantity: 0, averagePrice: 0 }, dailyPnl: -9_000 });
    expect(blocked.submitted).toEqual([]);
    expect(blocked.result.machine.context.outcome).toBe("RISK_REJECTED");
    const allowed = await run({ closes, portfolio: { cash: 10_000, positionQuantity: 0, averagePrice: 0 }, dailyPnl: 0 });
    // Jeudi hors ancre : la dérive (0 % vs cible) dépasse 10 points ⇒ achat.
    expect(allowed.submitted.map((intent) => intent.side)).toEqual(["BUY"]);
  });

  it("bloque un achat quand la bougie de décision a perdu plus que le coupe-circuit, même avec dailyPnl nul (revue PR #24)", async () => {
    const closes = rising(239);
    closes.push(140); // chute de ~13 % sur la bougie de décision, tendance conservée (> SMA200)
    const portfolio = { cash: 20_000, positionQuantity: 150, averagePrice: 100 };
    // Variation du créneau sur la bougie : 150 × (140 − clôture précédente) < −2 500 $.
    const blocked = await run({ closes, portfolio, dailyPnl: 0 });
    expect(blocked.submitted).toEqual([]);
    expect(blocked.result.machine.context.outcome).toBe("RISK_REJECTED");
    // Même dérive, perte de bougie sous le seuil : l'achat passe.
    const small = await run({ closes, portfolio: { ...portfolio, positionQuantity: 50, cash: 40_000 }, dailyPnl: 0 });
    expect(small.submitted.map((intent) => intent.side)).toEqual(["BUY"]);
  });

  it("vend sans passer par l'admission portefeuille, même si elle refuserait", async () => {
    const { submitted, proposals } = await run({
      closes: trendBreak(),
      portfolio: invested(),
      dailyPnl: 0,
      portfolioAdmission: false,
    });
    expect(submitted.map((intent) => intent.side)).toEqual(["SELL"]);
    expect(proposals()).toBe(0);
  });

  it("soumet un achat à l'admission portefeuille, qui peut le refuser", async () => {
    const refused = await run({
      closes: rising(240),
      portfolio: { cash: 10_000, positionQuantity: 0, averagePrice: 0 },
      dailyPnl: 0,
      portfolioAdmission: false,
    });
    expect(refused.submitted).toEqual([]);
    expect(refused.proposals()).toBe(1);
    expect(refused.result.machine.context.outcome).toBe("RISK_REJECTED");
  });

  it("laisse le kill switch bloquer une réduction (seule exception à INV-T7)", () => {
    const product = createProductId("BTC-USD");
    if (!product.ok) throw new Error("produit invalide");
    const intent = createOrderIntent({
      clientOrderId: "kill-sell",
      decisionId: "kill-sell",
      strategyIds: ["target-exposure"],
      productId: product.value,
      side: "SELL",
      type: "MARKET",
      quantity: 50,
      limitPrice: null,
    });
    if (!intent.ok) throw new Error("intention invalide");
    const gate = targetExposureRiskGate("SELL", -9_000, -9_000);
    const snapshot = {
      marketPrice: 100,
      currentPositionQuantity: 50,
      otherExposureNotional: 0,
      dailyPnl: gate.dailyPnlForRisk,
      lastTradeAt: null,
      now: THURSDAY,
    };
    const killed = checkRisk(intent.value, { ...snapshot, killSwitchActive: true }, UNCAPPED_RISK);
    const live = checkRisk(intent.value, { ...snapshot, killSwitchActive: false }, UNCAPPED_RISK);
    expect(killed.ok && killed.value.status).toBe("REJECTED");
    expect(live.ok && live.value.status).toBe("APPROVED");
  });

  it("n'exécute aucun cycle quand le kill switch est engagé avant le réveil", async () => {
    const { submitted } = await run({ closes: trendBreak(), portfolio: invested(), dailyPnl: 0, kill: true });
    expect(submitted).toEqual([]);
  });
});
