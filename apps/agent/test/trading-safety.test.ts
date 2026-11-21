import {
	createOrderIntent,
	ok,
	type Candle,
	type OrderIntent,
} from "@dodash/domain";
import type { IndicatorSnapshot } from "@dodash/indicators-prolog";
import {
	executePaperOrder,
	type PaperPortfolio,
} from "@dodash/paper-execution";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseAgentConfiguration,
	parseMultiProductAgentConfiguration,
	type AgentConfiguration,
} from "../src/configuration.js";
import { runTradingCycle } from "../src/interpreter.js";
import {
	createTradingMachineSession,
	type PersistedTradingMachine,
} from "../src/machine-session.js";
import {
	carryPaperProductRuntime,
	createPortfolioMachineSession,
	initialProductRuntime,
	proposePortfolioRisk,
} from "../src/portfolio-runtime.js";
import {
	INITIAL_AGENT_STATE,
	machineIsEnabled,
	type TradingAgentState,
} from "../src/state.js";
import { TradingAgent } from "../src/trading-agent.js";
import type {
	CycleArtifacts,
	MarketSnapshot,
	OrderSubmission,
	TradingCycleEffects,
} from "../src/types.js";

vi.mock("agents", () => ({ Agent: class {} }));

const permissions = { canControl: true, canTrade: true };
const initialTime = 6_000_001;

const configuration = (
	overrides: Record<string, unknown> = {},
): AgentConfiguration => {
	const parsed = parseAgentConfiguration({
		productId: "BTC-USD",
		strategyIds: ["rsi-reversion"],
		candleLimit: 6,
		intervalSeconds: 60,
		strategyOptions: { positionAware: true },
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
		risk: {
			maxOrderNotional: 2_000,
			maxPositionNotional: 10_000,
			maxGrossExposure: 20_000,
			maxDailyLoss: 50,
			cooldownMs: 0,
			stopLossBps: 35,
			takeProfitBps: 500,
		},
		broker: { feeBps: 0, slippageBps: 0 },
		...overrides,
	});
	if (!parsed.ok) throw new Error("invalid audit configuration");
	return parsed.value;
};

const market = (
	config: AgentConfiguration,
	at: number,
	closes: readonly number[],
	firstHigh?: number,
	firstLow?: number,
): MarketSnapshot => ({
	productId: config.productId,
	timeframe: config.timeframe,
	source: "hyperliquid",
	cached: false,
	candles: closes.map(
		(close, index): Candle => ({
			start:
				Math.floor(at / 60_000) * 60_000 - (closes.length - index) * 60_000,
			open: close,
			high: index === 0 && firstHigh !== undefined ? firstHigh : close,
			low: index === 0 && firstLow !== undefined ? firstLow : close,
			close,
			volume: 10,
		}),
	),
});

const indicators: IndicatorSnapshot = {
	snapshotId: "audit-indicators",
	candleClosedAt: initialTime - 1,
	rsi: 50,
	emaFast: 100,
	emaSlow: 100,
	macd: 0,
	atr: 0.1,
	historicalVolatility: 0.01,
	momentum: 0,
	periodicReturns: { "1": 0 },
	ohlcvVwap: null,
	tradeVwap: null,
	orderBookVwap: null,
	bidAskSpread: null,
	relativeVolume: null,
	volumeSpike: null,
	volumeTrend: null,
	vwapDeviation: null,
	trendStrength: 10,
};

const machineAt = (
	config: AgentConfiguration,
	phase: "waiting" | "allocating",
	at: number,
	cycleId: string,
) => {
	const session = createTradingMachineSession({
		agentId: "audit",
		strategyIds: config.strategyIds,
	});
	session.send({ type: "START_REQUESTED", permissions });
	session.send({ type: "SCHEDULE_SUCCEEDED", nextWakeAt: at });
	if (phase === "allocating") {
		session.send({ type: "ALARM_FIRED", cycleId, triggeredAt: at });
		session.send({ type: "ACCOUNT_RECONCILED", snapshotId: "account" });
		session.send({
			type: "MARKET_DATA_READY",
			snapshotId: "market",
			candleClosedAt: at - 1,
			evaluatedAt: at,
		});
		session.send({
			type: "INDICATORS_COMPUTED",
			indicatorsId: indicators.snapshotId,
		});
		session.send({ type: "STRATEGIES_EVALUATED", signalsId: "signals" });
	}
	const record = session.record;
	session.stop();
	expect(record.value).toBe(phase);
	return record;
};

