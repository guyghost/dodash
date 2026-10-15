import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("wrangler/package.json"))(
	"esbuild",
);
const { Miniflare, convertV4MiniflareOptions } = createRequire(
	require.resolve("wrangler/package.json"),
)("miniflare");
test("offline L2 fixture qualification executes in workerd with no outbound fetch", async () => {
	const directory = await mkdtemp(join(tmpdir(), "p7-source-fixture-"));
	const scriptPath = join(directory, "fixture.js");
	await build({
		stdin: {
			contents:
				'import { qualifyCoinbaseL2 } from "./src/coinbase-l2.ts"; export default { async fetch(request) { return Response.json(await qualifyCoinbaseL2(await request.json())); } };',
			resolveDir: resolve("."),
		},
		bundle: true,
		format: "esm",
		outfile: scriptPath,
		platform: "browser",
		target: "es2022",
	});
	let calls = 0;
	const runtime = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: readFileSync(scriptPath, "utf8"),
			compatibilityDate: "2026-08-18",
			outboundService: () => {
				calls++;
				throw new Error("offline fixture must not fetch");
			},
		}),
	);
	const close = Date.UTC(2026, 9, 15);
	const fixture = {
		scope: {
			productId: "BTC-USD",
			sourceProfileId: "candidate",
			clockVerified: true,
			campaignStartAt: close,
			campaignEndAt: close + 180 * 86400000,
			candleClosedAt: close,
			intentPersistedAt: close + 1,
			previousSequence: null,
		},
		url: "https://api.exchange.coinbase.com/products/BTC-USD/book?level=2",
		status: 200,
		timedOut: false,
		requestedAt: close + 2,
		receivedAt: close + 100,
		cacheStatus: "UNCACHED",
		requiredBaseQuantity: 1,
		product: {
			id: "BTC-USD",
			base_increment: "0.0001",
			quote_increment: "0.01",
			base_min_size: "0.001",
			min_market_funds: "1",
		},
		rawBody: JSON.stringify({
			sequence: "9007199254740993",
			auction_mode: false,
			time: new Date(close + 50).toISOString(),
			bids: [["99", "2", 3]],
			asks: [["101", "2", 3]],
		}),
	};
	try {
		for (const [cacheStatus, expected] of [
			["UNCACHED", true],
			["UNKNOWN", false],
		]) {
			const response = await runtime.dispatchFetch("https://fixture/", {
				method: "POST",
				body: JSON.stringify({ ...fixture, cacheStatus }),
			});
			const result = await response.json();
			assert.equal(result.qualified, expected);
			assert.equal(result.book.sequence, "9007199254740993");
			assert.match(result.bodySha256, /^[a-f0-9]{64}$/);
		}
		assert.equal(calls, 0);
	} finally {
		await runtime.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});
