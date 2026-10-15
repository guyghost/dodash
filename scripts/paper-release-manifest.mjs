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

const root = resolve(import.meta.dirname, "..");
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
const dashboardConfigPath = join(root, "apps/dashboard/wrangler.paper.jsonc");
const dashboardConfig = JSON.parse(
	readFileSync(dashboardConfigPath, "utf8").replace(/^\s*\/\/.*$/gm, ""),
);
const assetSource = resolve(
	root,
	"apps/dashboard",
	dashboardConfig.assets?.directory ?? "dist/client",
);
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
		.filter((p) => p !== "paper-build-provenance.json" && p !== "wrangler.log");
if (process.argv.includes("--prepare")) {
	if (existsSync(bundles))
		throw new Error("BUNDLE_ROOT_EXISTS: refuse stale or unrelated outputs");
	mkdirSync(bundles, { recursive: true });
	const run = (args, cwd = root) =>
		execFileSync(process.execPath, args, {
			cwd,
			stdio: "inherit",
			env: { ...process.env, WRANGLER_LOG_PATH: join(bundles, "wrangler.log") },
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
	for (const app of ["agent", "mcp-market-data", "dashboard-api", "dashboard"])
		run(
			[
				join(root, "apps/agent/node_modules/wrangler/bin/wrangler.js"),
				"deploy",
				"--dry-run",
				"--config",
				"wrangler.paper.jsonc",
				"--outdir",
				join(bundles, app),
			],
			join(root, "apps", app),
		);
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
					sourceDirectory: dashboardConfig.assets.directory,
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
	provenance.assets.sourceDirectory !== dashboardConfig.assets?.directory ||
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
const workers = ["agent", "mcp-market-data", "dashboard-api", "dashboard"].map(
	(app) => {
		const path = join(root, "apps", app, "wrangler.paper.jsonc");
		const config = JSON.parse(
			readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, ""),
		);
		if (!config.name.startsWith("dodash-paper-"))
			throw new Error("non-paper worker");
		for (const service of config.services ?? [])
			if (!service.service.startsWith("dodash-paper-"))
				throw new Error("non-paper service");
		for (const dataset of config.analytics_engine_datasets ?? [])
			if (!dataset.dataset.startsWith("dodash_paper_"))
				throw new Error("non-paper dataset");
		if (app === "agent")
			for (const flag of [
				"LIVE_TRADING_ENABLED",
				"HYPERLIQUID_PERP_TRADING_ENABLED",
			])
				if (config.vars[flag] !== "false") throw new Error("live flag enabled");
		const entry = basename(config.main).replace(/\.ts$/, ".js");
		if (
			!existsSync(join(bundles, app, entry)) ||
			readFileSync(join(bundles, app, entry)).length === 0
		)
			throw new Error("MISSING_ENTRY_BUNDLE");
		return {
			entry,
			app,
			name: config.name,
			configSha256: hash(path),
			services: config.services ?? [],
			datasets: config.analytics_engine_datasets ?? [],
			vars: config.vars ?? {},
			bundles: files(join(bundles, app)).map((path) => ({
				path: path.slice(bundles.length + 1),
				sha256: hash(path),
			})),
		};
	},
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
	config: "wrangler.paper.jsonc only",
	workers,
};
writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
console.log(output);
