import type { ControlPermissions } from "@dodash/models";
import { describe, expect, it, vi } from "vitest";

import { parseMultiProductAgentConfiguration } from "../src/configuration.js";
import { createTradingMachineSession } from "../src/machine-session.js";
import {
  createPortfolioMachineSession,
  initialProductRuntime,
  projectDurablePaperBook,
  type PortfolioSessionState,
} from "../src/portfolio-runtime.js";
import { INITIAL_AGENT_STATE, type TradingAgentState } from "../src/state.js";
import { TradingAgent } from "../src/trading-agent.js";

vi.mock("agents", () => ({ Agent: class {} }));

const permissions: ControlPermissions = { canControl: true, canTrade: true };

const multi = () => {
  const parsed = parseMultiProductAgentConfiguration({
    products: [{ productId: "BTC-USD" }, { productId: "ETH-USD" }],
    portfolioRisk: { maxGrossExposure: 20_000, maxDailyLoss: 1_000 },
    initialCapital: 10_000,
  });
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
};

const stoppedMachine = (lastDecisionCandleClosedAt: number | null = null) => {
  const session = createTradingMachineSession({
    agentId: "btc-usd-paper",
    strategyIds: ["breakout", "ema-cross", "rsi-reversion"],
    maxMarketStalenessMs: 7_200_000,
    ...(lastDecisionCandleClosedAt === null ? {} : { lastDecisionCandleClosedAt }),
  });
  const record = session.record;
  session.stop();
  return record;
};

const openSession = (): PortfolioSessionState => {
  const configuration = multi();
  const orchestrator = createPortfolioMachineSession({
    products: configuration.products.map((slot) => slot.productId),
    limits: configuration.portfolioRisk ?? { maxGrossExposure: 20_000, maxDailyLoss: 1_000 },
  });
  orchestrator.send({ type: "PORTFOLIO_STARTED" });
  const portfolio = orchestrator.record;
  orchestrator.stop();
  const btc = initialProductRuntime(stoppedMachine(1_762_560_000_000), configuration.initialCapital);
  const eth = initialProductRuntime(stoppedMachine(1_762_560_000_000), configuration.initialCapital);
  return {
    configuration,
    portfolio,
    products: {
      "BTC-USD": {
        ...btc,
        portfolio: { cash: 11_050, positionQuantity: 0.1288, averagePrice: 84_200 },
      },
      "ETH-USD": {
        ...eth,
        portfolio: { cash: 10_050, positionQuantity: 4.4347, averagePrice: 2_450 },
      },
    },
  };
};

const startBody = () => ({
  products: [{ productId: "BTC-USD" }, { productId: "ETH-USD" }],
  portfolioRisk: { maxGrossExposure: 20_000, maxDailyLoss: 1_000 },
  initialCapital: 10_000,
});

type Shell = {
  state: TradingAgentState;
  onStart(): Promise<void>;
  startPortfolioAgent(
    input: unknown,
    permissions: ControlPermissions,
  ): Promise<{ ok: boolean; error?: { code: string } }>;
  resetPortfolioAgent(
    permissions: ControlPermissions,
  ): Promise<{ ok: boolean; error?: { code: string } }>;
  scheduledTick(): Promise<void>;
};

const shell = (
  state: TradingAgentState,
  rows: () => readonly { session_json: string; book_json: string }[],
): Shell =>
  Object.assign(Object.create(TradingAgent.prototype), {
    name: "btc-usd-paper",
    state,
    env: {},
    setState(next: TradingAgentState) {
      this.state = next;
    },
    ensureTradingPersistenceSchema() {},
    sql(strings: TemplateStringsArray) {
      return strings.join(" ").includes("SELECT") ? rows() : [];
    },
    runPortfolio: async () => undefined,
    cancelSchedule: async () => undefined,
    ensureIntervalSchedule: async () => ({ id: "schedule", intervalSeconds: 3600 }),
  }) as Shell;

const quantities = (state: TradingAgentState) =>
  ["BTC-USD", "ETH-USD"].map((productId) => ({
    productId,
    cash: state.portfolioSession?.products[productId]?.portfolio.cash,
    positionQuantity: state.portfolioSession?.products[productId]?.portfolio.positionQuantity,
  }));

