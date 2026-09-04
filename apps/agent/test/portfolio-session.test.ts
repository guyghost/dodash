import { describe, expect, it } from "vitest";

import {
  parseMultiProductAgentConfiguration,
  type MultiProductAgentConfiguration,
} from "../src/configuration.js";
import { createTradingMachineSession } from "../src/machine-session.js";
import {
  createPortfolioMachineSession,
  initialProductRuntime,
  proposePortfolioRisk,
  rejectedPortfolioRecord,
  resolveRestoredPortfolioSession,
  sendPortfolioEvent,
  type PortfolioSessionState,
} from "../src/portfolio-runtime.js";
import { portfolioIsEnabled } from "../src/state.js";

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

const multiConfiguration = (
  overrides: Partial<{
    products: readonly { productId: string }[];
    portfolioRisk: { maxGrossExposure: number; maxDailyLoss: number };
  }> = {},
): MultiProductAgentConfiguration => {
  const slots = (overrides.products ?? [
    { productId: "AAA-USD" },
    { productId: "BBB-USD" },
  ]).map((slot) => ({ ...slot, risk: riskProfile }));
  const result = parseMultiProductAgentConfiguration({
    ...shared,
    products: slots,
    portfolioRisk: overrides.portfolioRisk ?? {
      maxGrossExposure: 10_000,
      maxDailyLoss: 5_000,
    },
  });
  if (!result.ok) throw new Error("invalid multi-product fixture");
  return result.value;
};

const startedPortfolio = (
  multi: MultiProductAgentConfiguration,
): ReturnType<typeof createPortfolioMachineSession>["record"] => {
  const session = createPortfolioMachineSession({
    products: multi.products.map((slot) => slot.productId),
    limits: multi.portfolioRisk ?? { maxGrossExposure: 10_000, maxDailyLoss: 5_000 },
  });
  session.send({ type: "PORTFOLIO_STARTED" });
  const record = session.record;
  session.stop();
  return record;
};

