import { ok } from "@dodash/domain";
import { describe, expect, it, vi } from "vitest";

import type { AgentConfiguration } from "../src/configuration.js";
import type { OrderSubmission } from "../src/types.js";
import { createTradingCycleEffects } from "../src/trading-effects.js";
import type { TradingEffectsDependencies } from "../src/trading-effects.js";

const paperConfiguration: AgentConfiguration = {
  executionMode: "paper",
} as AgentConfiguration;

const liveConfiguration: AgentConfiguration = {
  executionMode: "live",
} as AgentConfiguration;

const baseEnv = {
  INTERNAL_SERVICE_TOKEN: "internal-token",
  CONTROL_API_TOKEN: "control-token",
} as TradingEffectsDependencies["env"];

const makeDependencies = (
  overrides: Partial<TradingEffectsDependencies> = {},
): TradingEffectsDependencies => ({
  configuration: paperConfiguration,
  env: baseEnv,
  agentName: "test-agent",
  ensureIntervalSchedule: vi.fn(async () => ({ time: 1234 })),
  removeIntervalSchedule: vi.fn(async () => undefined),
  checkpoint: vi.fn(async () => ok(undefined)),
  persistMachine: vi.fn(async () => undefined),
  persistOrderIntent: vi.fn(async () => ok(undefined)),
  submitPaperOrder: vi.fn(async () => ({ status: "CONFIRMED" }) as OrderSubmission),
  submitLiveOrder: vi.fn(async () => ({ status: "CONFIRMED" }) as OrderSubmission),
  submitPerpOrder: vi.fn(async () => ({ status: "CONFIRMED" }) as OrderSubmission),
  reconcilePerpOrder: vi.fn(async () =>
    ok({
      status: "CONFIRMED",
      exchangeOrderId: "perp-x",
      portfolio: { cash: 1000, positionQuantity: 2, averagePrice: 50 },
      fill: null,
    } as OrderSubmission),
  ),
  reconcilePaperOrder: vi.fn(async () => ok({ status: "CONFIRMED" } as OrderSubmission)),
  reconcileLiveOrder: vi.fn(async () => ok({ status: "CONFIRMED" } as OrderSubmission)),
  persistCycle: vi.fn(async () => ok(undefined)),
  loadKnownProtectiveOrderIds: vi.fn(() => ok([])),
  getKillContext: vi.fn(() => null),
  applyKilledAccount: vi.fn(),
  ...overrides,
});

describe("perp reconciliation", () => {
  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const perpDependencies = (
    fetchMock: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<Response>>>,
  ) => {
    const deps = makeDependencies() as TradingEffectsDependencies;
    return {
      deps: {
        ...deps,
        configuration: {
          ...deps.configuration,
          executionMode: "perp" as const,
          productId: "BTC-USD",
        },
      } as TradingEffectsDependencies,
      fetchMock,
    };
  };

  const perpEnv = {
    HYPERLIQUID_PERP_TRADING_ENABLED: "true",
    HYPERLIQUID_AGENT_PRIVATE_KEY:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    HYPERLIQUID_WALLET_ADDRESS: "0x2222222222222222222222222222222222222222",
  };

  it("carries the real accountValue into the daily anchor", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        assetPositions: [
          { position: { coin: "BTC", szi: "0.01", unrealizedPnl: "-30" } },
        ],
        marginSummary: { accountValue: "9500", totalRawUsd: "1000" },
      }),
    );
    const { deps } = perpDependencies(fetchMock);
    Object.assign(deps, { fetch: fetchMock as unknown as typeof fetch });
    Object.assign(deps.env as object, perpEnv);
    const effects = createTradingCycleEffects(deps);

    const reconciliation = await effects.reconcileAccount(
      { cash: 10_000, positionQuantity: 0, averagePrice: 0 },
      42,
    );

    expect(reconciliation).toEqual({
      ok: true,
      value: {
        snapshotId: "perp:test-agent:42",
        observedAt: 42,
        portfolio: { cash: 10_000, positionQuantity: 0, averagePrice: 0 },
        accountEquity: 9500,
        otherExposureNotional: 1000,
      },
    });
  });

  it("fails closed without retry when the account is unreadable", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ assetPositions: "nope" }),
    );
    const { deps } = perpDependencies(fetchMock);
    Object.assign(deps, { fetch: fetchMock as unknown as typeof fetch });
    Object.assign(deps.env as object, perpEnv);
    const effects = createTradingCycleEffects(deps);

    const reconciliation = await effects.reconcileAccount(
      { cash: 10_000, positionQuantity: 0, averagePrice: 0 },
      42,
    );

    expect(reconciliation.ok).toBe(false);
    if (!reconciliation.ok) {
      expect(reconciliation.error.retryable).toBe(false);
    }
  });
});