const effectsFor = (
	config: AgentConfiguration,
	snapshot: MarketSnapshot,
): TradingCycleEffects => ({
	reconcileAccount: async (portfolio, observedAt) =>
		ok({
			snapshotId: "account",
			observedAt,
			portfolio,
			accountEquity:
				portfolio.cash + portfolio.positionQuantity * portfolio.averagePrice,
			otherExposureNotional: 0,
		}),
	fetchMarketData: async () => ok(snapshot),
	ensureSchedule: async () => ok({ nextWakeAt: initialTime + 120_000 }),
	checkpoint: async () => ok(undefined),
	persistMachine: async () => undefined,
	persistOrderIntent: async () => ok(undefined),
	authorize: async () =>
		ok({ issuedAt: initialTime, expiresAt: initialTime + 120_000 }),
	submitOrder: async (intent, _risk, _authorization, price, portfolio, at) => {
		const execution = executePaperOrder(portfolio, intent, price, at, {
			...config.broker,
			allowShort: true,
		});
		if (!execution.ok) throw new Error(execution.error.code);
		return {
			status: "CONFIRMED",
			portfolio: execution.value.portfolio,
			fill: execution.value.trade.fill,
			exchangeOrderId: execution.value.trade.fill.exchangeOrderId,
		};
	},
	reconcileOrder: async () => {
		throw new Error("unexpected reconciliation");
	},
	cancelCurrentEffect: async () => ok(undefined),
	persistCycle: async () => ok(undefined),
});

const allocateCycle = (
	config: AgentConfiguration,
	snapshot: MarketSnapshot,
	portfolio: PaperPortfolio,
	at: number,
	effects: TradingCycleEffects,
	dailyPnl = 0,
	previousMachine?: PersistedTradingMachine,
) => {
	const machine = machineAt(config, "allocating", at, `audit:${at}`);
	return runTradingCycle({
		agentId: "audit",
		configuration: config,
		machine: {
			...machine,
			context: {
				...machine.context,
				paperProtection: previousMachine?.context.paperProtection ?? null,
			},
		},
		artifacts: {
			cycleId: `audit:${at}`,
			triggeredAt: at,
			market: snapshot,
			indicators,
			signals: [],
		},
		previousIndicators: null,
		portfolio,
		dailyPnl,
		lastTradeAt: 5_000_000,
		triggeredAt: at,
		cycleId: `audit:${at}`,
		triggerAlarm: false,
		now: () => at,
		effects,
	});
};

afterEach(() => vi.restoreAllMocks());

