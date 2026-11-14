/**
 * In-request Coinbase retries after RATE_LIMITED
 * (models/market-source-failover.md, amendement 2026-11-14).
 * The pure plan decides; this shell only sleeps and calls again.
 * Other errors are returned on the first attempt.
 */

import type { Result } from "@dodash/domain";
import { planRateLimitBackoff } from "@dodash/models";

import type { MarketDataError } from "./coinbase.js";

export interface RateLimitBackoffDeps {
	readonly sleep?: (ms: number) => Promise<void>;
	readonly randomUnit?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

const defaultRandomUnit = (): number => {
	const buffer = new Uint32Array(1);
	crypto.getRandomValues(buffer);
	return (buffer[0] ?? 0) / 4_294_967_296;
};

export const runWithRateLimitBackoff = async <T>(
	run: () => Promise<Result<T, MarketDataError>>,
	deps: RateLimitBackoffDeps = {},
): Promise<{
	readonly result: Result<T, MarketDataError>;
	readonly tries: number;
}> => {
	const sleep = deps.sleep ?? defaultSleep;
	const randomUnit = deps.randomUnit ?? defaultRandomUnit;
	let result = await run();
	let tries = 1;
	let spentMs = 0;
	while (!result.ok && result.error.code === "RATE_LIMITED") {
		const plan = planRateLimitBackoff({
			attempt: tries - 1,
			retryAfterMs:
				result.error.retryAfterSeconds === undefined
					? null
					: result.error.retryAfterSeconds * 1_000,
			randomUnit: randomUnit(),
			spentMs,
		});
		if (plan.kind !== "retry") break;
		await sleep(plan.delayMs);
		spentMs = plan.spentMs;
		tries += 1;
		result = await run();
	}
	return { result, tries };
};
