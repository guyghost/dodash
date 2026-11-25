import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import type {
	AgentStateView,
	DashboardGateway,
	PaperValuationView,
	PnlHistoryView,
	PortfolioProductView,
	PortfolioSummaryView,
} from "../src/dashboard-api.js";

const asOf = 1_700_000_000_000;
const valuation = (
	positionQuantity: number,
	cash: number,
): PaperValuationView => ({
	asOf,
	equity: cash + positionQuantity * 100,
	exposureNotional: Math.abs(positionQuantity) * 100,
	exposureQuality: "fresh",
	markPrice: 100,
	markSource: "HYPERLIQUID_CANDLE_CLOSE",
	timeframe: "ONE_MINUTE",
	candleClosedAt: asOf - 1_000,
	ageMs: 1_000,
	quality: "fresh",
});

const product = (
	productId: string,
	positionQuantity: number,
): PortfolioProductView => ({
	productId,
	phase: "waiting",
	status: "running",
	cash: 1_000,
	positionQuantity,
	averagePrice: positionQuantity === 0 ? 0 : 100,
	marketPrice: 100,
	valuation: valuation(positionQuantity, 1_000),
	grossExposure: Math.abs(positionQuantity) * 100,
	exposureQuality: "fresh",
	maxGrossExposure: 10_000,
	dailyPnl: 0,
	lastCycle: null,
});

const renderPortfolio = async (
	positionQuantity: number,
	withProtection: boolean,
	historyProductId = "BTC-USD",
) => {
	const products = [
		product("BTC-USD", positionQuantity),
		product("ETH-USD", 0),
	];
	const summary: PortfolioSummaryView = {
		kind: "portfolio",
		phase: "running",
		killSwitchActive: false,
		asOf,
		products,
		consolidated: {
			equity: 2_000 + positionQuantity * 100,
			valuationQuality: "fresh",
			grossExposure: Math.abs(positionQuantity) * 100,
			exposureQuality: "fresh",
			maxGrossExposure: 20_000,
			dailyPnl: 0,
			maxDailyLoss: 100,
		},
	};
	const state: AgentStateView = {
		enabled: true,
		phase: "waiting",
		updatedAt: asOf,
		configuration: {
			productId: "BTC-USD",
			timeframe: "ONE_MINUTE",
			strategyIds: ["rsi-reversion"],
			intervalSeconds: 60,
			executionMode: "paper",
		},
		portfolio: { cash: 1_000, positionQuantity, averagePrice: 100 },
		dailyPnl: 0,
		nextWakeAt: null,
		lastTradeAt: asOf - 60_000,
		lastCycle: null,
		portfolioSummary: summary,
		paperValuation: null,
		indicators: null,
	};
	const history: PnlHistoryView = {
		equityCurve: [],
		cycles: [
			{
				cycleId: "position",
				productId: historyProductId,
				triggeredAt: asOf - 60_000,
				completedAt: asOf,
				outcome: "ORDER_CONFIRMED",
				marketPrice: 100,
				valuation: valuation(positionQuantity, 1_000),
				side: positionQuantity < 0 ? "SELL" : "BUY",
				quantity: Math.abs(positionQuantity),
				fillPrice: 100,
				fee: 0,
				realizedPnl: null,
				slippageBps: 0,
			},
		],
		openPosition: { quantity: positionQuantity, averagePrice: 100 },
		protection: withProtection
			? {
					stopLossPrice: 103,
					takeProfitPrice: 95,
					protectiveOrderConfirmed: false,
				}
			: null,
	};
	const gateway: DashboardGateway = {
		loadState: async () => state,
		loadCycles: async () => [],
		loadPnlHistory: async () => history,
		command: async () => state,
	};
	render(
		<App gateways={{ createHttp: () => gateway, createDemo: () => gateway }} />,
	);
	await userEvent.click(screen.getByRole("button", { name: "Voir la démo" }));
	await screen.findByRole("group", { name: "Position et protections" });
	return screen.getByRole("group", { name: "Position et protections" });
};

afterEach(() => cleanup());

describe("position protection regressions", () => {
	it("shows an open short instead of announcing no position", async () => {
		const badges = await renderPortfolio(-1, true);
		expect(badges.textContent).not.toContain("AUCUNE POSITION");
		expect(badges.textContent).toContain("POSITION -1");
		expect(badges.textContent).toContain("STOP 103,00");
		expect(screen.getByTitle("Prix moyen d'entrée")).toBeTruthy();
	});

	it("does not assert confirmed protection when the API returns none", async () => {
		const badges = await renderPortfolio(1, false);
		expect(badges.textContent).not.toContain("PROTECTION CONFIRMÉE");
		expect(badges.textContent).toContain("NON PROTÉGÉ");
	});
});
it("does not apply another product's protection at the same average price", async () => {
	const badges = await renderPortfolio(1, true, "ETH-USD");
	expect(badges.textContent).toContain("NON PROTÉGÉ");
	expect(badges.textContent).not.toContain("STOP");
});

it("resolves BTC-USD protection from /state protectionsByProduct even when XRP-USD ran the latest cycle (v9)", async () => {
	const products = [product("BTC-USD", 1), product("XRP-USD", 0)];
	const summary: PortfolioSummaryView = {
		kind: "portfolio",
		phase: "running",
		killSwitchActive: false,
		asOf,
		products,
		consolidated: {
			equity: 2_100,
			valuationQuality: "fresh",
			grossExposure: 100,
			exposureQuality: "fresh",
			maxGrossExposure: 20_000,
			dailyPnl: 0,
			maxDailyLoss: 100,
		},
	};
	const state: AgentStateView = {
		enabled: true,
		phase: "waiting",
		updatedAt: asOf,
		configuration: {
			productId: "BTC-USD",
			timeframe: "FIVE_MINUTE",
			strategyIds: ["rsi-reversion"],
			intervalSeconds: 300,
			executionMode: "paper",
		},
		portfolio: { cash: 1_000, positionQuantity: 1, averagePrice: 100 },
		dailyPnl: 0,
		nextWakeAt: null,
		lastTradeAt: asOf - 600_000,
		lastCycle: null,
		portfolioSummary: summary,
		paperValuation: null,
		indicators: null,
		protectionsByProduct: {
			"BTC-USD": {
				stopLossPrice: 98.8,
				takeProfitPrice: 101.5,
				protectiveOrderConfirmed: false,
			},
		},
	};
	const history: PnlHistoryView = {
		equityCurve: [],
		cycles: [
			{
				cycleId: "xrp-hold",
				productId: "XRP-USD",
				triggeredAt: asOf - 2_000,
				completedAt: asOf,
				outcome: "NO_ACTION",
				marketPrice: 1.0,
				valuation: valuation(0, 1_000),
				side: null,
				quantity: null,
				fillPrice: null,
				fee: null,
				realizedPnl: null,
				slippageBps: null,
			},
		],
		openPosition: null,
		protection: null,
	};
	const gateway: DashboardGateway = {
		loadState: async () => state,
		loadCycles: async () => [],
		loadPnlHistory: async () => history,
		command: async () => state,
	};
	render(
		<App gateways={{ createHttp: () => gateway, createDemo: () => gateway }} />,
	);
	await userEvent.click(screen.getByRole("button", { name: "Voir la démo" }));
	const badges = await screen.findByRole("group", {
		name: "Position et protections",
	});
	expect(badges.textContent).not.toContain("NON PROTÉGÉ");
	expect(badges.textContent).toContain("POSITION 1 · LONG");
	expect(badges.textContent).toContain("STOP 98,80");
	expect(badges.textContent).toContain("TAKE-PROFIT 101,50");
});
