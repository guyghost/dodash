/** Shared candidate-source evidence; no network, provider selection or transitions. */
export interface P7SourceProduct {
	readonly id: string;
	readonly base_increment: string;
	readonly quote_increment: string;
	readonly base_min_size: string;
	readonly min_market_funds: string;
}
export interface P7SourceBook {
	readonly productId: string;
	readonly sourceProfileId: string;
	readonly cacheStatus: string;
	readonly requestedAt: number;
	readonly receivedAt: number;
	readonly sourceObservedAt: number | null;
	readonly sequence: string;
	readonly bids: readonly {
		readonly price: number;
		readonly quantity: number;
	}[];
	readonly asks: readonly {
		readonly price: number;
		readonly quantity: number;
	}[];
}
export interface P7SourceQualification {
	readonly qualified: boolean;
	readonly reason: string;
	readonly rawBody: string;
	readonly bodySha256: string;
	readonly requestedAt: number;
	readonly receivedAt: number;
	readonly sourceObservedAt: number | null;
	readonly product?: P7SourceProduct;
	readonly wire?: {
		readonly bids: readonly (readonly [string, string, number])[];
		readonly asks: readonly (readonly [string, string, number])[];
	};
	readonly book?: P7SourceBook;
}

import {
	evaluateP7ExecutionBook,
	type P7QuoteScope,
} from "./p7-prospective-quote.js";
const record = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v);
const decimal = (v: unknown): v is string =>
	typeof v === "string" &&
	v.length <= 64 &&
	/^(0|[1-9]\d*)(\.\d+)?$/.test(v) &&
	Number.isFinite(Number(v)) &&
	Number(v) > 0;
/** Pure candidate qualification. The shell supplies decoded provenance, never decisions. */
export const evaluateP7SourceCandidate = (input: {
	readonly scope: P7QuoteScope;
	readonly product: unknown;
	readonly auctionMode: unknown;
	readonly book: P7SourceBook;
	readonly requiredBaseQuantity: number;
}): { readonly qualified: boolean; readonly reason: string } => {
	if (input.auctionMode !== false)
		return { qualified: false, reason: "AUCTION_OR_UNKNOWN" };
	const p = input.product;
	if (
		!record(p) ||
		p.id !== input.scope.productId ||
		![
			p.base_increment,
			p.quote_increment,
			p.base_min_size,
			p.min_market_funds,
		].every(decimal)
	)
		return { qualified: false, reason: "PRODUCT_METADATA_INVALID" };
	const gate = evaluateP7ExecutionBook(input.scope, input.book);
	if (!gate.eligible) return { qualified: false, reason: gate.reason };
	if (
		!Number.isFinite(input.requiredBaseQuantity) ||
		input.requiredBaseQuantity <= 0 ||
		[input.book.bids, input.book.asks].some(
			(levels) =>
				levels.reduce((sum, l) => sum + l.quantity, 0) <
				input.requiredBaseQuantity,
		)
	)
		return { qualified: false, reason: "DEPTH_INADEQUATE" };
	return { qualified: true, reason: "OFFLINE_QUALIFIED" };
};
