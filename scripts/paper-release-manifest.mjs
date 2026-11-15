import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const loadPaperWorkerConfig = async (app) => {
	const configPath = join(root, "apps", app, "cloudflare.config.ts");
	const mod = await import(pathToFileURL(configPath).href);
	const resolved =
		typeof mod.default === "function"
			? await mod.default({ mode: "paper", command: "deploy" })
			: mod.default;
	return { configPath, worker: resolved.worker };
};
const bundles = process.argv[2] && resolve(process.argv[2]);
const output = process.argv[3] && resolve(process.argv[3]);
if (!bundles || !output)
	throw new Error(
		"Usage: node scripts/paper-release-manifest.mjs BUNDLE_ROOT OUTPUT",
	);
const hash = (path) =>
	createHash("sha256").update(readFileSync(path)).digest("hex");
const files = (dir) =>
	readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) =>
			entry.isDirectory()
				? files(join(dir, entry.name))
				: [join(dir, entry.name)],
		)
		.sort();
const gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
	cwd: root,
	encoding: "utf8",
}).trim();
const trackedDirty = execFileSync("git", ["diff", "HEAD", "--name-only"], {
	cwd: root,
	encoding: "utf8",
}).trim();
const untracked = execFileSync(
	"git",
	["ls-files", "--others", "--exclude-standard", "-z"],
	{ cwd: root, encoding: "utf8" },
)
	.split("\0")
	.filter(Boolean);
const codeInput = (p) =>
	/^(apps|models|packages|scripts)\//.test(p) ||
	/^[^/]*(package|lock|config|biome|turbo)[^/]*\.(json|jsonc|yaml|yml|ts|js|mjs)$/.test(
		p,
	);
if (trackedDirty || untracked.some(codeInput))
	throw new Error(
		"DIRTY_SOURCE: commit tracked changes and untracked build inputs before preparation",
	);
const sourceFiles = execFileSync("git", ["ls-files", "-z"], {
	cwd: root,
	encoding: "utf8",
})
	.split("\0")
	.filter(Boolean);
const inputSha256 = createHash("sha256")
	.update(sourceFiles.map((p) => p + "\0" + hash(join(root, p))).join("\n"))
	.digest("hex");
const { configPath: dashboardConfigPath, worker: dashboardWorker } =
	await loadPaperWorkerConfig("dashboard");
const assetDirectory =
	dashboardWorker.assets?.directory ?? "./dist/client";
const assetSource = resolve(root, "apps/dashboard", assetDirectory);
const assetSnapshot = join(bundles, "dashboard/assets/client");
const assetTree = (dir) => {
	if (
		!existsSync(join(dir, "index.html")) ||
		readFileSync(join(dir, "index.html")).length === 0
	)
		throw new Error("MISSING_CLIENT_ENTRY");
	return files(dir).map((p) => ({
		path: p.slice(dir.length + 1),
		sha256: hash(p),
	}));
};
const provenancePath = join(bundles, "paper-build-provenance.json");
const payloadTree = () =>
	files(bundles)
		.map((p) => p.slice(bundles.length + 1))
		.filter((p) => p !== "paper-build-provenance.json" && p !== "cf.log");
if (process.argv.includes("--prepare")) {
	if (existsSync(bundles))
		throw new Error("BUNDLE_ROOT_EXISTS: refuse stale or unrelated outputs");
	mkdirSync(bundles, { recursive: true });
	const run = (args, cwd = root, cmd = process.execPath) =>
		execFileSync(cmd, args, {
			cwd,
			stdio: "inherit",
		});
	for (const pkg of [
		"packages/domain",
		"models",
		"packages/indicators-prolog",
		"packages/risk",
		"packages/allocator",
		"packages/paper-execution",
		"packages/strategies",
	])
		run([
			"node_modules/typescript/bin/tsc",
			"-p",
			pkg + "/tsconfig.build.json",
		]);
	run(["node_modules/vite/bin/vite.js", "build"], join(root, "apps/dashboard"));
	run(["scripts/prepare-sites-build.mjs"], join(root, "apps/dashboard"));
	const cfBin = join(root, "node_modules/.bin/cf");
	for (const app of ["agent", "mcp-market-data", "dashboard-api", "dashboard"]) {
		const appDir = join(root, "apps", app);
		run(["build", "--mode", "paper"], appDir, cfBin);
		cpSync(join(appDir, ".cloudflare/output"), join(bundles, app), {
			recursive: true,
		});
	}
	cpSync(assetSource, assetSnapshot, {
		recursive: true,
		errorOnExist: true,
		force: false,
	});
	writeFileSync(
		provenancePath,
		JSON.stringify(
			{
				gitSha,
				inputSha256,
				command: "paper-release-manifest --prepare",
				assets: {
					sourceDirectory: assetDirectory,
					snapshotDirectory: "dashboard/assets/client",
					configSha256: hash(dashboardConfigPath),
					files: assetTree(assetSnapshot),
				},
				outputs: payloadTree().map((path) => ({
					path,
					sha256: hash(join(bundles, path)),
				})),
			},
			null,
			2,
		) + "\n",
		{ flag: "wx" },
	);
}
if (!existsSync(provenancePath)) throw new Error("MISSING_BUILD_PROVENANCE");
const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
if (provenance.gitSha !== gitSha || provenance.inputSha256 !== inputSha256)
	throw new Error("STALE_BUILD_PROVENANCE");
