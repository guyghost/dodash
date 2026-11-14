import { err, ok, type Result } from "@dodash/domain";
import { describe, expect, it, vi } from "vitest";

import type { MarketDataError } from "../src/coinbase.js";
import { runWithRateLimitBackoff } from "../src/rate-limit-backoff.js";

type Attempt = Result<{ readonly price: number }, MarketDataError>;

const limited = (retryAfterSeconds?: number): MarketDataError =>
	retryAfterSeconds === undefined
		? { code: "RATE_LIMITED" }
		: { code: "RATE_LIMITED", retryAfterSeconds };

describe("runWithRateLimitBackoff", () => {
	it("returns a healthy Coinbase response without waiting", async () => {
		const run = vi.fn(async () => ok({ price: 1 }));
		const sleep = vi.fn(async () => undefined);
		const result = await runWithRateLimitBackoff(run, {
			sleep,
			randomUnit: () => 0.5,
		});
		expect(result).toEqual({ result: ok({ price: 1 }), tries: 1 });
		expect(sleep).not.toHaveBeenCalled();
	});

	it("retries a short 429 twice, then returns the third success", async () => {
		const sleeps: number[] = [];
		const run = vi.fn<() => Promise<Attempt>>();
		run.mockResolvedValueOnce(err(limited()))
			.mockResolvedValueOnce(err(limited()))
			.mockResolvedValueOnce(ok({ price: 2 }));
		const result = await runWithRateLimitBackoff(run, {
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			randomUnit: () => 0.5,
		});
		expect(result.tries).toBe(3);
		expect(result.result).toEqual(ok({ price: 2 }));
		expect(sleeps).toEqual([400, 1_200]);
	});

	it("does not sleep when Retry-After exceeds the in-request cap", async () => {
		const run = vi.fn(async () => err(limited(9)));
		const sleep = vi.fn(async () => undefined);
		const result = await runWithRateLimitBackoff(run, {
			sleep,
			randomUnit: () => 0,
		});
		expect(result.tries).toBe(1);
		expect(result.result).toEqual(err(limited(9)));
		expect(sleep).not.toHaveBeenCalled();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("does not retry a non-rate-limit failure", async () => {
		const run = vi.fn(async () => err({ code: "NETWORK_UNAVAILABLE" as const }));
		const sleep = vi.fn(async () => undefined);
		const result = await runWithRateLimitBackoff(run, { sleep, randomUnit: () => 0 });
		expect(result.tries).toBe(1);
		expect(sleep).not.toHaveBeenCalled();
	});
});
