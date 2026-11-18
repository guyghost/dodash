import { bindings, defineConfig } from "cf/config";

export default defineConfig(({ mode }) => {
	const isPaper = mode === "paper";

	return {
		worker: {
			name: isPaper
				? "dodash-paper-dashboard-api"
				: "dodash-dashboard-api",
			compatibilityDate: "2026-08-18",
			...(isPaper ? { compatibilityFlags: ["nodejs_compat"] } : {}),
			entrypoint: "src/worker.ts",
			workersDev: isPaper,
			observability: {
				enabled: true,
				headSamplingRate: 1,
			},
			env: {
				...(isPaper
					? { PUBLIC_READ_ONLY: bindings.text("true") }
					: {}),
				AGENT_SERVICE: bindings.worker({
					worker: isPaper ? "dodash-paper-agent" : "dodash-agent",
				}),
			},
		},
	};
});
