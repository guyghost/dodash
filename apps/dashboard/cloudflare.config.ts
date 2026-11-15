import { bindings, defineConfig } from "cf/config";

export default defineConfig(({ mode }) => {
	const isPaper = mode === "paper";

	return {
		worker: {
			name: isPaper ? "dodash-paper-dashboard" : "dodash-dashboard",
			compatibilityDate: "2026-08-18",
			entrypoint: "cloudflare/index.ts",
			workersDev: true,
			observability: {
				enabled: true,
				headSamplingRate: 1,
			},
			assets: {
				notFoundHandling: "single-page-application",
				runWorkerFirst: ["/api", "/api/*", "/health"],
			},
			env: {
				DASHBOARD_API: bindings.worker({
					worker: isPaper
						? "dodash-paper-dashboard-api"
						: "dodash-dashboard-api",
				}),
				AUTH_RATE_LIMITER: bindings.rateLimit({
					namespace: "519437",
					simple: {
						limit: 100,
						period: 60,
					},
				}),
				ASSETS: bindings.assets(),
			},
		},
	};
});
