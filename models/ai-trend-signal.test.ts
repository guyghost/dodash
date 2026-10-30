import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AiTrendBias, AiTrendSignal } from "./ai-trend-signal.js";
import {
	AI_TREND_THRESHOLD_K,
	applyTrendModulation,
	buildRetrospectiveTrendState,
	composeTrendFromBatteryV2,
	computeTrendCalibration,
	dedupeTrendSignals,
	evaluateTrendSignal,
	resolveTrendThresholdBps,
	resolveVolScaledOutcome,
	type TrendCalibrationSample,
	type TrendOutcome,
	type TrendPolicy,
	validateTrendPolicy,
} from "./ai-trend-signal.js";

const policy: TrendPolicy = {
	enabled: true,
	maxAgeMs: 3_600_000,
	minProbability: 0.6,
	maxFactor: 1.5,
};

const signal = (overrides: Partial<AiTrendSignal> = {}): AiTrendSignal => ({
	kind: "AI_TREND",
	productId: "BTC-USD",
	candleClosedAt: 1_000,
	observedAt: 1_200,
	bias: "UP",
	probability: 0.8,
	provider: "jev",
	...overrides,
});

describe("ai trend signal — policy validation (INV 7)", () => {
	it("accepts a bounded policy", () => {
		expect(validateTrendPolicy(policy)).toEqual({ ok: true });
	});

	it.each([
		["maxAgeMs zero", { ...policy, maxAgeMs: 0 }],
		["fractional maxAgeMs", { ...policy, maxAgeMs: 1.5 }],
		["minProbability at 0.5", { ...policy, minProbability: 0.5 }],
		["minProbability at 1", { ...policy, minProbability: 1 }],
		["maxFactor at 1", { ...policy, maxFactor: 1 }],
		["maxFactor above 2", { ...policy, maxFactor: 2.1 }],
	])("rejects %s", (_name, invalid) => {
		expect(validateTrendPolicy(invalid)).toEqual({ ok: false });
	});
});

describe("ai trend signal — evaluateTrendSignal", () => {
	it("rejects each inactivity reason", () => {
		expect(
			evaluateTrendSignal(signal(), { ...policy, enabled: false }, 1_300),
		).toEqual({
			kind: "INACTIVE",
			reason: "DISABLED",
		});
		expect(
			evaluateTrendSignal(signal(), policy, signal().observedAt - 1),
		).toEqual({
			kind: "INACTIVE",
			reason: "STALE",
		});
		expect(
			evaluateTrendSignal(
				signal(),
				policy,
				signal().observedAt + policy.maxAgeMs,
			),
		).toEqual({
			kind: "INACTIVE",
			reason: "STALE",
		});
		expect(
			evaluateTrendSignal(signal({ bias: "NEUTRAL" }), policy, 1_300),
		).toEqual({
			kind: "INACTIVE",
			reason: "NEUTRAL",
		});
		expect(
			evaluateTrendSignal(signal({ probability: 0.59 }), policy, 1_300),
		).toEqual({
			kind: "INACTIVE",
			reason: "BELOW_THRESHOLD",
		});
	});

	it("enforces the availability window (INV 11, strict upper bound)", () => {
		expect(
			evaluateTrendSignal(signal(), policy, signal().observedAt).kind,
		).toBe("MODULATION");
		expect(
			evaluateTrendSignal(
				signal(),
				policy,
				signal().observedAt + policy.maxAgeMs - 1,
			).kind,
		).toBe("MODULATION");
		expect(
			evaluateTrendSignal(
				signal(),
				policy,
				signal().observedAt + policy.maxAgeMs,
			).kind,
		).toBe("INACTIVE");
	});

	it("maps thresholds exactly: minProbability → 1, probability 1 → maxFactor", () => {
		expect(
			evaluateTrendSignal(signal({ probability: 0.6 }), policy, 1_300),
		).toEqual({
			kind: "MODULATION",
			bias: "UP",
			factor: 1,
		});
		expect(
			evaluateTrendSignal(signal({ probability: 1 }), policy, 1_300),
		).toEqual({
			kind: "MODULATION",
			bias: "UP",
			factor: 1.5,
		});
		expect(
			evaluateTrendSignal(
				signal({ probability: 0.8, bias: "DOWN" }),
				policy,
				1_300,
			),
		).toEqual({
			kind: "MODULATION",
			bias: "DOWN",
			factor: 1.25,
		});
	});

	it("bounds the factor over the whole probability range (property, INV 1)", () => {
		for (const minProbability of [0.51, 0.6, 0.75, 0.9]) {
			for (const maxFactor of [1.0001, 1.2, 1.5, 2]) {
				const scoped = { ...policy, minProbability, maxFactor };
				for (let i = 0; i <= 100; i++) {
					const probability = i / 100;
					const modulation = evaluateTrendSignal(
						signal({ probability }),
						scoped,
						1_300,
					);
					if (modulation.kind === "MODULATION") {
						expect(modulation.factor).toBeGreaterThanOrEqual(1);
						expect(modulation.factor).toBeLessThanOrEqual(maxFactor);
						expect(modulation.factor).toBeGreaterThan(0);
					}
				}
				// INV 1 holds unconditionally, even on malformed probabilities.
				const malformed = evaluateTrendSignal(
					signal({ probability: 5 }),
					scoped,
					1_300,
				);
				expect(
					malformed.kind === "MODULATION" ? malformed.factor : 1,
				).toBeLessThanOrEqual(maxFactor);
			}
		}
	});
});

