import { ok } from "@dodash/domain";
import { describe, expect, it, vi } from "vitest";
import { parseAgentConfiguration, parseMultiProductAgentConfiguration } from "../src/configuration.js";
import { createPortfolioMachineSession, initialProductRuntime } from "../src/portfolio-runtime.js";
import { createTradingMachineSession } from "../src/machine-session.js";
import { INITIAL_AGENT_STATE, type TradingAgentState } from "../src/state.js";
import { TradingAgent } from "../src/trading-agent.js";
import type { CycleArtifacts, TradingCycleEffects } from "../src/types.js";
import type { TradingTelemetrySink } from "../src/telemetry.js";

// Only the Cloudflare SDK boundary is replaced; shell and interpreter are real.
vi.mock("agents", () => ({ Agent: class {} }));

const CLOSE = 6_000_000;
const pendingCycle = () => {
  const session = createTradingMachineSession({ agentId: "paper", strategyIds: ["rsi-reversion"] });
  session.send({ type: "START_REQUESTED", permissions: { canControl: true, canTrade: true } });
  session.send({ type: "SCHEDULE_SUCCEEDED", nextWakeAt: CLOSE + 1_000 });
  session.send({ type: "ALARM_FIRED", cycleId: "cycle-old", triggeredAt: CLOSE + 1_000 });
  session.send({ type: "ACCOUNT_RECONCILED", snapshotId: "account" });
  session.send({ type: "MARKET_DATA_FAILED", error: { phase: "market-data", code: "RATE_LIMITED", retryable: true } });
  const machine = session.record;
  session.stop();
  return machine;
};