const startedProductMachine = () => {
  const session = createTradingMachineSession({
    agentId: "agent-1",
    strategyIds: shared.strategyIds,
    maxMarketStalenessMs: 90_000,
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

const stoppedProductMachine = () => {
  const session = createTradingMachineSession({
    agentId: "agent-1",
    strategyIds: shared.strategyIds,
    maxMarketStalenessMs: 90_000,
  });
  session.send({
    type: "START_REQUESTED",
    permissions: { canControl: true, canTrade: true },
  });
  session.send({ type: "SCHEDULE_SUCCEEDED", nextWakeAt: 360_000 });
  session.send({
    type: "STOP_REQUESTED",
    permissions: { canControl: true, canTrade: true },
  });
  // Même séquence que l'interpréteur : cancellation puis persistance
  // mènent la machine à l'état terminal `stopped`.
  session.send({ type: "EFFECT_CANCELLED" });
  session.send({ type: "PERSIST_SUCCEEDED" });
  const record = session.record;
  session.stop();
  expect(record.value).toBe("stopped");
  return record;
};

const validSession = (): PortfolioSessionState => {
  const multi = multiConfiguration();
  return {
    configuration: multi,
    portfolio: startedPortfolio(multi),
    products: {
      "AAA-USD": initialProductRuntime(startedProductMachine(), multi.initialCapital),
      "BBB-USD": initialProductRuntime(startedProductMachine(), multi.initialCapital),
    },
  };
};

describe("createPortfolioMachineSession", () => {
  it("atteint running sur PORTFOLIO_STARTED avec tous les produits en course", () => {
    const multi = multiConfiguration();
    const record = startedPortfolio(multi);
    expect(record.value).toBe("running");
    expect(record.context.statuses).toEqual({
      "AAA-USD": "running",
      "BBB-USD": "running",
    });
    expect(record.context.exposure).toEqual({ "AAA-USD": 0, "BBB-USD": 0 });
  });

  it("reste rejetée sur une entrée invalide (doublon, vide, limites non positives)", () => {
    for (const products of [
      ["AAA-USD", "AAA-USD"],
      [],
    ]) {
      const session = createPortfolioMachineSession({
        products,
        limits: { maxGrossExposure: 10_000, maxDailyLoss: 5_000 },
      });
      const record = session.record;
      session.stop();
      expect(record.value).toBe("rejected");
    }
    const session = createPortfolioMachineSession({
      products: ["AAA-USD"],
      limits: { maxGrossExposure: 0, maxDailyLoss: 5_000 },
    });
    const record = session.record;
    session.stop();
    expect(record.value).toBe("rejected");
  });

  it("produit un enregistrement rejeté terminal (C3)", () => {
    const record = rejectedPortfolioRecord();
    expect(record.value).toBe("rejected");
    const after = sendPortfolioEvent(record, {
      type: "RISK_PROPOSED",
      productId: "AAA-USD",
      proposedGrossExposure: 1,
    });
    expect(after.value).toBe("rejected");
  });
});

describe("proposePortfolioRisk", () => {
  it("approuve puis commite l'exposition projetée du produit (INV-P1)", () => {
    const multi = multiConfiguration();
    const record = startedPortfolio(multi);
    const first = proposePortfolioRisk(record, "AAA-USD", 600);
    expect(first.decision.approved).toBe(true);
    expect(first.record.context.exposure["AAA-USD"]).toBe(600);

    const second = proposePortfolioRisk(first.record, "BBB-USD", 300);
    expect(second.decision.approved).toBe(true);
    expect(second.record.context.exposure).toEqual({
      "AAA-USD": 600,
      "BBB-USD": 300,
    });
  });

  it("rejette à la volée quand la somme consolidée dépasse le plafond", () => {
    const multi = multiConfiguration({
      portfolioRisk: { maxGrossExposure: 1_000, maxDailyLoss: 5_000 },
    });
    const record = startedPortfolio(multi);
    const first = proposePortfolioRisk(record, "AAA-USD", 600);
    expect(first.decision.approved).toBe(true);

    const second = proposePortfolioRisk(first.record, "BBB-USD", 500);
    expect(second.decision).toEqual({
      approved: false,
      reasonCode: "CONSOLIDATED_GROSS_EXPOSURE_LIMIT",
    });
    // Le socle du produit refusé est conservé (l'exposition committée
    // ne change pas) et les autres produits ne sont pas affectés.
    expect(second.record.context.exposure).toEqual({
      "AAA-USD": 600,
      "BBB-USD": 0,
    });
    expect(first.record.context.exposure["AAA-USD"]).toBe(600);
  });

  it("admise toujours une réduction d'exposition même au-delà du plafond (INV-P1)", () => {
    const multi = multiConfiguration({
      portfolioRisk: { maxGrossExposure: 1_000, maxDailyLoss: 5_000 },
    });
    let record = startedPortfolio(multi);
    record = sendPortfolioEvent(record, {
      type: "PRODUCT_EXPOSURE_REPORTED",
      productId: "AAA-USD",
      grossExposure: 900,
      dailyPnl: 0,
    });
    const reduction = proposePortfolioRisk(record, "AAA-USD", 400);
    expect(reduction.decision.approved).toBe(true);
    expect(reduction.record.context.exposure["AAA-USD"]).toBe(400);
  });

  it("rejette tout produit quand la perte quotidienne consolidée atteint le plafond (INV-P2)", () => {
    const multi = multiConfiguration({
      portfolioRisk: { maxGrossExposure: 10_000, maxDailyLoss: 1_000 },
    });
    let record = startedPortfolio(multi);
    record = sendPortfolioEvent(record, {
      type: "PRODUCT_EXPOSURE_REPORTED",
      productId: "AAA-USD",
      grossExposure: 0,
      dailyPnl: -600,
    });
    record = sendPortfolioEvent(record, {
      type: "PRODUCT_EXPOSURE_REPORTED",
      productId: "BBB-USD",
      grossExposure: 0,
      dailyPnl: -400,
    });
    const decision = proposePortfolioRisk(record, "BBB-USD", 100);
    expect(decision.decision).toEqual({
      approved: false,
      reasonCode: "CONSOLIDATED_DAILY_LOSS_LIMIT",
    });
  });
});

describe("portfolioIsEnabled (INV-P3)", () => {
  it("reste actif tant qu'un produit n'est pas terminal", () => {
    const session = validSession();
    expect(portfolioIsEnabled(session)).toBe(true);
    const oneStopped: PortfolioSessionState = {
      ...session,
      products: {
        ...session.products,
        "AAA-USD": {
          ...(session.products["AAA-USD"] as NonNullable<
            (typeof session.products)["AAA-USD"]
          >),
          machine: stoppedProductMachine(),
        },
      },
    };
    expect(portfolioIsEnabled(oneStopped)).toBe(true);
  });

  it("devient inactif quand tous les produits sont quiescents", () => {
    const session = validSession();
    const allStopped: PortfolioSessionState = {
      ...session,
      products: {
        "AAA-USD": {
          ...(session.products["AAA-USD"] as NonNullable<
            (typeof session.products)["AAA-USD"]
          >),
          machine: stoppedProductMachine(),
        },
        "BBB-USD": {
          ...(session.products["BBB-USD"] as NonNullable<
            (typeof session.products)["BBB-USD"]
          >),
          machine: stoppedProductMachine(),
        },
      },
    };
    expect(portfolioIsEnabled(allStopped)).toBe(false);
  });
});

describe("resolveRestoredPortfolioSession", () => {
  it("restaure une session valide sans perte d'état (C5)", () => {
    const session = validSession();
    const snapshot = structuredClone(session);
    const restored = resolveRestoredPortfolioSession(snapshot);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.session.portfolio.value).toBe("running");
    expect(restored.session.configuration).toEqual(session.configuration);
    expect(Object.keys(restored.session.products).sort()).toEqual([
      "AAA-USD",
      "BBB-USD",
    ]);
    // Mêmes décisions après restauration : rejeu déterministe (INV-P4).
    const before = proposePortfolioRisk(session.portfolio, "AAA-USD", 600);
    const after = proposePortfolioRisk(
      restored.session.portfolio,
      "AAA-USD",
      600,
    );
    expect(after.decision).toEqual(before.decision);
  });

  it("refuse un instantané corrompu (C3)", () => {
    const cases: unknown[] = [];
    const nanExposure = structuredClone(validSession());
    (nanExposure.portfolio.context.exposure as Record<string, number>)[
      "AAA-USD"
    ] = Number.NaN;
    cases.push(nanExposure);

    const unknownStatus = structuredClone(validSession());
    (unknownStatus.portfolio.context.statuses as Record<string, string>)[
      "ZZZ-USD"
    ] = "running";
    cases.push(unknownStatus);

    const invalidStatus = structuredClone(validSession());
    (invalidStatus.portfolio.context.statuses as Record<string, string>)[
      "AAA-USD"
    ] = "paused";
    cases.push(invalidStatus);

    const unknownPhase = structuredClone(validSession());
    (
      unknownPhase.portfolio as unknown as { value: string }
    ).value = "bogus";
    cases.push(unknownPhase);

    const missingProduct = structuredClone(validSession());
    delete (missingProduct.products as Record<string, unknown>)["BBB-USD"];
    cases.push(missingProduct);

    const extraProduct = structuredClone(validSession());
    (extraProduct.products as Record<string, unknown>)["ZZZ-USD"] =
      missingProduct.products["AAA-USD"];
    cases.push(extraProduct);

    const notPaper = structuredClone(validSession());
    (notPaper.configuration as unknown as { executionMode: string }).executionMode =
      "live";
    cases.push(notPaper);
    const singleProduct = structuredClone(validSession());
    cases.push({
      ...singleProduct,
      products: {
        "AAA-USD": singleProduct.products["AAA-USD"],
      },
      configuration: multiConfiguration({
        products: [{ productId: "AAA-USD" }],
      }),
    });

    const productsMismatch = structuredClone(validSession());
    (
      productsMismatch.portfolio.context as unknown as {
        products: string[];
      }
    ).products = ["AAA-USD"];
    cases.push(productsMismatch);

    for (const candidate of cases) {
      const restored = resolveRestoredPortfolioSession(candidate);
      expect(restored).toEqual({
        ok: false,
        reason: "INVALID_PORTFOLIO_SNAPSHOT",
      });
    }
  });

  it("refuse les entrées non structurées (C3)", () => {
    for (const candidate of [null, undefined, 42, "session", [], {}]) {
      expect(resolveRestoredPortfolioSession(candidate).ok).toBe(false);
    }
  });
});