describe("paper book survives deploy and restart", () => {
  it("reloads balances and positions when the state blob was reset to the initial agent state", async () => {
    const session = openSession();
    const agent = shell(INITIAL_AGENT_STATE, () => [
      {
        session_json: JSON.stringify(session),
        book_json: JSON.stringify(projectDurablePaperBook(session)),
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await agent.onStart();
      expect(quantities(agent.state)).toEqual([
        { productId: "BTC-USD", cash: 11_050, positionQuantity: 0.1288 },
        { productId: "ETH-USD", cash: 10_050, positionQuantity: 4.4347 },
      ]);
      expect(log.mock.calls.some((call) => String(call[0]).includes("portfolio.reset"))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it("keeps the book when trading is started again and does not emit a reset", async () => {
    const session = openSession();
    const agent = shell(
      { ...INITIAL_AGENT_STATE, portfolioSession: session, enabled: false },
      () => [],
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const result = await agent.startPortfolioAgent(startBody(), permissions);
      expect(result.ok).toBe(true);
      expect(quantities(agent.state)).toEqual([
        { productId: "BTC-USD", cash: 11_050, positionQuantity: 0.1288 },
        { productId: "ETH-USD", cash: 10_050, positionQuantity: 4.4347 },
      ]);
      expect(
        agent.state.portfolioSession?.products["BTC-USD"]?.machine.context.lastDecisionCandleClosedAt,
      ).toBe(1_762_560_000_000);
      expect(log.mock.calls.some((call) => String(call[0]).includes("portfolio.reset"))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it("overlays the durable book when the session JSON is gone but the book row remains", async () => {
    const session = openSession();
    const agent = shell(INITIAL_AGENT_STATE, () => [
      { session_json: "{}", book_json: JSON.stringify(projectDurablePaperBook(session)) },
    ]);
    const result = await agent.startPortfolioAgent(startBody(), permissions);
    expect(result.ok).toBe(true);
    expect(quantities(agent.state)).toEqual([
      { productId: "BTC-USD", cash: 11_050, positionQuantity: 0.1288 },
      { productId: "ETH-USD", cash: 10_050, positionQuantity: 4.4347 },
    ]);
  });

  it("resets balances and positions only on the explicit reset command", async () => {
    const session = openSession();
    const agent = shell(
      { ...INITIAL_AGENT_STATE, portfolioSession: session, enabled: false },
      () => [],
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const result = await agent.resetPortfolioAgent(permissions);
      expect(result.ok).toBe(true);
      expect(quantities(agent.state)).toEqual([
        { productId: "BTC-USD", cash: 10_000, positionQuantity: 0 },
        { productId: "ETH-USD", cash: 10_000, positionQuantity: 0 },
      ]);
      expect(agent.state.paperBookUnlocked).toBe(true);
      const line = log.mock.calls.map((call) => String(call[0])).find((entry) => entry.includes("portfolio.reset"));
      expect(line).toBeDefined();
      const audit = JSON.parse(line ?? "{}") as {
        event: string;
        explicit: boolean;
        before: { positionQuantity: number }[];
      };
      expect(audit).toMatchObject({ event: "portfolio.reset", explicit: true });
      expect(audit.before.map((position) => position.positionQuantity)).toEqual([0.1288, 4.4347]);
    } finally {
      log.mockRestore();
    }
  });

  it("refuses reset while a sleeve is still active and leaves the book untouched", async () => {
    const session = openSession();
    const waiting = createTradingMachineSession({
      agentId: "btc-usd-paper",
      strategyIds: ["rsi-reversion"],
      maxMarketStalenessMs: 90_000,
    });
    waiting.send({ type: "START_REQUESTED", permissions });
    waiting.send({ type: "SCHEDULE_SUCCEEDED", nextWakeAt: 3_600_000 });
    const active = waiting.record;
    waiting.stop();
    const btc = session.products["BTC-USD"];
    if (btc === undefined) throw new Error("missing BTC sleeve");
    const activeSession: PortfolioSessionState = {
      ...session,
      products: { ...session.products, "BTC-USD": { ...btc, machine: active } },
    };
    const agent = shell(
      { ...INITIAL_AGENT_STATE, portfolioSession: activeSession, enabled: true },
      () => [],
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const result = await agent.resetPortfolioAgent(permissions);
      expect(result).toEqual({ ok: false, error: { code: "INVALID_STATE" } });
      expect(agent.state.portfolioSession?.products["BTC-USD"]?.portfolio.positionQuantity).toBe(0.1288);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("keeps the book and disarms trading when the stored machine cannot be restored", async () => {
    const session = openSession();
    const btc = session.products["BTC-USD"];
    if (btc === undefined) throw new Error("missing BTC sleeve");
    const broken: PortfolioSessionState = {
      ...session,
      products: {
        ...session.products,
        "BTC-USD": { ...btc, machine: { ...btc.machine, value: "not-a-phase" } },
      },
    };
    const agent = shell(
      {
        ...INITIAL_AGENT_STATE,
        portfolioSession: broken,
        enabled: true,
        portfolioRestoreError: null,
      },
      () => [],
    );
    await agent.onStart();
    expect(agent.state.portfolioRestoreError).toBe("INVALID_PORTFOLIO_SNAPSHOT");
    expect(agent.state.enabled).toBe(false);
    expect(agent.state.portfolioSession?.products["ETH-USD"]?.portfolio.positionQuantity).toBe(4.4347);
    expect(agent.state.portfolioSession?.products["BTC-USD"]?.portfolio.positionQuantity).toBe(0.1288);
  });

  it("does not run a grid wake while restoration is refused", async () => {
    let ran = false;
    const agent = shell(
      {
        ...INITIAL_AGENT_STATE,
        portfolioSession: openSession(),
        portfolioRestoreError: "INVALID_PORTFOLIO_SNAPSHOT",
        enabled: false,
      },
      () => [],
    );
    (agent as unknown as { runPortfolio: () => void }).runPortfolio = () => {
      ran = true;
    };
    await agent.scheduledTick();
    expect(ran).toBe(false);
  });
});
