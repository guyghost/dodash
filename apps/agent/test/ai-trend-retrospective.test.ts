import type { Candle } from "@dodash/domain";
import type { AiDecisionResult } from "@dodash/models";
import { describe, expect, it, vi } from "vitest";
import { AI_TREND_QUESTION } from "../src/ai-trend-producer.js";
import {
	AI_TREND_RETROSPECTIVE_MAX_CANDLES,
	collectRetrospectiveTrendSignals,
	collectRetrospectiveTrendSignalsV2,
	fetchCandlesViaMarketService,
	parseRetrospectiveCommand,
	planRetrospectiveCandles,
	type RetrospectiveCollectDeps,
} from "../src/ai-trend-retrospective.js";

const HOUR = 3_600_000;

const candle = (start: number): Candle => ({
	start,
	open: 1,
	high: 2,
	low: 0.5,
	close: 1.5,
	volume: 10,
});

describe("ai trend retrospective — window planning", () => {
	it("plans ascending aligned reference candles", () => {
		expect(planRetrospectiveCandles(23 * HOUR, 25 * HOUR, HOUR)).toEqual({
			ok: true,
			candles: [23 * HOUR, 24 * HOUR, 25 * HOUR],
		});
		expect(planRetrospectiveCandles(23 * HOUR, 23 * HOUR, HOUR)).toEqual({
			ok: true,
			candles: [23 * HOUR],
		});
	});

	it.each([
		["inverted window", 25 * HOUR, 23 * HOUR],
		["zero timeframe", 23 * HOUR, 24 * HOUR, 0],
	])("rejects %s", (_name, from, to, timeframe = HOUR) => {
		expect(planRetrospectiveCandles(from, to, timeframe)).toEqual({
			ok: false,
			errorCode: "INVALID_WINDOW",
		});
	});

	it("rejects misaligned bounds", () => {
		expect(planRetrospectiveCandles(23 * HOUR + 1, 25 * HOUR, HOUR)).toEqual({
			ok: false,
			errorCode: "MISALIGNED_WINDOW",
		});
	});

	it("bounds the batch", () => {
		const from = 0;
		const to = AI_TREND_RETROSPECTIVE_MAX_CANDLES * HOUR;
		expect(planRetrospectiveCandles(from, to, HOUR)).toEqual({
			ok: false,
			errorCode: "WINDOW_TOO_LARGE",
		});
	});
});

describe("ai trend retrospective — command parsing", () => {
	it("applies defaults", () => {
		const parsed = parseRetrospectiveCommand({
			productId: "BTC-USD",
			timeframe: "ONE_HOUR",
			fromCandleClosedAt: 23 * HOUR,
			toCandleClosedAt: 24 * HOUR,
		});
		expect(parsed).toEqual({
			ok: true,
			value: {
				productId: "BTC-USD",
				timeframe: "ONE_HOUR",
				fromCandleClosedAt: 23 * HOUR,
				toCandleClosedAt: 24 * HOUR,
				candleLimit: 100,
				force: false,
				questionVersion: "v1",
			},
		});
	});

	it("rejects an unknown timeframe", () => {
		expect(
			parseRetrospectiveCommand({
				productId: "BTC-USD",
				timeframe: "TWO_HOUR",
				fromCandleClosedAt: 0,
				toCandleClosedAt: HOUR,
			}),
		).toEqual({ ok: false, error: { code: "INVALID_REQUEST" } });
	});
});

describe("ai trend retrospective — historical fetch", () => {
	it("asks the service for the window ending at C, in seconds", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => {
			return new Response(
				JSON.stringify({
					productId: "BTC-USD",
					timeframe: "ONE_HOUR",
					candles: [candle(22 * HOUR), candle(23 * HOUR)],
				}),
				{ status: 200 },
			);
		});
		const result = await fetchCandlesViaMarketService(
			{ fetch: fetchMock as unknown as typeof fetch },
			"x".repeat(40),
			{
				productId: "BTC-USD",
				timeframe: "ONE_HOUR",
				limit: 100,
				candleClosedAt: 24 * HOUR,
				timeframeMs: HOUR,
			},
		);
		expect(result.ok).toBe(true);
		const [, init] = fetchMock.mock.calls[0] ?? [];
		expect(JSON.parse(String(init?.body))).toEqual({
			productId: "BTC-USD",
			timeframe: "ONE_HOUR",
			limit: 100,
			end: 82_800, // (24h − 1h) en secondes
		});
	});

	it.each([
		["http error", 503, "MARKET_FETCH_FAILED"],
		["malformed payload", 200, "INVALID_RESPONSE"],
	])("maps %s", async (_name, status, code) => {
		const body =
			status === 200
				? JSON.stringify({ productId: "BTC-USD", candles: "nope" })
				: null;
		const fetchMock = vi.fn<typeof fetch>(
			async () => new Response(body, { status: status as number }),
		);
		const result = await fetchCandlesViaMarketService(
			{ fetch: fetchMock as unknown as typeof fetch },
			"x".repeat(40),
			{
				productId: "BTC-USD",
				timeframe: "ONE_HOUR",
				limit: 100,
				candleClosedAt: 24 * HOUR,
				timeframeMs: HOUR,
			},
		);
		expect(result).toEqual({ ok: false, code });
	});
});

