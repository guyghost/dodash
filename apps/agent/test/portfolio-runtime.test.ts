import {
  createProductId,
  ok,
  type Candle,
  type OrderIntent,
  type ProductId,
} from "@dodash/domain";
import { executePaperOrder } from "@dodash/paper-execution";
import type { WorkflowError } from "@dodash/models";
import { describe, expect, it } from "vitest";

import {
  parseAgentConfiguration,
  parseMultiProductAgentConfiguration,
  type AgentConfiguration,
  type MultiProductAgentConfiguration,
} from "../src/configuration.js";
import { runTradingCycle } from "../src/interpreter.js";
import { createTradingMachineSession } from "../src/machine-session.js";
import {
  createPortfolioMachineSession,
  proposePortfolioRisk,
  sendPortfolioEvent,
  type PersistedPortfolioMachine,
} from "../src/portfolio-runtime.js";
import type {
  CycleArtifacts,
  MarketSnapshot,
  TradingCycleEffects,
} from "../src/types.js";

const candlesFromCloses = (closes: readonly number[]): Candle[] =>
  closes.map((close, index) => ({
    start: index * 60_000,
    open: close,
    high: close + 1,
    low: Math.max(0.01, close - 1),
    close,
    volume: 10,
  }));

const shared = {
  strategyIds: ["rsi-reversion"] as const,
  candleLimit: 6,
  intervalSeconds: 60,
  indicators: {
    rsiPeriod: 5,
    emaFastPeriod: 3,
    emaSlowPeriod: 5,
    atrPeriod: 3,
    historicalVolatilityPeriod: 2,
    momentumPeriod: 1,
    returnPeriods: [1],
    vwapPeriod: 2,
    relativeVolumePeriod: 1,
    volumeSpikeThreshold: 2,
    volumeTrendPeriod: 2,
    trendStrengthPeriod: 1,
  },
  broker: { feeBps: 0, slippageBps: 0 },
};

const riskProfile = {
  maxOrderNotional: 2_000,
  maxPositionNotional: 10_000,
  maxGrossExposure: 20_000,
  maxDailyLoss: 1_000,
  cooldownMs: 0,
  stopLossBps: 150,
  takeProfitBps: 300,
};

const legacyConfiguration = (productId = "BTC-USD"): AgentConfiguration => {
  const result = parseAgentConfiguration({ productId, ...shared, risk: riskProfile });
  if (!result.ok) throw new Error("invalid legacy fixture");
  return result.value;
};

const singleSlotConfiguration = (productId = "BTC-USD"): AgentConfiguration => {
  const result = parseAgentConfiguration({
    products: [{ productId, risk: riskProfile }],
    ...shared,
  });
  if (!result.ok) throw new Error("invalid products[1] fixture");
  return result.value;
};

const multiConfiguration = (
  portfolioRisk: { maxGrossExposure: number; maxDailyLoss: number },
): MultiProductAgentConfiguration => {
  const result = parseMultiProductAgentConfiguration({
    ...shared,
    products: [
      { productId: "AAA-USD", risk: riskProfile },
      { productId: "BBB-USD", risk: riskProfile },
    ],
    portfolioRisk,
  });
  if (!result.ok) throw new Error("invalid multi fixture");
  return result.value;
};

const startedPortfolioRecord = (
  multi: MultiProductAgentConfiguration,
): PersistedPortfolioMachine => {
  const session = createPortfolioMachineSession({
    products: multi.products.map((slot) => slot.productId),
    limits: multi.portfolioRisk ?? { maxGrossExposure: 10_000, maxDailyLoss: 5_000 },
  });
  session.send({ type: "PORTFOLIO_STARTED" });
  const record = session.record;
  session.stop();
  return record;
};

