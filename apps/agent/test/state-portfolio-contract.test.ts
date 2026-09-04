import {
  projectDashboardPortfolioSummary,
  type DashboardPortfolioLastCycle,
  type DashboardPortfolioProductInput,
} from "@dodash/models";
import { describe, expect, it } from "vitest";

import { parseMultiProductAgentConfiguration } from "../src/configuration.js";
import { createTradingMachineSession } from "../src/machine-session.js";
import {
  createPortfolioMachineSession,
  initialProductRuntime,
  projectPortfolioSessionSummary,
  resolveRestoredPortfolioSession,
  type PortfolioSessionState,
} from "../src/portfolio-runtime.js";
import {
  INITIAL_AGENT_STATE,
  toAgentStateSnapshot,
  type TradingAgentState,
} from "../src/state.js";

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

const multiConfiguration = () => {
  const result = parseMultiProductAgentConfiguration({
    ...shared,
    products: [
      { productId: "AAA-USD", risk: riskProfile },
      { productId: "BBB-USD", risk: riskProfile },
    ],
    portfolioRisk: { maxGrossExposure: 10_000, maxDailyLoss: 5_000 },
  });
  if (!result.ok) throw new Error("invalid multi-product fixture");
  return result.value;
};

const productMachine = (phase: "waiting" | "stopped") => {
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
  if (phase === "stopped") {
    session.send({
      type: "STOP_REQUESTED",
      permissions: { canControl: true, canTrade: true },
    });
    session.send({ type: "EFFECT_CANCELLED" });
    session.send({ type: "PERSIST_SUCCEEDED" });
  }
  const record = session.record;
  session.stop();
  return record;
};

const startedPortfolio = (products: readonly string[]) => {
  const session = createPortfolioMachineSession({
    products,
    limits: { maxGrossExposure: 10_000, maxDailyLoss: 5_000 },
  });
  session.send({ type: "PORTFOLIO_STARTED" });
  const record = session.record;
  session.stop();
  return record;
};

const sessionFixture = (): PortfolioSessionState => {
  const multi = multiConfiguration();
  const aaa = initialProductRuntime(productMachine("waiting"), multi.initialCapital);
  const bbb = initialProductRuntime(productMachine("stopped"), multi.initialCapital);
  return {
    configuration: multi,
    portfolio: startedPortfolio(["AAA-USD", "BBB-USD"]),
    products: {
      "AAA-USD": {
        ...aaa,
        portfolio: { cash: 9_800, positionQuantity: 0.1, averagePrice: 60_000 },
        dailyPnl: 42.5,
        lastCycle: {
          cycleId: "cycle-aaa",
          triggeredAt: 300_000,
          completedAt: 306_000,
          outcome: "ORDER_CONFIRMED",
          marketPrice: 62_000,
          signalCount: 1,
          clientOrderId: "cli-aaa",
          exchangeOrderId: "ex-aaa",
          error: null,
        },
      },
      "BBB-USD": { ...bbb, dailyPnl: -12.25 },
    },
  };
};

const agentWithSession = (
  session: PortfolioSessionState | null,
): TradingAgentState => ({
  ...INITIAL_AGENT_STATE,
  updatedAt: 1_000,
  portfolioSession: session,
});

