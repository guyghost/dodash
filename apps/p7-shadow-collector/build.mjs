import { build } from "esbuild";

await build({
	entryPoints: ["src/worker.ts"],
	outfile: "dist/worker.js",
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2023",
	external: ["cloudflare:workers"],
});
