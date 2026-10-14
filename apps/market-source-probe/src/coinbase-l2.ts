import type { P7QuoteScope } from "@dodash/models";
import { evaluateP7SourceCandidate } from "../../../models/p7-source-profile.js";
export interface CoinbaseL2Input {
	readonly scope: P7QuoteScope;
	readonly url: string;
	readonly status: number | null;
	readonly timedOut: boolean;
	readonly requestedAt: number;
	readonly receivedAt: number;
	readonly cacheStatus: string;
	readonly requiredBaseQuantity: number;
	readonly product: unknown;
	readonly rawBody: string;
}
type Tuple = readonly [string, string, number];
interface Product {
	id: string;
	base_increment: string;
	quote_increment: string;
	base_min_size: string;
	min_market_funds: string;
}
interface Book {
	productId: string;
	sourceProfileId: string;
	cacheStatus: string;
	requestedAt: number;
	receivedAt: number;
	sourceObservedAt: number | null;
	sequence: string;
	bids: { price: number; quantity: number }[];
	asks: { price: number; quantity: number }[];
}
export interface CoinbaseL2Result {
	readonly qualified: boolean;
	readonly reason: string;
	readonly rawBody: string;
	readonly bodySha256: string;
	readonly requestedAt: number;
	readonly receivedAt: number;
	readonly sourceObservedAt: number | null;
	readonly product?: Product;
	readonly wire?: { bids: readonly Tuple[]; asks: readonly Tuple[] };
	readonly book?: Book;
}
const object = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v);
const decimal = (v: unknown): v is string =>
	typeof v === "string" &&
	v.length <= 64 &&
	/^(0|[1-9]\d*)(\.\d+)?$/.test(v) &&
	Number.isFinite(Number(v)) &&
	Number(v) > 0;
/** Reject duplicate keys before numeric JSON parsing; capture root sequence lexeme losslessly. */
const parseWire = (
	raw: string,
): { json: Record<string, unknown>; sequence: string } => {
	let offset = 0;
	let sequence: string | undefined;
	const token =
		/\s*("(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:])/y;
	const next = (): string => {
		token.lastIndex = offset;
		const m = token.exec(raw);
		if (!m) throw new Error("invalid JSON");
		offset = token.lastIndex;
		return m[1]!;
	};
	const value = (first: string, depth: number): void => {
		if (depth > 20) throw new Error("JSON nesting");
		if (first === "{") {
			const keys = new Set<string>();
			let t = next();
			if (t === "}") return;
			while (true) {
				if (!t.startsWith('"')) throw new Error("invalid key");
				const key = JSON.parse(t) as string;
				if (keys.has(key)) throw new Error("duplicate key");
				keys.add(key);
				if (next() !== ":") throw new Error("invalid colon");
				const v = next();
				if (key === "sequence") {
					if (depth !== 0 || sequence !== undefined)
						throw new Error("ambiguous sequence");
					sequence = v.startsWith('"') ? JSON.parse(v) : v;
				}
				value(v, depth + 1);
				t = next();
				if (t === "}") break;
				if (t !== ",") throw new Error("invalid separator");
				t = next();
			}
		} else if (first === "[") {
			let t = next();
			if (t === "]") return;
			while (true) {
				value(t, depth + 1);
				t = next();
				if (t === "]") break;
				if (t !== ",") throw new Error("invalid separator");
				t = next();
			}
		} else if (["}", "]", ",", ":"].includes(first))
			throw new Error("invalid value");
	};
	value(next(), 0);
	if (
		raw.slice(offset).trim() !== "" ||
		sequence === undefined ||
		!/^(0|[1-9]\d*)$/.test(sequence) ||
		sequence.length > 64
	)
		throw new Error("invalid sequence");
	const json: unknown = JSON.parse(raw);
	if (!object(json)) throw new Error("invalid object");
	return { json, sequence };
};
const side = (v: unknown): Tuple[] => {
	if (!Array.isArray(v) || v.length === 0 || v.length > 5000)
		throw new Error("invalid depth");
	return v.map((r: unknown) => {
		if (
			!Array.isArray(r) ||
			r.length !== 3 ||
			!decimal(r[0]) ||
			!decimal(r[1]) ||
			!Number.isSafeInteger(r[2]) ||
			r[2] <= 0
		)
			throw new Error("invalid tuple");
		return [r[0], r[1], r[2]];
	});
};
/** Pure offline candidate evidence. HTTP Date/client no-store never establish cache or clock proof. */
export const qualifyCoinbaseL2 = async (
	input: CoinbaseL2Input,
): Promise<CoinbaseL2Result> => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(input.rawBody),
	);
	const base = {
		rawBody: input.rawBody,
		bodySha256: Array.from(new Uint8Array(digest), (n) =>
			n.toString(16).padStart(2, "0"),
		).join(""),
		requestedAt: input.requestedAt,
		receivedAt: input.receivedAt,
		sourceObservedAt: null,
	};
	const reject = (reason: string): CoinbaseL2Result => ({
		...base,
		qualified: false,
		reason,
	});
	if (input.timedOut) return reject("TIMEOUT");
	if (input.status !== 200)
		return reject(input.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR");
	if (
		input.url !==
		`https://api.exchange.coinbase.com/products/${input.scope.productId}/book?level=2`
	)
		return reject("ENDPOINT_IDENTITY_INVALID");
	if (new TextEncoder().encode(input.rawBody).length > 2 * 1024 * 1024)
		return reject("BODY_TOO_LARGE");
	try {
		const { json, sequence } = parseWire(input.rawBody);
		const p = input.product;
		if (!object(p)) return reject("PRODUCT_METADATA_INVALID");
		const product = {
			id: p.id as string,
			base_increment: p.base_increment as string,
			quote_increment: p.quote_increment as string,
			base_min_size: p.base_min_size as string,
			min_market_funds: p.min_market_funds as string,
		};
		const wire = { bids: side(json.bids), asks: side(json.asks) };
		const sourceObservedAt =
			typeof json.time === "string" ? Date.parse(json.time) : NaN;
		const book: Book = {
			productId: input.scope.productId,
			sourceProfileId: input.scope.sourceProfileId,
			cacheStatus: input.cacheStatus,
			requestedAt: input.requestedAt,
			receivedAt: input.receivedAt,
			sourceObservedAt: Number.isFinite(sourceObservedAt)
				? sourceObservedAt
				: null,
			sequence,
			bids: wire.bids.map(([price, quantity]) => ({
				price: Number(price),
				quantity: Number(quantity),
			})),
			asks: wire.asks.map(([price, quantity]) => ({
				price: Number(price),
				quantity: Number(quantity),
			})),
		};
		const qualification = evaluateP7SourceCandidate({
			scope: input.scope,
			product: p,
			auctionMode: json.auction_mode,
			book,
			requiredBaseQuantity: input.requiredBaseQuantity,
		});
		return {
			...base,
			sourceObservedAt: Number.isFinite(sourceObservedAt)
				? sourceObservedAt
				: null,
			product,
			wire,
			book,
			...qualification,
		};
	} catch {
		return reject("WIRE_INVALID");
	}
};
