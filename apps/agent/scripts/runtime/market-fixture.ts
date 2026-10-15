let fixtureClose: number | null = null;
export default {
	async fetch(request: Request, env: any) {
		const body: any = await request.json();
		if (new URL(request.url).pathname === "/control") {
			fixtureClose = body.close;
			return Response.json({ ok: true });
		}
		if (new URL(request.url).pathname.endsWith("/ticker"))
			return Response.json({
				productId: body.productId,
				price: 10,
				observedAt: Number(fixtureClose ?? env.CANDLE_CLOSE),
				source: "coinbase",
				cached: false,
			});
		const close = Number(
			fixtureClose ?? env.CANDLE_CLOSE ?? body.end * 1_000 + 60_000,
		);
		return Response.json({
			productId: body.productId,
			timeframe: body.timeframe,
			candles: Array.from({ length: 100 }, (_, i) => ({
				start: close - (100 - i) * 60_000,
				open: 10,
				high: 11,
				low: 9,
				close: 10,
				volume: 10,
			})),
			source: "coinbase",
			cached: false,
		});
	},
};