describe("trading safety regressions", () => {
	it("allows a protective close after the consolidated daily loss limit", async () => {
		const config = configuration();
		const snapshot = market(config, initialTime, [98, 98, 98, 98, 98, 98]);
		const orchestrator = createPortfolioMachineSession({
			products: ["BTC-USD", "ETH-USD"],
			limits: { maxGrossExposure: 20_000, maxDailyLoss: 50 },
		});
		orchestrator.send({ type: "PORTFOLIO_STARTED" });
		orchestrator.send({
			type: "PRODUCT_EXPOSURE_REPORTED",
			productId: "BTC-USD",
			grossExposure: 98,
			dailyPnl: -60,
		});
		const record = orchestrator.record;
		orchestrator.stop();
		const effects = effectsFor(config, snapshot);
		const result = await allocateCycle(
			config,
			snapshot,
			{ cash: 1_000, positionQuantity: 1, averagePrice: 100 },
			initialTime,
			{
				...effects,
				proposePortfolioRisk: async (productId, proposedGrossExposure) =>
					proposePortfolioRisk(record, productId, proposedGrossExposure)
						.decision,
			},
			-60,
		);
		expect(result.artifacts?.order?.side).toBe("SELL");
		expect(result.portfolio.positionQuantity).toBe(0);
	});

	it.each([1, -1])(
		"preserves a trailing stop after the peak candle leaves the rolling window for quantity %s",
		async (quantity) => {
			const config = configuration();
			const portfolio = {
				cash: 1_000,
				positionQuantity: quantity,
				averagePrice: 100,
			};
			const heldPrice = quantity > 0 ? 100.6 : 99.39;
			const withPeak = market(
				config,
				initialTime,
				Array.from({ length: 6 }, () => heldPrice),
				quantity > 0 ? 101 : undefined,
				quantity < 0 ? 99 : undefined,
			);
			const first = await allocateCycle(
				config,
				withPeak,
				portfolio,
				initialTime,
				effectsFor(config, withPeak),
			);
			expect(first.portfolio.positionQuantity).toBe(quantity);
			const afterPeak = market(config, initialTime + 60_000, [
				...Array.from({ length: 5 }, () => heldPrice),
				quantity > 0 ? 100.4 : 99.6,
			]);
			const second = await allocateCycle(
				config,
				afterPeak,
				first.portfolio,
				initialTime + 60_000,
				effectsFor(config, afterPeak),
				0,
				first.machine,
			);
			expect(second.portfolio.positionQuantity).toBe(0);
		},
	);

	it("carries protection through stop/start and restores it until explicit reset", async () => {
		const config = configuration();
		const snapshot = market(
			config,
			initialTime,
			[100.6, 100.6, 100.6, 100.6, 100.6, 100.6],
			101,
		);
		const first = await allocateCycle(
			config,
			snapshot,
			{ cash: 1_000, positionQuantity: 1, averagePrice: 100 },
			initialTime,
			effectsFor(config, snapshot),
		);
		const carried = carryPaperProductRuntime(
			initialProductRuntime(first.machine, 1_000),
			machineAt(config, "waiting", initialTime + 60_000, "next"),
		);
		const restored = createTradingMachineSession(
			{ agentId: "audit", strategyIds: config.strategyIds },
			JSON.parse(JSON.stringify(carried.machine)),
		);
		expect(restored.context.paperProtection).toEqual(
			first.machine.context.paperProtection,
		);
		restored.send({
			type: "KILL_SWITCH_ENGAGED",
			permissions,
			controlId: "reset-protection",
		});
		restored.send({ type: "EFFECT_CANCELLED" });
		restored.send({ type: "PERSIST_SUCCEEDED" });
		expect(restored.phase).toBe("halted");
		restored.send({ type: "RESET", permissions });
		expect(restored.context.paperProtection).toBeNull();
		restored.stop();
	});

	it("includes both opening and closing short fees in realized pnl", () => {
		const config = configuration();
		const intent = (side: "BUY" | "SELL"): OrderIntent => {
			const result = createOrderIntent({
				clientOrderId: `short-${side}`,
				decisionId: "short-audit",
				strategyIds: ["rsi-reversion"],
				productId: config.productId,
				side,
				type: "MARKET",
				quantity: 2,
				limitPrice: null,
			});
			if (!result.ok) throw new Error("invalid intent");
			return result.value;
		};
		const broker = { allowShort: true, feeBps: 10, slippageBps: 0 };
		const opened = executePaperOrder(
			{ cash: 1_000, positionQuantity: 0, averagePrice: 0 },
			intent("SELL"),
			100,
			1,
			broker,
		);
		if (!opened.ok) throw new Error(opened.error.code);
		const covered = executePaperOrder(
			opened.value.portfolio,
			intent("BUY"),
			100,
			2,
			broker,
		);
		if (!covered.ok) throw new Error(covered.error.code);
		expect(covered.value.trade.realizedPnl).toBeCloseTo(
			covered.value.portfolio.cash - 1_000,
		);
	});

	it.each(
		(["stop", "kill", "tick"] as const).flatMap((command) =>
			(["fetch", "allocation", "authorization", "submission"] as const).map(
				(stage) => ({ command, stage }),
			),
		),
	)(
		"handles $command while $stage is in flight without duplicate execution",
		async ({ command, stage }) => {
			vi.spyOn(Date, "now").mockReturnValue(initialTime);
			const config = configuration({
				strategyOptions: { positionAware: false },
				executionStyle: "LIMIT_PASSIVE",
			});
			const snapshot = market(config, initialTime, [10, 9, 8, 7, 6, 5]);
			let releaseMarket: (() => void) | undefined;
			let markMarketStarted: (() => void) | undefined;
			const marketStarted = new Promise<void>((resolve) => {
				markMarketStarted = resolve;
			});
			const marketGate = new Promise<void>((resolve) => {
				releaseMarket = resolve;
			});
			const gate = async (currentStage: typeof stage) => {
				if (stage === currentStage) {
					markMarketStarted?.();
					await marketGate;
				}
			};
			let artifacts: CycleArtifacts | null = null;
			const submissions = vi.fn();
			const state: TradingAgentState = {
				...INITIAL_AGENT_STATE,
				configuration: config,
				machine: machineAt(config, "waiting", initialTime, "unused"),
				enabled: true,
				portfolio: { cash: 10_000, positionQuantity: 0, averagePrice: 0 },
			};
			const agent = Object.assign(Object.create(TradingAgent.prototype), {
				name: "audit",
				env: {},
				state,
				setState(next: TradingAgentState) {
					this.state = next;
				},
				ensureTradingPersistenceSchema: () => undefined,
				loadArtifacts: () => artifacts,
				toCycleSummary: () => null,
				emitOperatorSideEffects: () => undefined,
			}) as {
				state: TradingAgentState;
				runCurrent(triggerAlarm: boolean): Promise<void>;
				stopAgent(permissions: {
					canControl: boolean;
					canTrade: boolean;
				}): Promise<unknown>;
				killAgent(permissions: {
					canControl: boolean;
					canTrade: boolean;
				}): Promise<unknown>;
			};
			const base = effectsFor(config, snapshot);
			let submitted: OrderSubmission | undefined;
			const reconciliations = vi.fn();
			const effects: TradingCycleEffects = {
				...base,
				fetchMarketData: async () => {
					await gate("fetch");
					return ok(snapshot);
				},
				fetchOrderBook: async () => {
					await gate("allocation");
					return null;
				},
				authorize: async (intent) => {
					await gate("authorization");
					return base.authorize(intent);
				},
				checkpoint: async (next) => {
					artifacts = next;
					return ok(undefined);
				},
				persistMachine: async (next) => {
					Object.assign(agent, {
						state: {
							...agent.state,
							machine: next,
							enabled: machineIsEnabled(next.value),
						},
					});
				},
				submitOrder: async (...args) => {
					submissions();
					await gate("submission");
					submitted = await base.submitOrder(...args);
					return submitted;
				},
				reconcileOrder: async () => {
					reconciliations();
					if (submitted === undefined) throw new Error("missing submission");
					return ok(submitted);
				},
			};
			Object.assign(agent, { createEffects: () => effects });
			const pending = agent.runCurrent(true);
			await marketStarted;
			const expectedPhase = {
				fetch: "fetchingMarketData",
				allocation: "allocating",
				authorization: "authorizing",
				submission: "submittingOrder",
			};
			expect(agent.state.machine?.value).toBe(expectedPhase[stage]);
			const controlling =
				command === "stop"
					? agent.stopAgent(permissions)
					: command === "kill"
						? agent.killAgent(permissions)
						: agent.runCurrent(true);
			if (command !== "tick") {
				await vi.waitFor(() =>
					expect(agent.state.machine?.context.shutdownMode).toBe(
						command === "stop" ? "stop" : "kill-switch",
					),
				);
			}
			releaseMarket?.();
			await Promise.all([pending, controlling]);
			expect(submissions).toHaveBeenCalledTimes(
				command === "tick" || stage === "submission" ? 1 : 0,
			);
			expect(reconciliations).toHaveBeenCalledTimes(
				command !== "tick" && stage === "submission" ? 1 : 0,
			);
			expect(agent.state.enabled).toBe(command === "tick");
			expect(agent.state.machine?.value).toBe(
				command === "tick"
					? "waiting"
					: command === "stop"
						? "stopped"
						: "halted",
			);
		},
	);

	it("releases execution ownership after an error", async () => {
		const agent = Object.create(TradingAgent.prototype) as {
			runExclusiveCycle(
				key: string,
				execute: () => Promise<void>,
			): Promise<void>;
		};
		await expect(
			agent.runExclusiveCycle("single", async () => {
				throw new Error("fetch failed");
			}),
		).rejects.toThrow("fetch failed");
		const recovered = vi.fn(async () => undefined);
		await agent.runExclusiveCycle("single", recovered);
		expect(recovered).toHaveBeenCalledTimes(1);
	});

	it.each(["stop", "kill"] as const)(
		"broadcasts %s to every portfolio product before draining an active cycle",
		async (command) => {
			vi.spyOn(Date, "now").mockReturnValue(initialTime);
			const config = configuration({
				strategyOptions: { positionAware: false },
			});
			const multi = parseMultiProductAgentConfiguration({
				products: [
					{ productId: "BTC-USD", risk: config.risk },
					{ productId: "ETH-USD", risk: config.risk },
				],
				portfolioRisk: { maxGrossExposure: 20_000, maxDailyLoss: 1_000 },
				candleLimit: config.candleLimit,
				indicators: config.indicators,
				broker: config.broker,
				strategyIds: config.strategyIds,
				intervalSeconds: 60,
				strategyOptions: { positionAware: false },
			});
			if (!multi.ok) throw new Error(multi.error.code);
			const orchestrator = createPortfolioMachineSession({
				products: ["BTC-USD", "ETH-USD"],
				limits: multi.value.portfolioRisk!,
			});
			orchestrator.send({ type: "PORTFOLIO_STARTED" });
			const portfolioSession = {
				configuration: multi.value,
				portfolio: orchestrator.record,
				products: Object.fromEntries(
					multi.value.products.map((slot) => [
						slot.productId,
						initialProductRuntime(
							machineAt(config, "waiting", initialTime, slot.productId),
							10_000,
						),
					]),
				),
			};
			orchestrator.stop();
			let releaseFetch: (() => void) | undefined;
			let signalFetch: (() => void) | undefined;
			const fetching = new Promise<void>((resolve) => {
				signalFetch = resolve;
			});
			const fetchGate = new Promise<void>((resolve) => {
				releaseFetch = resolve;
			});
			const submissions = vi.fn();
			const agent = Object.assign(Object.create(TradingAgent.prototype), {
				name: "audit",
				env: {},
				state: {
					...INITIAL_AGENT_STATE,
					enabled: true,
					portfolioSession,
				} as TradingAgentState,
				setState(next: TradingAgentState) {
					this.state = next;
				},
				ensureTradingPersistenceSchema: () => undefined,
				loadArtifacts: () => null,
				toCycleSummary: () => null,
				emitOperatorSideEffects: () => undefined,
				getPortfolioSummary: () => ({ ok: false }),
				removeIntervalSchedule: async () => undefined,
				reportProductExposureFromState: () => undefined,
			}) as {
				state: TradingAgentState;
				runPortfolio(triggerAlarm: boolean): Promise<void>;
				persistProductMachine(
					productId: AgentConfiguration["productId"],
					machine: PersistedTradingMachine,
				): void;
				stopAgent(requestedPermissions: typeof permissions): Promise<unknown>;
				killAgent(requestedPermissions: typeof permissions): Promise<unknown>;
			};
			Object.assign(agent, {
				createProductEffects: (
					productConfig: AgentConfiguration,
				): TradingCycleEffects => {
					const snapshot = market(
						productConfig,
						initialTime,
						[10, 9, 8, 7, 6, 5],
					);
					const effects = effectsFor(productConfig, snapshot);
					return {
						...effects,
						fetchMarketData: async () => {
							signalFetch?.();
							await fetchGate;
							return ok(snapshot);
						},
						persistMachine: async (machine) => {
							agent.persistProductMachine(productConfig.productId, machine);
						},
						submitOrder: async (...args) => {
							submissions();
							return effects.submitOrder(...args);
						},
					};
				},
			});
			const pending = agent.runPortfolio(true);
			await fetching;
			const controlling =
				command === "stop"
					? agent.stopAgent(permissions)
					: agent.killAgent(permissions);
			await vi.waitFor(() => {
				for (const product of Object.values(
					agent.state.portfolioSession?.products ?? {},
				)) {
					expect(product.machine.context.shutdownMode).toBe(
						command === "stop" ? "stop" : "kill-switch",
					);
				}
			});
			releaseFetch?.();
			await Promise.all([pending, controlling]);
			expect(submissions).not.toHaveBeenCalled();
			expect(agent.state.enabled).toBe(false);
			expect(agent.state.portfolioSession?.portfolio.value).toBe(
				command === "stop" ? "complete" : "halted",
			);
		},
	);
});