describe("TradingAgent grid wake continuation", () => {
  it.each([
    { sameCandle: true, portfolio: false, expired: false, grid: true },
    { sameCandle: false, portfolio: false, expired: false, grid: true },
    { sameCandle: true, portfolio: true, expired: false, grid: true },
    { sameCandle: false, portfolio: true, expired: false, grid: true },
    { sameCandle: false, portfolio: false, expired: true, grid: true },
    { sameCandle: false, portfolio: true, expired: true, grid: true },
    { sameCandle: true, portfolio: false, expired: false, grid: false },
    { sameCandle: true, portfolio: true, expired: false, grid: false },
  ])("routes cycles (same: $sameCandle, portfolio: $portfolio, expired: $expired, grid: $grid)", async ({ sameCandle, portfolio, expired, grid }) => {
    const now = CLOSE + (expired ? 121_000 : 61_000);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const parsed = parseAgentConfiguration({ productId: "BTC-USD", candleLimit: 100 });
      if (!parsed.ok) throw new Error("invalid configuration");
      const configuration = parsed.value;
      const multi = parseMultiProductAgentConfiguration({
        products: [{ productId: "BTC-USD" }, { productId: "ETH-USD" }], candleLimit: 100,
        portfolioRisk: { maxGrossExposure: 20_000, maxDailyLoss: 2_000 },
      });
      if (!multi.ok) throw new Error("invalid portfolio configuration");
      const orchestrator = createPortfolioMachineSession({ products: ["BTC-USD", "ETH-USD"], limits: { maxGrossExposure: 20_000, maxDailyLoss: 2_000 } });
      orchestrator.send({ type: "PORTFOLIO_STARTED" });
      const untouched = initialProductRuntime(pendingCycle(), 10_000);
      const portfolioSession = {
        configuration: multi.value, portfolio: orchestrator.record,
        products: { "BTC-USD": initialProductRuntime(pendingCycle(), 10_000), "ETH-USD": untouched },
      };
      orchestrator.stop();
      const artifacts: CycleArtifacts = {
        cycleId: "cycle-old", triggeredAt: CLOSE + 1_000,
        marketRetry: { attempt: 1, nextRetryAt: CLOSE + 61_000, deadlineAt: CLOSE + 90_000, errorCode: "RATE_LIMITED" },
      };
      const persisted: string[] = [];
      const published: string[] = [];
      const trace: string[] = [];
      const orders = vi.fn();
      const fetchMarketData = vi.fn<TradingCycleEffects["fetchMarketData"]>(async (_config, at) => {
        const close = sameCandle ? CLOSE : Math.floor(at / 60_000) * 60_000;
        return ok({
          productId: configuration.productId, timeframe: configuration.timeframe,
          candles: Array.from({ length: 100 }, (_, index) => ({
            start: close - (100 - index) * 60_000,
            open: 10, high: 11, low: 9, close: 10, volume: 10,
          })), source: "coinbase", cached: false,
        });
      });
      const effects: TradingCycleEffects = {
        reconcileAccount: async (portfolio, observedAt) => ok({ snapshotId: "account", observedAt, portfolio, accountEquity: portfolio.cash, otherExposureNotional: 0 }),
        fetchMarketData,
        ensureSchedule: async () => ok({ nextWakeAt: CLOSE + 120_000 }),
        checkpoint: async () => ok(undefined), persistMachine: async () => undefined,
        persistOrderIntent: async () => { orders(); return ok(undefined); },
        authorize: async () => ok({ issuedAt: CLOSE, expiresAt: CLOSE + 120_000 }),
        submitOrder: async () => { throw new Error("unexpected order"); },
        reconcileOrder: async () => { throw new Error("unexpected reconciliation"); },
        cancelCurrentEffect: async () => ok(undefined),
        persistCycle: async (value) => {
          persisted.push(value?.cycleId ?? "missing");
          trace.push(`persist:${value?.cycleId}`);
          return ok(undefined);
        },
      };
      const sink = { writeDataPoint: vi.fn<TradingTelemetrySink["writeDataPoint"]>() };
      const agent = Object.assign(Object.create(TradingAgent.prototype), {
        name: "paper", env: { TRADING_TELEMETRY: sink },
        state: { ...INITIAL_AGENT_STATE, configuration, machine: pendingCycle(), enabled: true,
          portfolioSession: portfolio ? portfolioSession : null,
        } as TradingAgentState,
        setState(next: TradingAgentState) { this.state = next; },
        loadArtifacts: () => artifacts,
        createEffects: () => effects,
        createProductEffects: () => effects,
        reportProductExposureFromState: () => undefined,
        getPortfolioSummary: () => ({ ok: false }),
        toCycleSummary: (value: CycleArtifacts | null) => { published.push(value?.cycleId ?? "missing"); return null; },
        emitOperatorSideEffects: (kind: string) => { if (kind === "decision") trace.push("missed"); },
      }) as {
        state: TradingAgentState;
        runCurrent(triggerAlarm: boolean): Promise<void>;
        runProductCycle(session: typeof portfolioSession, productId: string, triggerAlarm: boolean): Promise<void>;
      };
      if (portfolio) await agent.runProductCycle(portfolioSession, "BTC-USD", grid);
      else await agent.runCurrent(grid);
      expect(persisted).toHaveLength(grid ? 2 : 1);
      expect(persisted[0]).toBe("cycle-old");
      if (grid) expect(persisted[1]).not.toBe("cycle-old");
      expect(published).toEqual(persisted);
      expect(fetchMarketData).toHaveBeenCalledTimes(expired ? 4 : grid ? 2 : 1);
      const machine = portfolio ? agent.state.portfolioSession?.products["BTC-USD"]?.machine : agent.state.machine;
      expect(machine?.context.lastError?.code).not.toBe("DUPLICATE_ALARM");
      expect(machine?.context.triggeredAt).toBe(grid ? now : CLOSE + 1_000);
      expect(machine?.context.lastDecisionCandleClosedAt).toBe(sameCandle ? CLOSE : Math.floor(now / 60_000) * 60_000);
      if (sameCandle && grid) expect(machine?.context.indicatorsId).toBeNull();
      if (expired) {
        expect(trace.filter((value) => value === "missed")).toHaveLength(1);
        expect(trace.indexOf("missed")).toBeLessThan(trace.indexOf(`persist:${persisted[1]}`));
      }
      if (portfolio) expect(agent.state.portfolioSession?.products["ETH-USD"]).toBe(untouched);
      const points = sink.writeDataPoint.mock.calls.map(([point]) => point);
      const cycles = points.filter((point) => point.blobs[0] === "cycle.completed");
      expect(cycles).toHaveLength(grid ? 2 : 1);
      expect(cycles[0]?.blobs[10]).toBe("cycle-old");
      expect(cycles[0]?.blobs[11]).toBe(String(CLOSE + 1_000));
      expect(cycles[0]?.blobs[12]).toBe(expired ? "UNOBSERVED" : "ADMITTED");
      if (!expired) expect(cycles[0]?.doubles.slice(18)).toEqual([CLOSE, now]);
      if (grid) {
        expect(cycles[1]?.blobs[10]).toBe(persisted[1]);
        expect(cycles[1]?.blobs[12]).toBe(sameCandle ? "UNOBSERVED" : "ADMITTED");
      }
      if (expired) {
        const missed = points.find((point) => point.blobs[0] === "decision.missed");
        expect(missed?.blobs[12]).toBe("MISSED");
        expect(missed?.doubles.slice(18)).toEqual([CLOSE, 0]);
      }
      expect(cycles.every((point) => point.doubles.length === 20)).toBe(true);
      expect(orders).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});
