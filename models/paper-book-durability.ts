/**
 * Durabilité du book paper (amendement 2026-11-14).
 *
 * Le book est le fait comptable par produit : cash, quantité, prix moyen.
 * Un redéploiement, un redémarrage de Durable Object ou un `/start` le
 * recopient. Seul un `RESET` explicite le remplace par le capital initial
 * et produit l'audit `portfolio.reset`. Aucune horloge, aucun I/O.
 */

export interface DurablePaperPosition {
	readonly productId: string;
	readonly cash: number;
	readonly positionQuantity: number;
	readonly averagePrice: number;
}

export interface DurablePaperBook {
	readonly products: readonly DurablePaperPosition[];
}

export interface PaperBookResetAudit {
	readonly event: "portfolio.reset";
	readonly explicit: true;
	readonly before: readonly DurablePaperPosition[];
	readonly after: readonly DurablePaperPosition[];
}

export type PaperBookCommand =
	| { readonly type: "DEPLOY_OR_RESTART" }
	| { readonly type: "START" }
	| {
			readonly type: "RESET";
			readonly explicit: boolean;
			readonly initialCapital: number;
	  };

export type PaperBookCommandResult =
	| {
			readonly ok: true;
			readonly book: DurablePaperBook;
			readonly audit: PaperBookResetAudit | null;
	  }
	| {
			readonly ok: false;
			readonly reason: "RESET_NOT_EXPLICIT" | "INVALID_BOOK";
	  };

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const sortPositions = (
	products: readonly DurablePaperPosition[],
): readonly DurablePaperPosition[] =>
	Object.freeze(
		[...products]
			.map((position) => Object.freeze({ ...position }))
			.sort((left, right) =>
				left.productId < right.productId
					? -1
					: left.productId > right.productId
						? 1
						: 0,
			),
	);

const freezeBook = (
	products: readonly DurablePaperPosition[],
): DurablePaperBook => Object.freeze({ products: sortPositions(products) });

const invalid = (
	reason: "RESET_NOT_EXPLICIT" | "INVALID_BOOK",
): PaperBookCommandResult => Object.freeze({ ok: false, reason });

const preserved = (book: DurablePaperBook): PaperBookCommandResult =>
	Object.freeze({
		ok: true,
		book: freezeBook(book.products),
		audit: null,
	});

/** Lecture fermée d'un book persisté. Un écart de forme est un null, jamais un book à zéro. */
export const parseDurablePaperBook = (raw: unknown): DurablePaperBook | null => {
	if (!isRecord(raw) || !Array.isArray(raw.products)) return null;
	const products: DurablePaperPosition[] = [];
	const seen = new Set<string>();
	for (const entry of raw.products) {
		if (!isRecord(entry) || typeof entry.productId !== "string") return null;
		if (entry.productId.length === 0 || seen.has(entry.productId)) return null;
		if (
			!isFiniteNumber(entry.cash) ||
			!isFiniteNumber(entry.positionQuantity) ||
			!isFiniteNumber(entry.averagePrice)
		) {
			return null;
		}
		seen.add(entry.productId);
		products.push({
			productId: entry.productId,
			cash: entry.cash,
			positionQuantity: entry.positionQuantity,
			averagePrice: entry.averagePrice,
		});
	}
	if (products.length === 0) return null;
	return freezeBook(products);
};

/**
 * Book en mémoire s'il existe, sinon la copie durable. Un blob d'état
 * réinitialisé (session absente) ne fabrique pas un book à 10 000.
 * Un reset déjà écrit en mémoire n'est pas ressuscité depuis une copie plus ancienne.
 */
export const paperBookAfterRestart = (
	inMemory: DurablePaperBook | null,
	durable: DurablePaperBook | null,
): DurablePaperBook | null => inMemory ?? durable;

export const applyPaperBookCommand = (
	book: DurablePaperBook,
	command: PaperBookCommand,
): PaperBookCommandResult => {
	const parsed = parseDurablePaperBook(book);
	if (parsed === null) return invalid("INVALID_BOOK");
	if (command.type === "DEPLOY_OR_RESTART" || command.type === "START") {
		return preserved(parsed);
	}
	if (command.explicit !== true) return invalid("RESET_NOT_EXPLICIT");
	if (!isFiniteNumber(command.initialCapital) || command.initialCapital <= 0) {
		return invalid("INVALID_BOOK");
	}
	const after = freezeBook(
		parsed.products.map((position) => ({
			productId: position.productId,
			cash: command.initialCapital,
			positionQuantity: 0,
			averagePrice: 0,
		})),
	);
	const audit: PaperBookResetAudit = Object.freeze({
		event: "portfolio.reset",
		explicit: true,
		before: parsed.products,
		after: after.products,
	});
	return Object.freeze({ ok: true, book: after, audit });
};