const startedProductMachine = (
  multi: MultiProductAgentConfiguration,
): ReturnType<typeof createTradingMachineSession>["record"] => {
  const session = createTradingMachineSession({
    agentId: "agent-1",
    strategyIds: multi.strategyIds,
    maxMarketStalenessMs: multi.maxMarketStalenessMs,
  });
  session.send({
    type: "START_REQUESTED",
    permissions: { canControl: true, canTrade: true },
  });
  session.send({ type: "SCHEDULE_SUCCEEDED", nextWakeAt: 360_000 });
  const record = session.record;
  session.stop();
  return record;
};

const market = (
  productId: AgentConfiguration["productId"],
  candles: readonly Candle[],
): MarketSnapshot => ({
  productId,
  timeframe: "ONE_MINUTE",
  candles,
  source: "coinbase",
  cached: false,
});

const productIdOf = (value: string): ProductId => {
  const created = createProductId(value);
  if (!created.ok) throw new Error("invalid test product id");
  return created.value;
};

const decliningMarket = (productId: ProductId) =>
  market(productId, candlesFromCloses([10, 9, 8, 7, 6, 5]));

interface PortfolioHolder {
  record: PersistedPortfolioMachine;
}

/**
 * Effets produit : identiques au mono-produit lorsque `holder` est
 * absent (couture non câblée — C2) ; sinon, même câblage que le
 * Durable Object — la décision vient de la machine du §5 (INV-P5).
 */
