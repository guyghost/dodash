import { executePaperOrder, type PaperPortfolio } from "@dodash/paper-execution";
import { ok, type Candle } from "@dodash/domain";
import { describe, expect, it, vi } from "vitest";

import { parseAgentConfiguration } from "../src/configuration.js";
import { runTradingCycle } from "../src/interpreter.js";
import { createTradingMachineSession } from "../src/machine-session.js";
import type {
  CycleArtifacts,
  MarketSnapshot,
  TradingCycleEffects,
} from "../src/types.js";
import { createTradingCycleEffects } from "../src/trading-effects.js";
import type { TradingEffectsDependencies } from "../src/trading-effects.js";

const DAY = 86_400_000;

const risingCandles: Candle[] = Array.from({ length: 80 }, (_, index) => {
  const close = 10 * 1.03 ** index;
  return {
    start: index * DAY,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 10,
  };
});

// Suffixe de 72 taux aligné sur les 80 bougies (carry favorable).
const fundingRates = Array.from({ length: 72 }, () => -1e-4);

const perpConfiguration = () => {
  const result = parseAgentConfiguration({
    productId: "BTC-USD",
    executionMode: "perp",
    strategyIds: ["funding-trend"],
    indicators: {
      rsiPeriod: 2,
      emaFastPeriod: 2,
      emaSlowPeriod: 3,
      atrPeriod: 2,
      historicalVolatilityPeriod: 2,
      momentumPeriod: 1,
      returnPeriods: [1],
      vwapPeriod: 2,
      relativeVolumePeriod: 1,
      volumeSpikeThreshold: 2,
      volumeTrendPeriod: 2,
      trendStrengthPeriod: 1,
    },
  });
  if (!result.ok) throw new Error("invalid perp test configuration");
  return result.value;
};

const readyMachine = (agentId: string, strategyIds: readonly string[]) => {
  const session = createTradingMachineSession({ agentId, strategyIds });
  session.send({
    type: "START_REQUESTED",
    permissions: { canControl: true, canTrade: true },
  });
  session.send({ type: "SCHEDULE_SUCCEEDED", nextWakeAt: 360_000 });
  const record = session.record;
  session.stop();
  return record;
};

const marketFor = (configuration: { productId: string; timeframe: string }):
  MarketSnapshot => ({
    productId: configuration.productId as MarketSnapshot["productId"],
    timeframe: configuration.timeframe as MarketSnapshot["timeframe"],
    candles: risingCandles,
    source: "coinbase",
    cached: false,
  });

const baseEffects = (
  market: MarketSnapshot,
  fetchFundingData?: TradingCycleEffects["fetchFundingData"],
) => {
  const fetchFunding = fetchFundingData === undefined ? undefined : vi.fn(fetchFundingData);
  const intents: unknown[] = [];
  const effects: TradingCycleEffects = {
    reconcileAccount: async (current, observedAt) =>
      ok({
        snapshotId: `test:${observedAt}`,
        observedAt,
        portfolio: current,
        accountEquity:
          current.cash + current.positionQuantity * current.averagePrice,
        otherExposureNotional: 0,
      }),
    fetchMarketData: async () => ok(market),
    ...(fetchFunding === undefined ? {} : { fetchFundingData: fetchFunding }),
    ensureSchedule: async () => ok({ nextWakeAt: 420_000 }),
    checkpoint: async (_artifacts: CycleArtifacts) => ok(undefined),
    persistMachine: async () => undefined,
    persistOrderIntent: async (_cycleId, intent) => {
      intents.push(intent);
      return ok(undefined);
    },
    authorize: async () => ok({ issuedAt: 360_000, expiresAt: 420_000 }),
    submitOrder: async (intent, _risk, _authorization, price, current, at) => {
      const execution = executePaperOrder(current, intent, price, at, {
        feeBps: 0,
        slippageBps: 0,
      });
      if (!execution.ok) {
        return {
          status: "REJECTED" as const,
          error: {
            phase: "execution" as const,
            code: "ORDER_REJECTED" as const,
            retryable: false,
          },
        };
      }
      return {
        status: "CONFIRMED" as const,
        exchangeOrderId: execution.value.trade.fill.exchangeOrderId,
        portfolio: execution.value.portfolio,
        fill: execution.value.trade.fill,
      };
    },
    reconcileOrder: async () =>
      ok({
        status: "REJECTED" as const,
        error: {
          phase: "execution" as const,
          code: "ORDER_REJECTED" as const,
          retryable: false,
        },
      }),
    cancelCurrentEffect: async () => ok(undefined),
    persistCycle: async () => ok(undefined),
  };
  return { effects, fetchFunding, intents };
};

