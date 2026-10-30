import type { Candle } from "@dodash/domain";
import type { AiDecisionRequest, AiDecisionResult } from "@dodash/models";
import { describe, expect, it, vi } from "vitest";
import {
	AI_TREND_QUESTION,
	collectTrendSignal,
	mapCandlesToTrendState,
	resolveTrendFromAnswers,
	resolveTrendTimeframe,
	runDecisionWithMachine,
	type TrendCollectDeps,
} from "../src/ai-trend-producer.js";

const HOUR = 3_600_000;

const candle = (start: number): Candle => ({
	start,
	open: 1,
	high: 2,
	low: 0.5,
	close: 1.5,
	volume: 10,
});

describe("ai trend producer — state construction (§7.A)", () => {
	it("keeps only candles closed at or before the reference candle", () => {
		// Bougies 22:00, 23:00 closes ; 00:00 en cours (close 01:00 > C).
		const built = mapCandlesToTrendState(
			[candle(22 * HOUR), candle(23 * HOUR), candle(24 * HOUR)],
			HOUR,
			24 * HOUR,
		);
		expect(built.ok).toBe(true);
		if (built.ok) {
			const json = built.state.json as { candles: { closeTime: number }[] };
			expect(json.candles.map((c) => c.closeTime)).toEqual([
				23 * HOUR,
				24 * HOUR,
			]);
		}
	});

	it("drops the forming candle and any later candle silently (live snapshot)", () => {
		expect(
			mapCandlesToTrendState(
				[candle(24 * HOUR), candle(25 * HOUR)],
				HOUR,
				24 * HOUR,
			),
		).toEqual({ ok: false, errorCode: "EMPTY" });
		// La bougie qui chevauche C (start < C < close) est exclue, pas un défaut.
		const built = mapCandlesToTrendState(
			[candle(23 * HOUR), candle(24 * HOUR)],
			HOUR,
			24 * HOUR,
		);
		expect(built.ok).toBe(true);
		if (built.ok) {
			const json = built.state.json as { candles: { closeTime: number }[] };
			expect(json.candles.map((c) => c.closeTime)).toEqual([24 * HOUR]);
		}
	});
});

describe("ai trend producer — trend resolution", () => {
	it("takes the argmax option of the reported distribution", () => {
		expect(
			resolveTrendFromAnswers([
				{
					kind: "CHOICE",
					id: AI_TREND_QUESTION.id,
					probabilities: { UP: 0.2, DOWN: 0.7, NEUTRAL: 0.1 },
				},
			]),
		).toEqual({ bias: "DOWN", probability: 0.7 });
	});

	it("breaks ties in declared option order", () => {
		expect(
			resolveTrendFromAnswers([
				{
					kind: "CHOICE",
					id: AI_TREND_QUESTION.id,
					probabilities: { UP: 0.5, DOWN: 0.5, NEUTRAL: 0 },
				},
			]),
		).toEqual({ bias: "UP", probability: 0.5 });
	});

	it("returns null without a trend choice answer", () => {
		expect(
			resolveTrendFromAnswers([
				{ kind: "PREDICATE", id: "other", probability: 0.9 },
			]),
		).toBeNull();
	});
});

describe("ai trend producer — machine-driven decision", () => {
	const request = {
		provider: "jev" as const,
		state: { text: "état" },
		questions: [AI_TREND_QUESTION],
		timeoutMs: 100,
	};
	const answered: AiDecisionResult = {
		kind: "ANSWERED",
		answers: [
			{
				kind: "CHOICE",
				id: AI_TREND_QUESTION.id,
				probabilities: { UP: 1, DOWN: 0, NEUTRAL: 0 },
			},
		],
		latencyMs: 90,
	};

	it("settles on the first answer", async () => {
		const decide = vi.fn<
			(request: AiDecisionRequest, attempt: number) => Promise<AiDecisionResult>
		>(async () => answered);
		await expect(runDecisionWithMachine(request, decide)).resolves.toBe(
			answered,
		);
		expect(decide).toHaveBeenCalledTimes(1);
		expect(decide.mock.calls[0]?.[1]).toBe(1);
	});

	it("retries once on a retryable failure, then succeeds", async () => {
		const decide = vi
			.fn<
				(
					request: AiDecisionRequest,
					attempt: number,
				) => Promise<AiDecisionResult>
			>(async () => answered)
			.mockImplementationOnce(async () => ({
				kind: "FAILED",
				errorCode: "AI_TIMEOUT",
			}));
		await expect(runDecisionWithMachine(request, decide)).resolves.toBe(
			answered,
		);
		expect(decide).toHaveBeenCalledTimes(2);
		expect(decide.mock.calls[1]?.[1]).toBe(2);
	});

	it("settles on FAILED after exhausting the retry budget", async () => {
		const decide = vi.fn(
			async () => ({ kind: "FAILED", errorCode: "AI_PROVIDER_ERROR" }) as const,
		);
		await expect(runDecisionWithMachine(request, decide)).resolves.toEqual({
			kind: "FAILED",
			errorCode: "AI_PROVIDER_ERROR",
		});
		expect(decide).toHaveBeenCalledTimes(2);
	});

	it("never calls decide on an invalid request", async () => {
		const decide = vi.fn(async () => answered);
		await expect(
			runDecisionWithMachine({ ...request, questions: [] }, decide),
		).resolves.toEqual({ kind: "FAILED", errorCode: "AI_SCHEMA_MISMATCH" });
		expect(decide).not.toHaveBeenCalled();
	});

	it("maps a thrown effect to AI_PROVIDER_ERROR", async () => {
		const decide = vi.fn(async () => {
			throw new Error("boom");
		});
		await expect(runDecisionWithMachine(request, decide)).resolves.toEqual({
			kind: "FAILED",
			errorCode: "AI_PROVIDER_ERROR",
		});
	});
});