describe("ai trend retrospective — collection", () => {
	const answered: AiDecisionResult = {
		kind: "ANSWERED",
		answers: [
			{
				kind: "CHOICE",
				id: AI_TREND_QUESTION.id,
				probabilities: { UP: 0.8, DOWN: 0.1, NEUTRAL: 0.1 },
			},
		],
		latencyMs: 100,
		inputTokens: 400,
	};

	const deps = (
		overrides: Partial<RetrospectiveCollectDeps> = {},
	): RetrospectiveCollectDeps => ({
		productId: "BTC-USD",
		timeframe: "ONE_HOUR",
		timeframeMs: HOUR,
		candleLimit: 100,
		fromCandleClosedAt: 23 * HOUR,
		toCandleClosedAt: 24 * HOUR,
		force: false,
		fetchCandles: async (request) => ({
			ok: true,
			candles: [
				candle(request.candleClosedAt - 2 * HOUR),
				candle(request.candleClosedAt - HOUR),
			],
		}),
		decide: async () => answered,
		loadExisting: async () => new Map(),
		persist: () => {},
		nowMs: () => 42,
		log: () => {},
		...overrides,
	});

	it("collects each candle of the window with RETROSPECTIVE provenance", async () => {
		const persist = vi.fn();
		const report = await collectRetrospectiveTrendSignals(deps({ persist }));
		expect(report).toEqual({
			collected: 2,
			skippedExisting: 0,
			unavailable: 0,
			empty: 0,
			aborted: null,
			planError: null,
		});
		expect(persist).toHaveBeenCalledTimes(2);
		expect(persist).toHaveBeenLastCalledWith(
			{
				kind: "AI_TREND",
				productId: "BTC-USD",
				candleClosedAt: 24 * HOUR,
				observedAt: 42,
				bias: "UP",
				probability: 0.8,
				provider: "jev",
			},
			{ latencyMs: 100, inputTokens: 400 },
			"RETROSPECTIVE",
			"v1",
			null,
			"ONE_HOUR",
		);
	});

	it("never re-queries a SHADOW row and honors force for RETROSPECTIVE rows", async () => {
		const decide = vi.fn(async () => answered);
		const existing = new Map([
			[23 * HOUR, "SHADOW" as const],
			[24 * HOUR, "RETROSPECTIVE" as const],
		]);
		const withoutForce = await collectRetrospectiveTrendSignals(
			deps({ loadExisting: async () => existing, decide }),
		);
		expect(withoutForce.skippedExisting).toBe(2);
		expect(decide).not.toHaveBeenCalled();

		const withForce = await collectRetrospectiveTrendSignals(
			deps({ loadExisting: async () => existing, decide, force: true }),
		);
		expect(withForce.skippedExisting).toBe(1); // SHADOW reste intouchée
		expect(withForce.collected).toBe(1);
		expect(decide).toHaveBeenCalledTimes(1);
	});

	it("aborts the batch on a LOOKAHEAD defect (INV 10)", async () => {
		const decide = vi.fn(async () => answered);
		const report = await collectRetrospectiveTrendSignals(
			deps({
				fetchCandles: async (request) => ({
					ok: true,
					// Une bougie postérieure à C glisse dans la fenêtre : défaut.
					candles: [candle(request.candleClosedAt + HOUR)],
				}),
				decide,
			}),
		);
		expect(report.aborted).toBe("LOOKAHEAD");
		expect(report.collected).toBe(0);
		expect(decide).not.toHaveBeenCalled();
	});

	it("continues past fetch and provider failures", async () => {
		let calls = 0;
		const fetchCandles = vi.fn(async () => {
			calls += 1;
			return calls === 1
				? ({ ok: false, code: "MARKET_FETCH_FAILED" } as const)
				: ({ ok: true, candles: [candle(23 * HOUR)] } as const);
		});
		const report = await collectRetrospectiveTrendSignals(
			deps({
				fetchCandles,
				decide: async () => ({
					kind: "REFUSED",
					refusedIds: [AI_TREND_QUESTION.id],
				}),
			}),
		);
		expect(report.unavailable).toBe(2);
		expect(report.collected).toBe(0);
	});

	it("surfaces a rejected plan", async () => {
		const report = await collectRetrospectiveTrendSignals(
			deps({ fromCandleClosedAt: 23 * HOUR + 1 }),
		);
		expect(report.planError).toBe("MISALIGNED_WINDOW");
	});
});