describe("contrat /state — hiérarchie portefeuille (dao #34)", () => {
  it("expose la hiérarchie avec les chiffres exacts de la projection #32 (ST5)", () => {
    const session = sessionFixture();
    const state = agentWithSession(session);
    const snapshot = toAgentStateSnapshot(
      state,
      projectPortfolioSessionSummary(session),
    );

    // Surface de contrôle : projection #32 construite à la main depuis les
    // mêmes faits — les chiffres de /state doivent être identiques.
    const products: DashboardPortfolioProductInput[] = [
      {
        productId: "AAA-USD",
        phase: "waiting",
        status: "running",
        cash: 9_800,
        positionQuantity: 0.1,
        averagePrice: 60_000,
        dailyPnl: 42.5,
        maxGrossExposure: 20_000,
        lastCycle: {
          cycleId: "cycle-aaa",
          triggeredAt: 300_000,
          completedAt: 306_000,
          outcome: "ORDER_CONFIRMED",
          marketPrice: 62_000,
        },
      },
      {
        productId: "BBB-USD",
        phase: "stopped",
        status: "running",
        cash: 10_000,
        positionQuantity: 0,
        averagePrice: 0,
        dailyPnl: -12.25,
        maxGrossExposure: 20_000,
        lastCycle: null,
      },
    ];
    const expected = projectDashboardPortfolioSummary({
      phase: "running",
      killSwitchActive: false,
      portfolioRisk: { maxGrossExposure: 10_000, maxDailyLoss: 5_000 },
      products,
    });
    expect(snapshot.portfolioSummary).toEqual(expected);
    expect(snapshot.portfolioSummary).toEqual(
      projectPortfolioSessionSummary(session),
    );
    if (!snapshot.portfolioSummary.ok || snapshot.portfolioSummary.value.kind !== "portfolio") {
      throw new Error("expected a portfolio hierarchy");
    }
    const { value } = snapshot.portfolioSummary;
    expect(value.consolidated.grossExposure).toBe(6_200);
    expect(value.consolidated.dailyPnl).toBeCloseTo(30.25, 10);
    // Produits présentés en productId trié, produits quiescents visibles.
    expect(value.products.map((p) => p.productId)).toEqual(["AAA-USD", "BBB-USD"]);
    expect(value.products[1]?.phase).toBe("stopped");
  });

  it("laisse la forme mono-produit inchangée — champ additionnel uniquement (ST2, C1)", () => {
    const snapshot = toAgentStateSnapshot(INITIAL_AGENT_STATE, {
      ok: true,
      value: { kind: "single-product" },
    });
    expect(snapshot).toEqual({
      ...INITIAL_AGENT_STATE,
      portfolioSummary: { ok: true, value: { kind: "single-product" } },
    });
    const { portfolioSummary, ...frozenFields } = snapshot;
    expect(frozenFields).toEqual(INITIAL_AGENT_STATE);
    // Mono-produit : hiérarchie vide valide, pas une erreur (§3.1 de #32).
    expect(portfolioSummary).toEqual({
      ok: true,
      value: { kind: "single-product" },
    });
  });

  it("reflète une session restaurée fail-closed dans /state (ST6)", () => {
    const session = sessionFixture();
    // Persistance simulée : rond-trip JSON, puis restauration du même
    // pipeline que le Durable Object (C3 de #28).
    const restored = resolveRestoredPortfolioSession(
      JSON.parse(JSON.stringify(session)),
    );
    if (!restored.ok) throw new Error("expected a restorable session");
    const state = agentWithSession(restored.session);
    const snapshot = toAgentStateSnapshot(
      state,
      projectPortfolioSessionSummary(restored.session),
    );
    if (!snapshot.portfolioSummary.ok) throw new Error("expected ok projection");
    const value = snapshot.portfolioSummary.value;
    if (value.kind !== "portfolio") throw new Error("expected portfolio kind");
    expect(value.phase).toBe("running");
    expect(value.products.map((p) => [p.productId, p.phase])).toEqual([
      ["AAA-USD", "waiting"],
      ["BBB-USD", "stopped"],
    ]);
    // Restauration refusée ⇒ portfolioSession reste null ⇒ single-product.
    const refused = resolveRestoredPortfolioSession({ configuration: null });
    expect(refused.ok).toBe(false);
    expect(
      projectPortfolioSessionSummary(null),
    ).toEqual({ ok: true, value: { kind: "single-product" } });
  });

  it("répond par un échec local fermé sur un snapshot incohérent (ST4)", () => {
    const basePhase = sessionFixture();
    const aaa = basePhase.products["AAA-USD"];
    if (aaa === undefined) throw new Error("missing fixture product");
    const incoherentPhase: PortfolioSessionState = {
      ...basePhase,
      products: {
        ...basePhase.products,
        "AAA-USD": { ...aaa, machine: { ...aaa.machine, value: "bogus-phase" } },
      },
    };
    const phaseFailure = projectPortfolioSessionSummary(incoherentPhase);
    expect(phaseFailure).toEqual({
      ok: false,
      error: { code: "INVALID_PORTFOLIO_SESSION" },
    });

    const baseFacts = sessionFixture();
    const bbb = baseFacts.products["BBB-USD"];
    if (bbb === undefined) throw new Error("missing fixture product");
    const incoherentFacts: PortfolioSessionState = {
      ...baseFacts,
      products: {
        ...baseFacts.products,
        "BBB-USD": { ...bbb, dailyPnl: Number.NaN },
      },
    };
    expect(projectPortfolioSessionSummary(incoherentFacts)).toEqual({
      ok: false,
      error: { code: "INVALID_PRODUCT_FACTS" },
    });

    // Créneau configuré sans runtime : échec fermé du seam, jamais un
    // produit omis (C3).
    const baseRuntime = sessionFixture();
    const onlyAaa = baseRuntime.products["AAA-USD"];
    if (onlyAaa === undefined) throw new Error("missing fixture product");
    const missingRuntime: PortfolioSessionState = {
      ...baseRuntime,
      products: { "AAA-USD": onlyAaa },
    };
    expect(projectPortfolioSessionSummary(missingRuntime)).toEqual({
      ok: false,
      error: { code: "INVALID_PORTFOLIO_SESSION" },
    });

    // L'échec reste local au champ : le snapshot n'embarque aucune
    // hiérarchie partielle et l'état figé reste servi tel quel (ST4, C1).
    const state = agentWithSession(incoherentPhase);
    const snapshot = toAgentStateSnapshot(state, phaseFailure);
    expect(snapshot.portfolioSummary).toEqual(phaseFailure);
    expect(snapshot.updatedAt).toBe(state.updatedAt);
    expect(snapshot.portfolioSession).toBe(state.portfolioSession);
  });

  it("n'expose aucun identifiant d'ordre ni erreur interne dans le champ ajouté (ST3, C2)", () => {
    const session = sessionFixture();
    const summary = projectPortfolioSessionSummary(session);
    if (!summary.ok || summary.value.kind !== "portfolio") {
      throw new Error("expected a portfolio hierarchy");
    }
    const serialized = JSON.stringify(summary.value);
    expect(serialized).not.toContain("clientOrderId");
    expect(serialized).not.toContain("exchangeOrderId");
    expect(serialized).not.toContain('"error"');
    const lastCycle: DashboardPortfolioLastCycle | null =
      summary.value.products[0]?.lastCycle ?? null;
    expect(Object.keys(lastCycle ?? {}).sort()).toEqual(
      [
        "completedAt",
        "cycleId",
        "marketPrice",
        "outcome",
        "triggeredAt",
      ].sort(),
    );
  });
});
