import type { Candle } from "@dodash/domain";
import { describe, expect, it } from "vitest";
import {
	parseCalibrationQuery,
	planOutcomeFetchWindows,
	resolveTrendOutcomes,
	type TrendSignalRow,
} from "../src/ai-trend-calibration.js";

const HOUR = 3_600_000;

const candle = (start: number, close: number): Candle => ({
	start,
	open: 1,
	high: 2,
	low: 0.5,
	close,
	volume: 10,
});

const row = (candleClosedAt: number): TrendSignalRow => ({
	productId: "BTC-USD",
	candleClosedAt,
	observedAt: candleClosedAt + 60_000,
	bias: "UP",
	probability: 0.8,
	collection: "SHADOW",
	questionVersion: "v1",
	thresholdBps: null,
});

describe("ai trend calibration — outcome join (§8)", () => {
	// close(C) = close de la bougie start C−D ; issue h=1 = close de la bougie start C.
	const candles = [
		candle(21 * HOUR, 100),
		candle(22 * HOUR, 100), // issue de C=22h : 100 = 100 → FLAT
		candle(23 * HOUR, 110), // close(C=24h) = 110
		candle(24 * HOUR, 105), // issue h=1 : 105 < 110 → DOWN
	];

	it("resolves UP, DOWN and FLAT outcomes from the closes", () => {
		const rows = resolveTrendOutcomes(
			[row(24 * HOUR), row(23 * HOUR), row(22 * HOUR)],
			[...candles, candle(25 * HOUR, 111)], // issue de C=23h : 105 > 100 → UP
			HOUR,
			1,
			Date.now() + 10 * HOUR,
		);
		expect(rows.map((r) => r.outcome)).toEqual(["DOWN", "UP", "FLAT"]);
	});

	it("marks outcomes whose candle is not closed yet as PENDING", () => {
		const now = 24 * HOUR + 30 * 60_000; // la bougie start 24h n'est pas close
		const rows = resolveTrendOutcomes([row(24 * HOUR)], candles, HOUR, 1, now);
		expect(rows[0]?.outcome).toBe("PENDING");
	});

	it("marks rows with a missing reference or outcome candle as PENDING", () => {
		const rows = resolveTrendOutcomes(
			[row(25 * HOUR)],
			candles,
			HOUR,
			1,
			Date.now(),
		);
		expect(rows[0]?.outcome).toBe("PENDING");
	});
});

describe("ai trend calibration — query parsing", () => {
	it("accepts a bounded window with defaults", () => {
		expect(
			parseCalibrationQuery({
				from: "23",
				to: "47",
				collection: null,
				horizon: null,
				timeframe: null,
			}),
		).toEqual({
			ok: true,
			query: {
				from: 23,
				to: 47,
				collection: "ALL",
				horizon: 1,
				timeframe: "ONE_HOUR",
				timeframeMs: HOUR,
			},
		});
	});

	it.each([
		["missing bounds", {}],
		["inverted window", { from: "50", to: "10" }],
		["unknown timeframe", { from: "10", to: "20", timeframe: "TWO_HOUR" }],
	])("rejects %s", (_name, input) => {
		expect(parseCalibrationQuery(input)).toEqual({
			ok: false,
			code: "INVALID_REQUEST",
		});
	});

	it("rejects an out-of-range horizon", () => {
		expect(
			parseCalibrationQuery({ from: "10", to: "20", horizon: "25" }),
		).toEqual({
			ok: false,
			code: "INVALID_HORIZON",
		});
	});

	it("rejects an oversized window for the timeframe", () => {
		expect(
			parseCalibrationQuery({
				from: String(HOUR),
				to: String(290 * HOUR),
				timeframe: "ONE_HOUR",
			}),
		).toEqual({ ok: false, code: "WINDOW_TOO_LARGE" });
	});
});

describe("ai trend calibration — issue vol-scalée (§9)", () => {
	it("juge une ligne v2 avec son θ persisté (zone morte → FLAT)", () => {
		const C = 24 * HOUR;
		const candles = [
			candle(23 * HOUR, 100),
			candle(24 * HOUR, 100.1), // +0.1 % : dans la zone morte θ=20 bps
		];
		const rows = resolveTrendOutcomes(
			[
				{
					productId: "BTC-USD",
					candleClosedAt: C,
					observedAt: C + 5_000,
					bias: "NEUTRAL",
					probability: 0.6,
					collection: "SHADOW",
					questionVersion: "v2",
					thresholdBps: 20,
				},
			],
			candles,
			HOUR,
			1,
			C + HOUR,
		);
		expect(rows[0]?.outcome).toBe("FLAT");
	});
});

describe("ai trend calibration — fenêtres de fetch d'issues (≤ 300)", () => {
	it("découpe une fenêtre 288 + horizon 15 en fetchs ≤ 290 bougies couvrant tout", () => {
		const HOUR2 = 3_600_000;
		const from = 0;
		const to = 287 * HOUR2;
		const windows = planOutcomeFetchWindows(from, to, HOUR2, 15);
		expect(windows.length).toBeGreaterThanOrEqual(2);
		for (const w of windows) expect(w.limit).toBeLessThanOrEqual(290);
		// le dernier fetch couvre la bougie d'issue la plus tardive (to + 14·D)
		expect(windows[windows.length - 1]?.endMs).toBe(to + 14 * HOUR2);
		// le premier couvre la bougie de référence la plus ancienne (from − D)
		const first = windows[0];
		expect(
			first !== undefined &&
				first.endMs - (first.limit - 1) * HOUR2 <= from - HOUR2,
		).toBe(true);
	});
});