describe("ai trend producer — SHADOW collection", () => {
	const candles = [candle(23 * HOUR)];
	const deps = (
		overrides: Partial<TrendCollectDeps> = {},
	): TrendCollectDeps => ({
		productId: "BTC-USD",
		timeframeMs: HOUR,
		triggeredAt: 24 * HOUR + 60_000,
		candles,
		nowMs: () => 24 * HOUR + 5_000,
		decide: async () => ({
			kind: "ANSWERED",
			answers: [
				{
					kind: "CHOICE",
					id: AI_TREND_QUESTION.id,
					probabilities: { UP: 0.75, DOWN: 0.2, NEUTRAL: 0.05 },
				},
			],
			latencyMs: 120,
			inputTokens: 500,
		}),
		persist: () => {},
		log: () => {},
		...overrides,
	});

	it("persists the signal with the cycle's decision-candle identity", async () => {
		const persist = vi.fn();
		const log = vi.fn();
		const outcome = await collectTrendSignal(deps({ persist, log }));
		expect(outcome).toEqual({ kind: "PERSISTED" });
		expect(persist).toHaveBeenCalledWith(
			{
				kind: "AI_TREND",
				productId: "BTC-USD",
				candleClosedAt: 24 * HOUR,
				observedAt: 24 * HOUR + 5_000,
				bias: "UP",
				probability: 0.75,
				provider: "jev",
			},
			{ latencyMs: 120, inputTokens: 500 },
		);
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "ai_trend_signal_persisted",
				bias: "UP",
			}),
		);
	});

	it("produces no signal on a provider refusal", async () => {
		const persist = vi.fn();
		const outcome = await collectTrendSignal(
			deps({
				decide: async () => ({
					kind: "REFUSED",
					refusedIds: [AI_TREND_QUESTION.id],
				}),
				persist,
			}),
		);
		expect(outcome).toEqual({
			kind: "NOT_PRODUCED",
			result: { kind: "REFUSED", refusedIds: [AI_TREND_QUESTION.id] },
		});
		expect(persist).not.toHaveBeenCalled();
	});

	it("skips when no candle is closed at or before the reference", async () => {
		const decide = vi.fn();
		const outcome = await collectTrendSignal(
			deps({ candles: [candle(25 * HOUR)], decide }),
		);
		expect(outcome).toEqual({ kind: "SKIPPED", reason: "EMPTY" });
		expect(decide).not.toHaveBeenCalled();
	});

	it("skips an unresolved answer", async () => {
		const persist = vi.fn();
		const outcome = await collectTrendSignal(
			deps({
				decide: async () => ({
					kind: "ANSWERED",
					answers: [{ kind: "PREDICATE", id: "other", probability: 0.5 }],
					latencyMs: 10,
				}),
				persist,
			}),
		);
		expect(outcome).toEqual({ kind: "SKIPPED", reason: "UNRESOLVED" });
		expect(persist).not.toHaveBeenCalled();
	});
});

describe("ai trend producer — signal grid (amendement 2026-10-30)", () => {
	it("resolves the deployment-frozen trend timeframe with product fallback", () => {
		expect(resolveTrendTimeframe("ONE_MINUTE", "ONE_DAY")).toBe("ONE_MINUTE");
		expect(resolveTrendTimeframe(undefined, "ONE_DAY")).toBe("ONE_DAY");
		expect(resolveTrendTimeframe("TWO_HOUR", "ONE_DAY")).toBe("ONE_DAY");
	});
});
