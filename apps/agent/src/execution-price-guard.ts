/**
 * Execution-price guard (models/market-source-failover.md, chairman
 * 2026-11-14). Pure classification plus a log. The caller fetches the
 * Coinbase quote and, on rejection, returns ORDER_REJECTED without
 * submitting. The decision itself is already recorded.
 */

import { err, ok, type Result } from "@dodash/domain";
import {
	assessExecutionPriceDivergence,
	type WorkflowError,
} from "@dodash/models";

const rejected = (detail: string): WorkflowError => ({
	phase: "execution",
	code: "ORDER_REJECTED",
	retryable: false,
	detail,
});

export const guardExecutionPrice = (input: {
	readonly productId: string;
	readonly decisionPrice: number;
	readonly quote: Result<number, WorkflowError>;
	readonly maxDivergenceBps: number;
}): Result<void, WorkflowError> => {
	if (!input.quote.ok) {
		console.warn(
			JSON.stringify({
				event: "execution_price_guard",
				outcome: "QUOTE_UNAVAILABLE",
				productId: input.productId,
				decisionPrice: input.decisionPrice,
				quoteError: input.quote.error.code,
			}),
		);
		return err(rejected("EXECUTION_QUOTE_UNAVAILABLE"));
	}
	const assessment = assessExecutionPriceDivergence({
		decisionPrice: input.decisionPrice,
		executionPrice: input.quote.value,
		maxDivergenceBps: input.maxDivergenceBps,
	});
	const outcome = assessment.ok ? "PASSED" : "BLOCKED";
	const line = JSON.stringify({
		event: "execution_price_guard",
		outcome,
		productId: input.productId,
		decisionPrice: input.decisionPrice,
		executionPrice: input.quote.value,
		divergenceBps: assessment.divergenceBps,
		maxDivergenceBps: input.maxDivergenceBps,
	});
	if (!assessment.ok) {
		console.warn(line);
		return err(
			rejected(
				assessment.reason === "DIVERGENCE"
					? "EXECUTION_PRICE_DIVERGENCE"
					: "EXECUTION_QUOTE_UNAVAILABLE",
			),
		);
	}
	console.log(line);
	return ok(undefined);
};