describe("ai trend signal — applyTrendModulation", () => {
	const base = {
		strategyId: "ema-cross",
		productId: "BTC-USD",
		confidence: 0.8,
		suggestedSize: 100,
		reasonCode: "CROSS_UP",
	} as const;

	it("multiplies aligned confidence and leaves others unchanged", () => {
		const up = applyTrendModulation(
			{ ...base, side: "BUY" as const },
			{ kind: "MODULATION", bias: "UP", factor: 1.25 },
		);
		expect(up.confidence).toBe(1);
		expect(up).toEqual({ ...base, side: "BUY", confidence: 1 });

		const sell = applyTrendModulation(
			{ ...base, side: "SELL" as const },
			{ kind: "MODULATION", bias: "UP", factor: 1.25 },
		);
		expect(sell.confidence).toBe(0.8);

		const hold = applyTrendModulation(
			{ ...base, side: "HOLD" as const },
			{ kind: "MODULATION", bias: "UP", factor: 1.25 },
		);
		expect(hold.confidence).toBe(0.8);

		const inactive = applyTrendModulation(
			{ ...base, side: "BUY" as const },
			{ kind: "INACTIVE", reason: "STALE" },
		);
		expect(inactive.confidence).toBe(0.8);
	});

	it("preserves every other field of the modulated signal", () => {
		const modulated = applyTrendModulation(
			{ ...base, side: "BUY" as const, confidence: 0.5 },
			{ kind: "MODULATION", bias: "UP", factor: 1.2 },
		);
		expect(modulated).toEqual({ ...base, side: "BUY", confidence: 0.6 });
	});
});

describe("ai trend signal — dedupeTrendSignals (INV 8)", () => {
	it("keeps the most recent signal per (productId, candleClosedAt)", () => {
		const first = signal({ observedAt: 1_200, probability: 0.7 });
		const recent = signal({ observedAt: 1_400, probability: 0.9 });
		const other = signal({ candleClosedAt: 2_000, observedAt: 2_200 });
		const eth = signal({ productId: "ETH-USD" });
		const result = dedupeTrendSignals([first, recent, other, eth, recent]);
		expect(result).toEqual([recent, other, eth]);
	});
});