const productEffects = (
  productMarket: MarketSnapshot,
  holder?: PortfolioHolder,
) => {
  const intents: OrderIntent[] = [];
  const checkpoints: CycleArtifacts[] = [];
  let persistedCycles = 0;
  const effects: TradingCycleEffects = {
    reconcileAccount: async (portfolio, observedAt) =>
      ok({
        snapshotId: `paper:${observedAt}`,
        observedAt,
        portfolio,
        accountEquity:
          portfolio.cash +
          portfolio.positionQuantity * portfolio.averagePrice,
        otherExposureNotional: 0,
      }),
    fetchMarketData: async () => ok(productMarket),
    ensureSchedule: async () => ok({ nextWakeAt: 420_000 }),
    checkpoint: async (artifacts) => {
      checkpoints.push(artifacts);
      return ok(undefined);
    },
    persistMachine: async () => undefined,
    persistOrderIntent: async (_cycleId, intent) => {
      intents.push(intent);
      return ok(undefined);
    },
    authorize: async () => ok({ issuedAt: 360_000, expiresAt: 420_000 }),
    submitOrder: async (intent, _risk, _auth, price, portfolio, at) => {
      const execution = executePaperOrder(portfolio, intent, price, at, {
        feeBps: 0,
        slippageBps: 0,
      });
      if (!execution.ok) {
        const error: WorkflowError = {
          phase: "execution",
          code: "ORDER_REJECTED",
          retryable: false,
        };
        return { status: "REJECTED", error };
      }
      return {
        status: "CONFIRMED",
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
    persistCycle: async () => {
      persistedCycles += 1;
      return ok(undefined);
    },
    ...(holder === undefined
      ? {}
      : {
          proposePortfolioRisk: async (
            productId: string,
            proposedGrossExposure: number,
          ) => {
            const proposal = proposePortfolioRisk(
              holder.record,
              productId,
              proposedGrossExposure,
            );
            holder.record = proposal.record;
            return proposal.decision;
          },
        }),
  };
  return {
    effects,
    intents,
    checkpoints,
    get persistedCycles() {
      return persistedCycles;
    },
  };
};

const initialPortfolio = { cash: 10_000, positionQuantity: 0, averagePrice: 0 };

const runProductCycle = async (input: {
  configuration: AgentConfiguration;
  machine: ReturnType<typeof startedProductMachine>;
  productMarket: MarketSnapshot;
  holder?: PortfolioHolder;
  cycleId: string;
}) => {
  const fixture = productEffects(input.productMarket, input.holder);
  const result = await runTradingCycle({
    agentId: "agent-1",
    configuration: input.configuration,
    machine: input.machine,
    artifacts: null,
    previousIndicators: null,
    portfolio: { ...initialPortfolio },
    dailyPnl: 0,
    lastTradeAt: null,
    triggeredAt: 360_000,
    cycleId: input.cycleId,
    triggerAlarm: true,
    effects: fixture.effects,
  });
  return { result, fixture };
};

describe("tests jumeaux : mono-produit vs products[] à un élément (C2)", () => {
  it("produit la configuration legacy exacte puis les mêmes décisions de cycle", async () => {
    const legacy = legacyConfiguration();
    const projected = singleSlotConfiguration();
    // Forme strictement identique (INV-P6), admissions incluses.
    expect(projected).toEqual(legacy);
    expect(projected.executionMode).toBe("paper");

    const machine = startedProductMachine(multiConfiguration({
      maxGrossExposure: 10_000,
      maxDailyLoss: 5_000,
    }));
    const legacyRun = await runProductCycle({
      configuration: legacy,
      machine,
      productMarket: decliningMarket(legacy.productId),
      cycleId: "cycle-twin",
    });
    const projectedRun = await runProductCycle({
      configuration: projected,
      machine,
      productMarket: decliningMarket(projected.productId),
      cycleId: "cycle-twin",
    });

    // Sans couture portefeuille, le comportement est strictement celui
    // d'aujourd'hui : mêmes phases, mêmes décisions, mêmes artefacts.
    expect(projectedRun.result.machine.value).toBe("waiting");
    expect(projectedRun.result.machine.value).toBe(legacyRun.result.machine.value);
    expect(projectedRun.result.machine.context.outcome).toBe(
      legacyRun.result.machine.context.outcome,
    );
    expect(projectedRun.result.portfolio).toEqual(legacyRun.result.portfolio);
    expect(projectedRun.result.artifacts).toEqual(legacyRun.result.artifacts);
    expect(projectedRun.fixture.intents).toEqual(legacyRun.fixture.intents);
    expect(projectedRun.fixture.checkpoints).toEqual(legacyRun.fixture.checkpoints);
    expect(projectedRun.fixture.persistedCycles).toBe(
      legacyRun.fixture.persistedCycles,
    );
    expect(projectedRun.result.portfolio.positionQuantity).toBeGreaterThan(0);
  });
});

describe("branchement runtime multi-produits (§9)", () => {
  it("exécute deux produits indépendants avec expositions consolidées committées", async () => {
    const multi = multiConfiguration({
      maxGrossExposure: 10_000,
      maxDailyLoss: 5_000,
    });
    const holder: PortfolioHolder = {
      record: startedPortfolioRecord(multi),
    };

    const aaa = await runProductCycle({
      configuration: legacyConfiguration("AAA-USD"),
      machine: startedProductMachine(multi),
      productMarket: decliningMarket(productIdOf("AAA-USD")),
      holder,
      cycleId: "cycle-aaa",
    });
    const bbb = await runProductCycle({
      configuration: legacyConfiguration("BBB-USD"),
      machine: startedProductMachine(multi),
      productMarket: decliningMarket(productIdOf("BBB-USD")),
      holder,
      cycleId: "cycle-bbb",
    });

    expect(aaa.result.machine.context.outcome).toBe("ORDER_CONFIRMED");
    expect(bbb.result.machine.context.outcome).toBe("ORDER_CONFIRMED");
    expect(aaa.result.portfolio.positionQuantity).toBeGreaterThan(0);
    expect(bbb.result.portfolio.positionQuantity).toBeGreaterThan(0);
    expect(holder.record.value).toBe("running");
    // §9.4 : les expositions des deux produits sont committées à
    // l'orchestrateur via les propositions consolidées.
    expect(holder.record.context.exposure["AAA-USD"]).toBeGreaterThan(0);
    expect(holder.record.context.exposure["BBB-USD"]).toBeGreaterThan(0);
  });

  it("rejette fail-closed à la volée quand le plafond consolidé est dépassé", async () => {
    // L'allocateur ne produit un ordre que si quantity > minNetQuantity
    // (1e-6) à un prix de 5 ⇒ toute proposition dépasse 5e-6 : le plafond
    // 1e-6 rend le refus consolidé déterministe pour les deux produits.
    const multi = multiConfiguration({
      maxGrossExposure: 0.000_001,
      maxDailyLoss: 5_000,
    });
    const holder: PortfolioHolder = {
      record: startedPortfolioRecord(multi),
    };

    const aaa = await runProductCycle({
      configuration: legacyConfiguration("AAA-USD"),
      machine: startedProductMachine(multi),
      productMarket: decliningMarket(productIdOf("AAA-USD")),
      holder,
      cycleId: "cycle-aaa",
    });
    const bbb = await runProductCycle({
      configuration: legacyConfiguration("BBB-USD"),
      machine: startedProductMachine(multi),
      productMarket: decliningMarket(productIdOf("BBB-USD")),
      holder,
      cycleId: "cycle-bbb",
    });

    // Aucun ordre n'augmente l'exposition au-delà du plafond : le refus
    // consolidé devient un RISK_REJECTED produit (§9.3).
    expect(aaa.result.machine.context.outcome).toBe("RISK_REJECTED");
    expect(bbb.result.machine.context.outcome).toBe("RISK_REJECTED");
    expect(aaa.fixture.intents).toHaveLength(0);
    expect(bbb.fixture.intents).toHaveLength(0);
    expect(aaa.result.portfolio.positionQuantity).toBe(0);
    expect(bbb.result.portfolio.positionQuantity).toBe(0);
    // Aucun artefact de risque approuvé n'est persisté (C3).
    expect(aaa.result.artifacts?.risk).toBeUndefined();
    expect(holder.record.context.lastDecision).toMatchObject({
      productId: "BBB-USD",
      approved: false,
      reasonCode: "CONSOLIDATED_GROSS_EXPOSURE_LIMIT",
    });
  });

  it("n'admet plus rien après le kill portefeuille (draining, §9.5)", async () => {
    const multi = multiConfiguration({
      maxGrossExposure: 10_000,
      maxDailyLoss: 5_000,
    });
    const holder: PortfolioHolder = {
      record: startedPortfolioRecord(multi),
    };
    holder.record = sendPortfolioEvent(holder.record, {
      type: "KILL_SWITCH_ENGAGED",
      controlId: "kill-1",
    });
    expect(holder.record.value).toBe("draining");

    const aaa = await runProductCycle({
      configuration: legacyConfiguration("AAA-USD"),
      machine: startedProductMachine(multi),
      productMarket: decliningMarket(productIdOf("AAA-USD")),
      holder,
      cycleId: "cycle-aaa",
    });
    expect(aaa.result.machine.context.outcome).toBe("RISK_REJECTED");
    expect(aaa.fixture.intents).toHaveLength(0);
    expect(holder.record.context.lastDecision).toMatchObject({
      approved: false,
      reasonCode: "CONSOLIDATED_KILL_SWITCH",
    });
  });

  it("garde les autres produits actifs après l'arrêt d'un produit (INV-P3)", async () => {
    const multi = multiConfiguration({
      maxGrossExposure: 10_000,
      maxDailyLoss: 5_000,
    });
    const holder: PortfolioHolder = {
      record: startedPortfolioRecord(multi),
    };

    // AAA est stoppé proprement : quiescence par produit (§9.5), son
    // état est publié à l'orchestrateur sans re-planifier BBB.
    holder.record = sendPortfolioEvent(holder.record, {
      type: "PRODUCT_STOPPED",
      productId: "AAA-USD",
    });
    expect(holder.record.context.statuses["AAA-USD"]).toBe("stopped");

    // BBB poursuit ses cycles et reste admissible.
    const bbb = await runProductCycle({
      configuration: legacyConfiguration("BBB-USD"),
      machine: startedProductMachine(multi),
      productMarket: decliningMarket(productIdOf("BBB-USD")),
      holder,
      cycleId: "cycle-bbb",
    });
    expect(bbb.result.machine.context.outcome).toBe("ORDER_CONFIRMED");
    expect(holder.record.value).toBe("running");
    expect(holder.record.context.statuses["BBB-USD"]).toBe("running");
  });
});
