import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
	worker: {
		name: "p7-shadow-collector-local-preparation",
		compatibilityDate: "2026-08-20",
		entrypoint: "src/worker.ts",
		workersDev: false,
		previewUrls: false,
		env: {
			LOCAL_FIXTURES_ENABLED: bindings.text("false"),
			PROSPECTIVE_ENABLED: bindings.text("false"),
			ARCHIVE: bindings.r2({
				name: "p7-shadow-not-provisioned",
			}),
			CAMPAIGNS: bindings.durableObject({
				worker: "p7-shadow-collector-local-preparation",
				exportName: "P7Campaign",
			}),
		},
		exports: {
			P7Campaign: exports.durableObject({
				storage: "sqlite",
			}),
		},
	},
});
