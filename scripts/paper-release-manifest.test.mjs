import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	copyFileSync,
	rmSync,
	appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const apps = ["agent", "mcp-market-data", "dashboard-api", "dashboard"];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "paper-manifest-test-"));
	mkdirSync(join(root, "scripts"));
	copyFileSync(
		new URL("./paper-release-manifest.mjs", import.meta.url),
		join(root, "scripts/paper-release-manifest.mjs"),
	);
	const git = (args) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	git(["init", "-q"]);
	git(["config", "commit.gpgsign", "false"]);
	git(["config", "core.hooksPath", "/dev/null"]);
	git(["config", "user.name", "Fixture"]);
	git(["config", "user.email", "fixture@example.invalid"]);
	for (const app of apps) {
		mkdirSync(join(root, "apps", app), { recursive: true });
		writeFileSync(
			join(root, "apps", app, "wrangler.paper.jsonc"),
			JSON.stringify({
				name: "dodash-paper-" + app,
				main: "src/worker.ts",
				vars:
					app === "agent"
						? {
								LIVE_TRADING_ENABLED: "false",
								HYPERLIQUID_PERP_TRADING_ENABLED: "false",
							}
						: {},
			}),
		);
	}
	git(["add", "."]);
	git(["commit", "-qm", "fixture"]);
	const gitSha = git(["rev-parse", "HEAD"]);
	const paths = execFileSync("git", ["ls-files", "-z"], {
		cwd: root,
		encoding: "utf8",
	})
		.split("\0")
		.filter(Boolean);
	const inputSha256 = createHash("sha256")
		.update(paths.map((p) => p + "\0" + hash(join(root, p))).join("\n"))
		.digest("hex");
	const bundles = mkdtempSync(join(tmpdir(), "paper-manifest-bundles-"));
	const outputs = [];
	for (const app of apps) {
		mkdirSync(join(bundles, app));
		const path = app + "/worker.js";
		writeFileSync(
			join(bundles, path),
			'export default {fetch(){return new Response("fixture")}}',
		);
		outputs.push({ path, sha256: hash(join(bundles, path)) });
	}
	writeFileSync(
		join(bundles, "paper-build-provenance.json"),
		JSON.stringify({ gitSha, inputSha256, outputs }),
	);
	const run = (bundle = bundles) =>
		spawnSync(
			process.execPath,
			[
				"scripts/paper-release-manifest.mjs",
				bundle,
				join(bundles, "result.json"),
			],
			{ cwd: root, encoding: "utf8" },
		);
	return {
		root,
		bundles,
		run,
		close() {
			rmSync(root, { recursive: true, force: true });
			rmSync(bundles, { recursive: true, force: true });
		},
	};
}
function check(name, modify, expected) {
	test(name, () => {
		const f = fixture();
		try {
			const bundle = modify(f);
			const result = f.run(bundle);
			assert.equal(result.status, expected ? 1 : 0, result.stderr);
			if (expected) assert.match(result.stderr, new RegExp(expected));
		} finally {
			f.close();
		}
	});
}
check(
	"empty unrelated bundle directories reject missing provenance",
	(f) => {
		const empty = join(f.bundles, "empty");
		mkdirSync(empty);
		return empty;
	},
	"MISSING_BUILD_PROVENANCE",
);
check(
	"stale SHA provenance rejects",
	(f) => {
		const p = join(f.bundles, "paper-build-provenance.json");
		const v = JSON.parse(readFileSync(p));
		v.gitSha = "stale";
		writeFileSync(p, JSON.stringify(v));
	},
	"STALE_BUILD_PROVENANCE",
);
check(
	"modified bundle rejects fingerprint mismatch",
	(f) => appendFileSync(join(f.bundles, "agent/worker.js"), "changed"),
	"BUNDLE_FINGERPRINT_MISMATCH",
);
check(
	"tracked dirty source rejects",
	(f) => appendFileSync(join(f.root, "apps/agent/wrangler.paper.jsonc"), " "),
	"DIRTY_SOURCE",
);
check(
	"untracked source rejects",
	(f) =>
		writeFileSync(
			join(f.root, "apps/agent/untracked.ts"),
			"export const changed=true",
		),
	"DIRTY_SOURCE",
);
check(
	"untracked root config rejects",
	(f) => writeFileSync(join(f.root, "tsconfig.extra.json"), "{}"),
	"DIRTY_SOURCE",
);
check("unrelated untracked analysis evidence is preserved and allowed", (f) => {
	mkdirSync(join(f.root, "docs/analysis"), { recursive: true });
	writeFileSync(
		join(f.root, "docs/analysis/user-evidence.json"),
		"original evidence bytes",
	);
});