if (
	!provenance.assets ||
	provenance.assets.configSha256 !== hash(dashboardConfigPath) ||
	provenance.assets.sourceDirectory !== assetDirectory ||
	provenance.assets.snapshotDirectory !== "dashboard/assets/client"
)
	throw new Error("MISSING_ASSET_PROVENANCE");
if (
	JSON.stringify(assetTree(assetSnapshot)) !==
	JSON.stringify(provenance.assets.files)
)
	throw new Error("ASSET_SNAPSHOT_MISMATCH");
if (
	JSON.stringify(assetTree(assetSource)) !==
	JSON.stringify(provenance.assets.files)
)
	throw new Error("ASSET_SOURCE_DRIFT");
if (!Array.isArray(provenance.outputs))
	throw new Error("INVALID_BUNDLE_PROVENANCE");
const outputPaths = provenance.outputs.map((item) => {
	if (
		!item ||
		typeof item.path !== "string" ||
		item.path
			.split("/")
			.some((part) => !part || part === "." || part === "..") ||
		item.path.includes("\\") ||
		!/^[a-f0-9]{64}$/.test(item.sha256)
	)
		throw new Error("INVALID_BUNDLE_PROVENANCE");
	return item.path;
});
if (new Set(outputPaths).size !== outputPaths.length)
	throw new Error("INVALID_BUNDLE_PROVENANCE");
if (JSON.stringify(payloadTree()) !== JSON.stringify([...outputPaths].sort()))
	throw new Error("BUNDLE_TREE_MISMATCH");
for (const item of provenance.outputs)
	if (hash(join(bundles, item.path)) !== item.sha256)
		throw new Error("BUNDLE_FINGERPRINT_MISMATCH");
const workers = await Promise.all(
	["agent", "mcp-market-data", "dashboard-api", "dashboard"].map(
		async (app) => {
			const { configPath, worker: config } = await loadPaperWorkerConfig(app);
			if (!config.name.startsWith("dodash-paper-"))
				throw new Error("non-paper worker");
			const envEntries = Object.entries(config.env ?? {});
			const services = envEntries
				.filter(([, binding]) => binding?.type === "worker")
				.map(([binding, b]) => ({ binding, service: b.worker }));
			const datasets = envEntries
				.filter(([, binding]) => binding?.type === "analytics-engine-dataset")
				.map(([binding, b]) => ({ binding, dataset: b.name }));
			const vars = Object.fromEntries(
				envEntries
					.filter(([, binding]) => binding?.type === "text")
					.map(([k, b]) => [k, b.value]),
			);
			for (const service of services)
				if (!service.service.startsWith("dodash-paper-"))
					throw new Error("non-paper service");
			for (const dataset of datasets)
				if (!dataset.dataset.startsWith("dodash_paper_"))
					throw new Error("non-paper dataset");
			if (app === "agent")
				for (const flag of [
					"LIVE_TRADING_ENABLED",
					"HYPERLIQUID_PERP_TRADING_ENABLED",
				])
					if (vars[flag] !== "false") throw new Error("live flag enabled");
			const entry = basename(config.entrypoint).replace(/\.ts$/, ".js");
			if (
				!existsSync(join(bundles, app, entry)) ||
				readFileSync(join(bundles, app, entry)).length === 0
			)
				throw new Error("MISSING_ENTRY_BUNDLE");
			return {
				entry,
				app,
				name: config.name,
				configSha256: hash(configPath),
				services,
				datasets,
				vars,
				bundles: files(join(bundles, app)).map((path) => ({
					path: path.slice(bundles.length + 1),
					sha256: hash(path),
				})),
			};
		},
	),
);
const manifest = {
	assets: provenance.assets,
	inputSha256,
	provenanceSha256: hash(provenancePath),
	gitSha: execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim(),
	preparedOnly: true,
	deployed: false,
	managedSecrets: "preserve; no secret writes authorized",
	config: "cloudflare.config.ts (mode: paper) only",
	workers,
};
writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
console.log(output);
