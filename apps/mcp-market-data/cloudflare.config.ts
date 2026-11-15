import { bindings, defineConfig } from "cf/config";

export default defineConfig(({ mode }) => {
	const isPaper = mode === "paper";

	return {
		worker: {
			name: isPaper
				? "dodash-paper-mcp-market-data"
				: "dodash-mcp-market-data",
			compatibilityDate: "2026-08-18",
			compatibilityFlags: ["nodejs_compat"],
			entrypoint: "src/index.ts",
			workersDev: isPaper,
			observability: {
				enabled: true,
				headSamplingRate: 1,
			},
			env: {
				COINBASE_API_BASE_URL: bindings.text("https://api.coinbase.com"),
				MARKET_CACHE_TTL_SECONDS: bindings.text(isPaper ? "300" : "30"),
				MARKET_CACHE: bindings.kv({
					id: isPaper
						? "abddec98934a40a4b4c85f8d00e5f055"
						: "72c126510250480580b0115a47a5cbcf",
				}),
			},
		},
	};
});