describe("ai trend retrospective — collecteur v2 (§9)", () => {
	const HOUR = 3_600_000;
	const candle = (start: number, close = 100): Candle => ({
		start,
		open: close,
		high: close * 1.001,
		low: close * 0.999,
		close,
		volume: 10,
	});
	// 70+ bougies par bougie de référence : une fenêtre partagée suffit.
	const BASE = 300 * HOUR;
	const windowCandles = Array.from({ length: 130 }, (_, i) =>
		candle(BASE - (129 - i) * HOUR, 100 + i * 0.1),
	);

	it("collecte tout le lot avec une seule fenêtre marché", async () => {
		const fetchWindow = vi.fn(
			async () => ({ ok: true, candles: windowCandles }) as const,
		);
		const persist = vi.fn();
		const report = await collectRetrospectiveTrendSignalsV2({
			productId: "BTC-USD",
			timeframe: "ONE_HOUR",
			timeframeMs: HOUR,
			candleLimit: 100,
			fromCandleClosedAt: BASE + HOUR,
			toCandleClosedAt: BASE + 2 * HOUR,
			force: false,
			paceMs: 0,
			fetchWindowCandles: fetchWindow,
			decide: async () => ({
				kind: "ANSWERED",
				answers: [
					{ kind: "PREDICATE", id: "up15", probability: 0.7 },
					{ kind: "PREDICATE", id: "down15", probability: 0.1 },
				],
				latencyMs: 80,
			}),
			loadExisting: async () => new Map(),
			persist,
			nowMs: () => 42,
			log: () => {},
		});
		expect(report.collected).toBe(2);
		expect(fetchWindow).toHaveBeenCalledTimes(1);
		const [signal, , collection, questionVersion, thresholdBps] =
			persist.mock.calls[0] ?? [];
		expect(signal.bias).toBe("UP");
		expect(collection).toBe("RETROSPECTIVE");
		expect(questionVersion).toBe("v2");
		expect(thresholdBps).toBeGreaterThanOrEqual(1);
	});

	it("compte EMPTY quand une bougie de référence manque de recul", async () => {
		const report = await collectRetrospectiveTrendSignalsV2({
			productId: "BTC-USD",
			timeframe: "ONE_HOUR",
			timeframeMs: HOUR,
			candleLimit: 100,
			fromCandleClosedAt: 24 * HOUR,
			toCandleClosedAt: 24 * HOUR,
			force: false,
			fetchWindowCandles: async () => ({
				ok: true,
				candles: windowCandles.slice(-10),
			}),
			decide: async () => ({ kind: "REFUSED", refusedIds: ["up15"] }),
			loadExisting: async () => new Map(),
			persist: () => {},
			nowMs: () => 42,
			log: () => {},
		});
		expect(report.empty).toBe(1);
		expect(report.collected).toBe(0);
	});

	it("retombe sur unavailable quand la fenêtre marché échoue", async () => {
		const report = await collectRetrospectiveTrendSignalsV2({
			productId: "BTC-USD",
			timeframe: "ONE_HOUR",
			timeframeMs: HOUR,
			candleLimit: 100,
			fromCandleClosedAt: 24 * HOUR,
			toCandleClosedAt: 26 * HOUR,
			force: false,
			fetchWindowCandles: async () =>
				({ ok: false, code: "MARKET_FETCH_FAILED" }) as const,
			decide: async () => ({ kind: "REFUSED", refusedIds: [] }),
			loadExisting: async () => new Map(),
			persist: () => {},
			nowMs: () => 42,
			log: () => {},
		});
		expect(report.unavailable).toBe(3);
	});
});
