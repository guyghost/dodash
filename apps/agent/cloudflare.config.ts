import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig(({ mode }) => {
	const isPaper = mode === "paper";
	const workerName = isPaper ? "dodash-paper-agent" : "dodash-agent";

	return {
		worker: {
			name: workerName,
			compatibilityDate: "2026-08-18",
			compatibilityFlags: ["nodejs_compat"],
			entrypoint: "src/worker.ts",
			workersDev: isPaper,
			observability: {
				enabled: true,
				headSamplingRate: 1,
			},
			env: {
				...(isPaper
					? {
							LIVE_TRADING_ENABLED: bindings.text("false"),
							HYPERLIQUID_PERP_TRADING_ENABLED: bindings.text("false"),
							AI_TREND_TIMEFRAME: bindings.text("ONE_DAY"),
							AI_TREND_V2: bindings.text("true"),
						}
					: {}),
				TRADING_TELEMETRY: bindings.analyticsEngineDataset({
					name: isPaper ? "dodash_paper_trading" : "dodash_trading",
				}),
				MARKET_DATA: bindings.worker({
					worker: isPaper
						? "dodash-paper-mcp-market-data"
						: "dodash-mcp-market-data",
				}),
				TRADING_AGENT: bindings.durableObject({
					worker: workerName,
					exportName: "TradingAgent",
				}),
			},
			exports: {
				TradingAgent: exports.durableObject({
					storage: "sqlite",
				}),
			},
		},
	};
});