describe("createTradingCycleEffects", () => {
  it("reconciles the paper account from portfolio equity", async () => {
    const deps = makeDependencies();
    const effects = createTradingCycleEffects(deps);
    const portfolio = {
      cash: 1000,
      positionQuantity: 2,
      averagePrice: 50,
    };

    const reconciliation = await effects.reconcileAccount(
      portfolio as never,
      42,
    );

    expect(reconciliation).toEqual({
      ok: true,
      value: {
        snapshotId: "paper:test-agent:42",
        observedAt: 42,
        portfolio,
        accountEquity: 1100,
        otherExposureNotional: 0,
      },
    });
  });

  it("maps the interval schedule to the next wake timestamp", async () => {
    const deps = makeDependencies();
    const effects = createTradingCycleEffects(deps);

    const schedule = await effects.ensureSchedule(30);

    expect(schedule).toEqual({ ok: true, value: { nextWakeAt: 1234 } });
    expect(deps.ensureIntervalSchedule).toHaveBeenCalledWith(30);
  });

  it("reports schedule failures as retryable workflow errors", async () => {
    const deps = makeDependencies({
      ensureIntervalSchedule: vi.fn(async () => {
        throw new Error("alarm unavailable");
      }),
    });
    const effects = createTradingCycleEffects(deps);

    const schedule = await effects.ensureSchedule(30);

    expect(schedule).toEqual({
      ok: false,
      error: {
        phase: "schedule",
        code: "SCHEDULE_FAILURE",
        retryable: true,
      },
    });
  });

  it("issues a short-lived paper authorization", async () => {
    const effects = createTradingCycleEffects(makeDependencies());
    const before = Date.now();

    const authorization = await effects.authorize({
      side: "BUY",
    } as never);

    expect(authorization.ok).toBe(true);
    if (authorization.ok) {
      expect(authorization.value.issuedAt).toBeGreaterThanOrEqual(before);
      expect(authorization.value.expiresAt).toBe(
        authorization.value.issuedAt + 60_000,
      );
    }
  });

  it("routes order submission to the paper executor", async () => {
    const deps = makeDependencies();
    const effects = createTradingCycleEffects(deps);

    const submission = await effects.submitOrder(
      { side: "BUY" } as never,
      { status: "APPROVED" } as never,
      { issuedAt: 1, expiresAt: 2 } as never,
      100,
      { cash: 1, positionQuantity: 0, averagePrice: 0 } as never,
      7,
    );

    expect(submission).toEqual({ status: "CONFIRMED" });
    expect(deps.submitPaperOrder).toHaveBeenCalledTimes(1);
    expect(deps.submitLiveOrder).not.toHaveBeenCalled();
  });

  it("cancels without a kill switch outside live mode", async () => {
    const deps = makeDependencies();
    const effects = createTradingCycleEffects(deps);

    const cancelled = await effects.cancelCurrentEffect("kill-switch");

    expect(cancelled).toEqual({ ok: true, value: undefined });
    expect(deps.removeIntervalSchedule).toHaveBeenCalledTimes(1);
    expect(deps.getKillContext).not.toHaveBeenCalled();
    expect(deps.applyKilledAccount).not.toHaveBeenCalled();
  });

  it("rejects live reconciliation and authorization when Coinbase settings are unavailable", async () => {
    const deps = makeDependencies({ configuration: liveConfiguration });
    const effects = createTradingCycleEffects(deps);

    const reconciliation = await effects.reconcileAccount(
      { cash: 0, positionQuantity: 0, averagePrice: 0 } as never,
      1,
    );
    const authorization = await effects.authorize({ side: "BUY" } as never);
    const submission = await effects.submitOrder(
      { side: "BUY" } as never,
      { status: "APPROVED" } as never,
      { issuedAt: 1, expiresAt: 2 } as never,
      100,
      { cash: 0, positionQuantity: 0, averagePrice: 0 } as never,
      1,
    );

    expect(reconciliation).toEqual({
      ok: false,
      error: {
        phase: "reconciliation",
        code: "RECONCILIATION_FAILURE",
        retryable: false,
      },
    });
    expect(authorization).toEqual({
      ok: false,
      error: {
        phase: "authorization",
        code: "AUTHENTICATION_FAILURE",
        retryable: false,
      },
    });
    expect(submission).toEqual({
      status: "REJECTED",
      error: {
        phase: "authorization",
        code: "AUTHENTICATION_FAILURE",
        retryable: false,
      },
    });
  });
});