describe("ai trend signal — buildRetrospectiveTrendState (§7.A, INV 10)", () => {
	const candles = [
		{ closeTime: 300, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
		{ closeTime: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
		{ closeTime: 200, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
	];

	it("rejects any candle closing after the reference (blocking LOOKAHEAD)", () => {
		expect(
			buildRetrospectiveTrendState(
				[...candles, { closeTime: 400 } as never],
				300,
			),
		).toEqual({
			ok: false,
			errorCode: "LOOKAHEAD",
		});
	});

	it("rejects an empty input with EMPTY", () => {
		expect(buildRetrospectiveTrendState([], 300)).toEqual({
			ok: false,
			errorCode: "EMPTY",
		});
	});

	it("builds a state with candles closed at or before C, sorted", () => {
		const built = buildRetrospectiveTrendState(candles, 300);
		expect(built.ok).toBe(true);
		if (built.ok) {
			const json = built.state.json as { candles: { closeTime: number }[] };
			expect(json.candles.map((c) => c.closeTime)).toEqual([100, 200, 300]);
		}
	});
});

describe("ai trend signal — network audit (§6)", () => {
	it("performs no network access from models/", () => {
		const code = readFileSync(
			fileURLToPath(new URL("ai-trend-signal.ts", import.meta.url)),
			"utf8",
		);
		for (const forbidden of [
			"fetch(",
			"ai-gateway.vercel.sh",
			"api.openai.com",
			"env.AI",
			"https://",
		]) {
			expect(
				code.includes(forbidden),
				`ai-trend-signal.ts must not contain ${forbidden}`,
			).toBe(false);
		}
	});
});

describe("ai trend signal — calibration (§8)", () => {
	const sample = (
		probability: number,
		bias: AiTrendBias,
		outcome: TrendOutcome,
	): TrendCalibrationSample => ({
		productId: "BTC-USD",
		candleClosedAt: 0,
		bias,
		probability,
		outcome,
	});

	it("computes a perfect-calibration ECE of 0", () => {
		// bin [0.8, 0.9[ : 4 échantillons à p=0.8, 4 corrects sur 5 → acc 0.8
		const samples = [
			sample(0.8, "UP", "UP"),
			sample(0.8, "UP", "UP"),
			sample(0.8, "UP", "UP"),
			sample(0.8, "UP", "UP"),
			sample(0.8, "UP", "DOWN"),
		];
		const report = computeTrendCalibration(samples);
		expect(report.ok).toBe(true);
		if (report.ok) {
			expect(report.sampleSize).toBe(5);
			expect(report.ece).toBe(0);
			const bin = report.bins[8];
			expect(bin).toMatchObject({
				lower: 0.8,
				upper: 0.9,
				count: 5,
				meanProbability: 0.8,
				accuracy: 0.8,
			});
		}
	});

	it("computes an exact ECE on a fixed fixture", () => {
		// bin [0.5, 0.6[ : p moyen 0.5, acc 0.5 → |0.5 − 0.5| = 0, poids 2/4
		// bin [0.9, 1.0] : p moyen 0.9, acc 0.5 → |0.5 − 0.9| = 0.4, poids 2/4
		// ECE = 0.5 × 0 + 0.5 × 0.4 = 0.2
		const samples = [
			sample(0.5, "UP", "UP"),
			sample(0.5, "DOWN", "UP"),
			sample(0.9, "UP", "UP"),
			sample(0.9, "UP", "DOWN"),
		];
		const report = computeTrendCalibration(samples);
		expect(report.ok).toBe(true);
		if (report.ok) expect(report.ece).toBeCloseTo(0.2, 12);
	});

	it("never counts PENDING outcomes and rejects an all-pending sample", () => {
		const report = computeTrendCalibration([sample(0.9, "UP", "PENDING")]);
		expect(report).toEqual({ ok: false, errorCode: "EMPTY_SAMPLE" });
		const mixed = computeTrendCalibration([
			sample(1, "UP", "UP"),
			sample(1, "UP", "PENDING"),
		]);
		expect(mixed.ok && mixed.sampleSize).toBe(1);
	});

	it("accepts probability 1.0 into the last bin only", () => {
		const report = computeTrendCalibration([sample(1, "UP", "DOWN")]);
		expect(report.ok && report.bins[9]?.count).toBe(1);
		expect(
			report.ok && report.bins.slice(0, 9).every((b) => b.count === 0),
		).toBe(true);
	});

	it("treats FLAT as correct only for NEUTRAL", () => {
		const report = computeTrendCalibration([
			sample(0.8, "NEUTRAL", "FLAT"),
			sample(0.8, "UP", "FLAT"),
		]);
		expect(report.ok && report.bins[8]?.accuracy).toBe(0.5);
	});
});

describe("ai trend signal — question v2 (§9)", () => {
	it("scales the threshold with realized volatility, floored at 1 bps", () => {
		expect(resolveTrendThresholdBps(40)).toBe(20);
		expect(resolveTrendThresholdBps(1)).toBe(1);
		expect(resolveTrendThresholdBps(0)).toBe(1);
		expect(resolveTrendThresholdBps(Number.NaN)).toBe(1);
	});

	it("composes the argmax of three exclusive events with deterministic tie-break", () => {
		// pUp 0.6, pDown 0.2 → pNeutral 0.2 → UP/0.6
		expect(composeTrendFromBatteryV2(0.6, 0.2)).toEqual({
			bias: "UP",
			probability: 0.6,
		});
		// pDown domine
		expect(composeTrendFromBatteryV2(0.1, 0.7)).toEqual({
			bias: "DOWN",
			probability: 0.7,
		});
		// zone morte : pNeutral domine
		const dead = composeTrendFromBatteryV2(0.2, 0.2);
		expect(dead?.bias).toBe("NEUTRAL");
		expect(dead?.probability).toBeCloseTo(0.6, 10);
		// égalité UP/DOWN → UP (tie-break déclaré)
		expect(composeTrendFromBatteryV2(0.5, 0.5)).toEqual({
			bias: "UP",
			probability: 0.5,
		});
	});

	it("rejects out-of-range predicate inputs", () => {
		expect(composeTrendFromBatteryV2(1.2, 0.1)).toBeNull();
		expect(composeTrendFromBatteryV2(0.1, -0.1)).toBeNull();
	});

	it("resolves vol-scaled outcomes with the persisted threshold", () => {
		// θ = 20 bps : +0.25 % → UP ; −0.25 % → DOWN ; ±0.1 % → FLAT (zone morte)
		expect(resolveVolScaledOutcome(100, 100.25, 20)).toBe("UP");
		expect(resolveVolScaledOutcome(100, 99.75, 20)).toBe("DOWN");
		expect(resolveVolScaledOutcome(100, 100.1, 20)).toBe("FLAT");
		// θ = 0 : la règle v1 (strictement égal → FLAT)
		expect(resolveVolScaledOutcome(100, 100.0, 0)).toBe("FLAT");
		expect(resolveVolScaledOutcome(100, 100.01, 0)).toBe("UP");
		expect(resolveVolScaledOutcome(100, -5, 20)).toBeNull();
	});
});

describe("ai trend signal — tie-break v2 (revue PR #27)", () => {
	it("DOWN gagne l'égalité contre NEUTRAL (pDown == pNeutral)", () => {
		// pUp 0.2, pDown 0.4, pNeutral 0.4 → DOWN (documenté : DOWN > NEUTRAL)
		expect(composeTrendFromBatteryV2(0.2, 0.4)).toEqual({
			bias: "DOWN",
			probability: 0.4,
		});
	});

	it("UP gagne l'égalité contre DOWN et contre NEUTRAL", () => {
		expect(composeTrendFromBatteryV2(0.4, 0.4)).toEqual({
			bias: "UP",
			probability: 0.4,
		});
		expect(composeTrendFromBatteryV2(0.5, 0.2)).toEqual({
			bias: "UP",
			probability: 0.5,
		});
	});
});
