import { describe, expect, it } from "vitest";

import {
	applyPaperBookCommand,
	paperBookAfterRestart,
	parseDurablePaperBook,
	type DurablePaperBook,
} from "./paper-book-durability.js";

/** Book observé avant le redéploiement du 6 novembre 2026 : ~21,1 k$, positions ouvertes. */
const openBook = (): DurablePaperBook => ({
	products: [
		{
			productId: "BTC-USD",
			cash: 11_050,
			positionQuantity: 0.1288,
			averagePrice: 84_200,
		},
		{
			productId: "ETH-USD",
			cash: 10_050,
			positionQuantity: 4.4347,
			averagePrice: 2_450,
		},
	],
});

describe("paper book durability", () => {
	it("keeps balances and positions across a deploy or Durable Object restart", () => {
		const book = openBook();
		const result = applyPaperBookCommand(book, { type: "DEPLOY_OR_RESTART" });
		expect(result).toEqual({ ok: true, book: parseDurablePaperBook(book), audit: null });
	});

	it("keeps balances and positions when trading is started again", () => {
		const result = applyPaperBookCommand(openBook(), { type: "START" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.audit).toBeNull();
		expect(result.book.products).toEqual([
			expect.objectContaining({
				productId: "BTC-USD",
				cash: 11_050,
				positionQuantity: 0.1288,
			}),
			expect.objectContaining({
				productId: "ETH-USD",
				cash: 10_050,
				positionQuantity: 4.4347,
			}),
		]);
	});

	it("rejects a reset that is not an explicit command", () => {
		expect(
			applyPaperBookCommand(openBook(), {
				type: "RESET",
				explicit: false,
				initialCapital: 10_000,
			}),
		).toEqual({ ok: false, reason: "RESET_NOT_EXPLICIT" });
	});

	it("resets every sleeve to initial capital only on an explicit request and audits both sides", () => {
		const result = applyPaperBookCommand(openBook(), {
			type: "RESET",
			explicit: true,
			initialCapital: 10_000,
		});
		expect(result.ok).toBe(true);
		if (!result.ok || result.audit === null) return;
		expect(result.audit.event).toBe("portfolio.reset");
		expect(result.audit.explicit).toBe(true);
		expect(result.audit.before.map((position) => position.positionQuantity)).toEqual([
			0.1288,
			4.4347,
		]);
		expect(result.book.products).toEqual([
			{ productId: "BTC-USD", cash: 10_000, positionQuantity: 0, averagePrice: 0 },
			{ productId: "ETH-USD", cash: 10_000, positionQuantity: 0, averagePrice: 0 },
		]);
		expect(result.audit.after).toEqual(result.book.products);
	});

	it("recovers the durable book when the in-memory state blob was wiped", () => {
		const durable = parseDurablePaperBook(openBook());
		expect(paperBookAfterRestart(null, durable)).toEqual(durable);
	});

	it("does not resurrect an older durable book over a book already in memory", () => {
		const flat = parseDurablePaperBook({
			products: [
				{ productId: "BTC-USD", cash: 10_000, positionQuantity: 0, averagePrice: 0 },
				{ productId: "ETH-USD", cash: 10_000, positionQuantity: 0, averagePrice: 0 },
			],
		});
		const durable = parseDurablePaperBook(openBook());
		expect(paperBookAfterRestart(flat, durable)).toBe(flat);
	});

	it("refuses a malformed durable payload instead of inventing a flat book", () => {
		expect(parseDurablePaperBook({ products: [{ productId: "BTC-USD", cash: 10_000 }] })).toBe(
			null,
		);
		expect(
			applyPaperBookCommand(
				{ products: [] },
				{ type: "RESET", explicit: true, initialCapital: 10_000 },
			),
		).toEqual({ ok: false, reason: "INVALID_BOOK" });
	});
});