const portfolio = (): PaperPortfolio => ({
  cash: 10_000,
  positionQuantity: 0,
  averagePrice: 0,
});

describe("branchement runtime funding (models/funding-rate-strategy.md §3)", () => {
  it("perp + funding-trend + série disponible ⇒ signal exécuté, effet appelé avec les bougies", async () => {
    const configuration = perpConfiguration();
    const market = marketFor(configuration);
    const { effects, fetchFunding, intents } = baseEffects(
      market,
      async (config, candles) => {
        expect(config.executionMode).toBe("perp");
        expect(candles.length).toBe(80);
        return fundingRates;
      },
    );

    const result = await runTradingCycle({
      agentId: "agent-funding",
      configuration,
      machine: readyMachine("agent-funding", configuration.strategyIds),
      artifacts: null,
      previousIndicators: null,
      portfolio: portfolio(),
      dailyPnl: 0,
      lastTradeAt: null,
      triggeredAt: 80 * DAY,
      cycleId: "cycle-funding-ok",
      triggerAlarm: true,
      effects,
    });

    expect(result.machine.context.outcome).toBe("ORDER_CONFIRMED");
    expect(fetchFunding).toHaveBeenCalledTimes(1);
    expect(intents.length).toBe(1);
    // l'indicateur a porté : BUY exécuté en tendance haussière + carry négatif
    expect(result.artifacts?.signals?.[0]?.side).toBe("BUY");
  });

  it("mode paper : jamais d'appel funding, comportement inchangé (C2)", async () => {
    const paper = parseAgentConfiguration({
      productId: "BTC-USD",
      strategyIds: ["funding-trend"],
      candleLimit: 100,
      indicators: {
        rsiPeriod: 2,
        emaFastPeriod: 2,
        emaSlowPeriod: 3,
        atrPeriod: 2,
        historicalVolatilityPeriod: 2,
        momentumPeriod: 1,
        returnPeriods: [1],
        vwapPeriod: 2,
        relativeVolumePeriod: 1,
        volumeSpikeThreshold: 2,
        volumeTrendPeriod: 2,
        trendStrengthPeriod: 1,
      },
    });
    if (!paper.ok) throw new Error("invalid paper test configuration");
    const configuration = paper.value;
    const market = marketFor(configuration);
    const { effects, fetchFunding, intents } = baseEffects(
      market,
      async () => fundingRates,
    );

    const result = await runTradingCycle({
      agentId: "agent-paper",
      configuration,
      machine: readyMachine("agent-paper", configuration.strategyIds),
      artifacts: null,
      previousIndicators: null,
      portfolio: portfolio(),
      dailyPnl: 0,
      lastTradeAt: null,
      triggeredAt: 80 * DAY,
      cycleId: "cycle-funding-paper",
      triggerAlarm: true,
      effects,
    });

    expect(fetchFunding).not.toHaveBeenCalled();
    expect(result.machine.context.outcome).toBe("NO_ACTION");
    expect(intents).toHaveLength(0);
    expect(result.machine.value).toBe("waiting");
  });

  it("perp sans effet câblé (instance héritée) ⇒ cycle inchangé (C3)", async () => {
    const configuration = perpConfiguration();
    const market = marketFor(configuration);
    const { effects, intents } = baseEffects(market);

    const result = await runTradingCycle({
      agentId: "agent-legacy",
      configuration,
      machine: readyMachine("agent-legacy", configuration.strategyIds),
      artifacts: null,
      previousIndicators: null,
      portfolio: portfolio(),
      dailyPnl: 0,
      lastTradeAt: null,
      triggeredAt: 80 * DAY,
      cycleId: "cycle-funding-legacy",
      triggerAlarm: true,
      effects,
    });

    expect(result.machine.context.outcome).toBe("NO_ACTION");
    expect(result.machine.value).toBe("waiting");
    expect(intents).toHaveLength(0);
  });

  it("indisponibilité (null) ⇒ télémétrie puis cycle continue sans funding (INV-F2)", async () => {
    const configuration = perpConfiguration();
    const market = marketFor(configuration);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { effects, intents } = baseEffects(
      market,
      async () => null,
    );

    try {
      const result = await runTradingCycle({
        agentId: "agent-funding-null",
        configuration,
        machine: readyMachine("agent-funding-null", configuration.strategyIds),
        artifacts: null,
        previousIndicators: null,
        portfolio: portfolio(),
        dailyPnl: 0,
        lastTradeAt: null,
        triggeredAt: 80 * DAY,
        cycleId: "cycle-funding-null",
        triggerAlarm: true,
        effects,
      });

      expect(result.machine.context.outcome).toBe("NO_ACTION");
      expect(result.machine.value).toBe("waiting");
      expect(intents).toHaveLength(0);
      expect(
        warnSpy.mock.calls.some(
          (call) =>
            typeof call[0] === "string" &&
            call[0].includes("funding_data_unavailable"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("couture fournisseur createTradingCycleEffects (§3)", () => {
  const perpEnv = {
    INTERNAL_SERVICE_TOKEN: "internal-token",
    HYPERLIQUID_PERP_TRADING_ENABLED: "true",
    HYPERLIQUID_AGENT_PRIVATE_KEY:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    HYPERLIQUID_WALLET_ADDRESS: "0x2222222222222222222222222222222222222222",
  };

  const depsFor = (
    configuration: Partial<AgentConfigurationLike>,
    fetchMock?: typeof fetch,
  ) => {
    const base = {
      configuration,
      env: { ...perpEnv },
      agentName: "test-agent",
      ensureIntervalSchedule: async () => ({ time: 1234 }),
      removeIntervalSchedule: async () => undefined,
      checkpoint: async () => ok(undefined),
      persistMachine: async () => undefined,
      persistOrderIntent: async () => ok(undefined),
      submitPaperOrder: async () => ({ status: "CONFIRMED" }),
      submitLiveOrder: async () => ({ status: "CONFIRMED" }),
      submitPerpOrder: async () => ({ status: "CONFIRMED" }),
      reconcilePaperOrder: async () => ok({ status: "CONFIRMED" }),
      reconcileLiveOrder: async () => ok({ status: "CONFIRMED" }),
      reconcilePerpOrder: async () => ok({ status: "CONFIRMED" }),
      persistCycle: async () => ok(undefined),
      loadKnownProtectiveOrderIds: () => ok([]),
      getKillContext: () => null,
      applyKilledAccount: () => undefined,
      ...(fetchMock === undefined ? {} : { fetch: fetchMock }),
    } as unknown as TradingEffectsDependencies;
    return base;
  };

  type AgentConfigurationLike = {
    readonly executionMode: string;
    readonly productId: string;
    readonly strategyIds: readonly string[];
  };

  it("fournit l'effet en perp avec réglages résolus, pas en paper", () => {
    const perp = createTradingCycleEffects(
      depsFor({ executionMode: "perp", productId: "BTC-USD", strategyIds: [] }),
    );
    const paper = createTradingCycleEffects(
      depsFor({ executionMode: "paper", productId: "BTC-USD", strategyIds: [] }),
    );
    expect(typeof perp.fetchFundingData).toBe("function");
    expect(paper.fetchFundingData).toBeUndefined();
  });

  it("agrège la série sur le suffixe des bougies (fetch mocké)", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify([
          { coin: "BTC", fundingRate: "0.0001", time: 78 * DAY + 1 },
          { coin: "BTC", fundingRate: "0.0003", time: 79 * DAY + 1 },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ) as unknown as Response,
    );
    const effects = createTradingCycleEffects(
      depsFor(
        { executionMode: "perp", productId: "BTC-USD", strategyIds: [] },
        fetchMock as unknown as typeof fetch,
      ),
    );
    const effect = effects.fetchFundingData;
    if (effect === undefined) throw new Error("effet attendu en perp");
    const rates = await effect(
      { executionMode: "perp", productId: "BTC-USD", strategyIds: [] } as never,
      risingCandles,
    );
    // 78 bougies observées sur les 80 : seules les 2 dernières heures ont
    // des observations dans la fixture → bougies sans observation ⇒ null
    expect(rates).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.hyperliquid.xyz/info");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "fundingHistory",
      coin: "BTC",
      startTime: risingCandles[8]?.start,
    });
  });
});
