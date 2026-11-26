export interface PaperPositionProtection {
	readonly side: "LONG" | "SHORT";
	readonly averagePrice: number;
	readonly enteredAt: number | null;
	readonly extremePrice: number;
	readonly stopLossPrice: number;
	readonly takeProfitPrice: number;
}

export interface PaperPositionProtectionInput {
	readonly positionQuantity: number;
	readonly averagePrice: number;
	readonly enteredAt: number | null;
	readonly candles: readonly {
		readonly start: number;
		readonly high: number;
		readonly low: number;
		readonly close: number;
	}[];
	readonly timeframeMs?: number;
	readonly atr?: number;
	readonly risk: {
		readonly stopLossBps: number;
		readonly takeProfitBps: number;
		readonly atrStopLossMultiple?: number;
		readonly atrTakeProfitMultiple?: number;
	};
}

export const normalizePaperPositionProtection = (
	value: unknown,
): PaperPositionProtection | null => {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as Partial<PaperPositionProtection>;
	if (
		(candidate.side !== "LONG" && candidate.side !== "SHORT") ||
		typeof candidate.averagePrice !== "number" ||
		!Number.isFinite(candidate.averagePrice) ||
		candidate.averagePrice <= 0 ||
		!(
			candidate.enteredAt === null ||
			(Number.isSafeInteger(candidate.enteredAt) &&
				Number(candidate.enteredAt) >= 0)
		) ||
		typeof candidate.extremePrice !== "number" ||
		!Number.isFinite(candidate.extremePrice) ||
		candidate.extremePrice <= 0 ||
		typeof candidate.stopLossPrice !== "number" ||
		!Number.isFinite(candidate.stopLossPrice) ||
		typeof candidate.takeProfitPrice !== "number" ||
		!Number.isFinite(candidate.takeProfitPrice)
	)
		return null;
	if (
		(candidate.side === "LONG" &&
			candidate.extremePrice < candidate.averagePrice) ||
		(candidate.side === "SHORT" &&
			candidate.extremePrice > candidate.averagePrice)
	)
		return null;
	return Object.freeze({
		side: candidate.side,
		averagePrice: candidate.averagePrice,
		enteredAt: candidate.enteredAt as number | null,
		extremePrice: candidate.extremePrice,
		stopLossPrice: candidate.stopLossPrice,
		takeProfitPrice: candidate.takeProfitPrice,
	});
};

export const resolvePaperPositionProtection = (
	previous: PaperPositionProtection | null,
	input: PaperPositionProtectionInput,
): PaperPositionProtection | null => {
	const last = input.candles.at(-1);
	if (
		!Number.isFinite(input.positionQuantity) ||
		input.positionQuantity === 0 ||
		!Number.isFinite(input.averagePrice) ||
		input.averagePrice <= 0 ||
		last === undefined
	)
		return null;
	const side = input.positionQuantity > 0 ? "LONG" : "SHORT";
	const normalized = normalizePaperPositionProtection(previous);
	const carried =
		normalized?.side === side &&
		normalized.averagePrice === input.averagePrice &&
		normalized.enteredAt === input.enteredAt
			? normalized
			: null;
	const inferredDuration =
		input.candles.length >= 2
			? Math.max(0, input.candles[1]!.start - input.candles[0]!.start)
			: 0;
	const duration =
		input.timeframeMs !== undefined &&
		Number.isFinite(input.timeframeMs) &&
		input.timeframeMs > 0
			? input.timeframeMs
			: inferredDuration;
	const candles =
		input.enteredAt === null
			? []
			: input.candles.filter((candle) =>
					duration > 0
						? candle.start + duration > input.enteredAt!
						: candle.start >= input.enteredAt!,
				);
	const useAtr =
		input.atr !== undefined &&
		Number.isFinite(input.atr) &&
		input.atr > 0 &&
		input.risk.atrStopLossMultiple !== undefined &&
		input.risk.atrTakeProfitMultiple !== undefined;
	const atr = useAtr ? input.atr! : 0;
	const stopDistance = Math.max(
		(input.averagePrice * input.risk.stopLossBps) / 10_000,
		atr * (input.risk.atrStopLossMultiple ?? 0),
	);
	const takeDistance = Math.max(
		(input.averagePrice * input.risk.takeProfitBps) / 10_000,
		atr * (input.risk.atrTakeProfitMultiple ?? 0),
	);
	const extremePrice =
		side === "LONG"
			? Math.max(
					input.averagePrice,
					last.close,
					carried?.extremePrice ?? input.averagePrice,
					...candles.map((candle) => candle.high),
				)
			: Math.min(
					input.averagePrice,
					last.close,
					carried?.extremePrice ?? input.averagePrice,
					...candles.map((candle) => candle.low),
				);
	const peakGainBps =
		(Math.abs(extremePrice - input.averagePrice) / input.averagePrice) * 10_000;
	const trailingDistance = Math.max(atr * 1.5, extremePrice * 0.004);
	const baseStop =
		side === "LONG"
			? input.averagePrice - stopDistance
			: input.averagePrice + stopDistance;
	const anchoredStop = carried?.stopLossPrice ?? baseStop;
	const trailingStop =
		peakGainBps < 75
			? anchoredStop
			: side === "LONG"
				? Math.max(input.averagePrice * 1.001, extremePrice - trailingDistance)
				: Math.min(input.averagePrice * 0.999, extremePrice + trailingDistance);
	return normalizePaperPositionProtection({
		side,
		averagePrice: input.averagePrice,
		enteredAt: input.enteredAt,
		extremePrice,
		stopLossPrice:
			peakGainBps < 75
				? anchoredStop
				: side === "LONG"
					? Math.max(anchoredStop, trailingStop)
					: Math.min(anchoredStop, trailingStop),
		takeProfitPrice:
			carried?.takeProfitPrice ??
			(side === "LONG"
				? input.averagePrice + takeDistance
				: input.averagePrice - takeDistance),
	});
};
